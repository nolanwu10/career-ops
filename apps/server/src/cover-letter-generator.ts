import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { createRemoteJWKSet } from 'jose/jwks/remote';
import { jwtVerify } from 'jose/jwt/verify';
import OpenAI from 'openai';

// awslambda is a Node.js Lambda runtime global — available at runtime, not compile time.
// When invoked via Function URL with InvokeMode.RESPONSE_STREAM, the runtime calls the
// streamifyResponse-wrapped handler and provides a writable responseStream.
// When invoked via API Gateway (non-streaming), the runtime buffers everything written
// to the stream and returns it as a standard response.
declare const awslambda: {
  streamifyResponse(
    handler: (event: LambdaEvent, responseStream: NodeJS.WritableStream) => Promise<void>
  ): unknown;
  HttpResponseStream: {
    from(
      stream: NodeJS.WritableStream,
      meta: { statusCode: number; headers: Record<string, string> }
    ): NodeJS.WritableStream;
  };
};

// Minimal event shape covering both API Gateway JWT authorizer and Function URL invocations
interface LambdaEvent {
  routeKey?: string;
  body?: string;
  pathParameters?: Record<string, string>;
  headers?: Record<string, string>;
  rawPath?: string;
  requestContext?: {
    authorizer?: { jwt?: { claims?: { sub?: unknown } } };
  };
}

interface CognitoJwtPayload {
  aud?: string | string[];
  client_id?: string;
  sub?: string;
}

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true }
});
const secrets = new SecretsManagerClient({});

const tables = {
  profiles:     requiredEnv('PROFILES_TABLE'),
  applications: requiredEnv('APPLICATIONS_TABLE'),
  aiBudgets:    requiredEnv('AI_BUDGETS_TABLE')
};
const openAiSecretArn = requiredEnv('OPENAI_SECRET_ARN');
const cognitoUserPoolId = requiredEnv('COGNITO_USER_POOL_ID');
const cognitoAppClientId = requiredEnv('COGNITO_APP_CLIENT_ID');
const cognitoIssuer = `https://cognito-idp.${process.env.AWS_REGION}.amazonaws.com/${cognitoUserPoolId}`;
const jwks = createRemoteJWKSet(new URL(`${cognitoIssuer}/.well-known/jwks.json`));

const DAILY_LIMIT = 5;
const OPERATION = 'cover_letter';

let openAiClient: OpenAI | undefined;

async function getOpenAi(): Promise<OpenAI> {
  if (openAiClient) return openAiClient;
  const r = await secrets.send(new GetSecretValueCommand({ SecretId: openAiSecretArn }));
  openAiClient = new OpenAI({ apiKey: r.SecretString! });
  return openAiClient;
}

// ─── Validate phase (runs before the response stream is opened) ───────────────

type ValidateError = { error: string; statusCode: number };
type ValidateOk = {
  userId: string;
  operationDate: string;
  profile: Record<string, unknown>;
  jobDescription: string;
};

async function validate(event: LambdaEvent): Promise<ValidateError | ValidateOk> {
  const userId = resolveUserId(event) ?? await verifyBearerToken(event);
  if (!userId) return { statusCode: 401, error: 'Unauthorized' };

  const body = parseBody(event.body);
  const isOnboarding = event.routeKey === 'POST /v1/onboarding/cover-letter/preview'
    || event.rawPath === '/v1/onboarding/cover-letter/preview'
    || body.preview === true
    || body.mode === 'preview';

  const today = todayUtc();
  const operationDate = `${OPERATION}#${today}`;
  const resetsAt = nextMidnightUtc(today);

  try {
    await dynamo.send(new UpdateCommand({
      TableName: tables.aiBudgets,
      Key: { userId, operationDate },
      UpdateExpression:
        'SET #c = if_not_exists(#c, :zero) + :one, expiresAt = if_not_exists(expiresAt, :exp)',
      ConditionExpression: 'attribute_not_exists(#c) OR #c < :limit',
      ExpressionAttributeNames: { '#c': 'count' },
      ExpressionAttributeValues: {
        ':zero': 0,
        ':one': 1,
        ':limit': DAILY_LIMIT,
        ':exp': Math.floor(new Date(resetsAt).getTime() / 1000)
      }
    }));
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return { statusCode: 429, error: JSON.stringify({ error: 'daily_limit_reached', operation: OPERATION, resetsAt }) };
    }
    throw err;
  }

  const profileItem = await dynamo.send(new GetCommand({ TableName: tables.profiles, Key: { userId } }));
  if (!profileItem.Item) {
    await decrementBudget(userId, operationDate);
    return { statusCode: 404, error: 'Profile not found. Complete onboarding first.' };
  }
  const profile = profileItem.Item as Record<string, unknown>;

  let jobDescription: string;
  if (isOnboarding) {
    jobDescription = SAMPLE_JOB_DESCRIPTION;
  } else {
    const applicationId = event.pathParameters?.id || String(body.applicationId ?? '');
    if (!applicationId) {
      await decrementBudget(userId, operationDate);
      return { statusCode: 400, error: 'Missing application id' };
    }
    const appItem = await dynamo.send(new GetCommand({
      TableName: tables.applications,
      Key: { userId, applicationId }
    }));
    if (!appItem.Item) {
      await decrementBudget(userId, operationDate);
      return { statusCode: 404, error: 'Application not found' };
    }
    jobDescription = String(appItem.Item.jobDescription ?? appItem.Item.notes ?? '');
    if (!jobDescription.trim()) {
      await decrementBudget(userId, operationDate);
      return { statusCode: 400, error: 'Application has no job description' };
    }
  }

  return { userId, operationDate, profile, jobDescription };
}

// ─── Exported handler (streaming + non-streaming via awslambda.streamifyResponse) ──

export const handler = awslambda.streamifyResponse(
  async (event: LambdaEvent, responseStream: NodeJS.WritableStream): Promise<void> => {
    try {
      // Run budget check + profile/app fetch before opening the stream.
      // generate() is split into two phases:
      //   1. validate() — all DynamoDB reads and budget enforcement, returns context or error
      //   2. stream() — opens the HTTP stream, then calls OpenAI
      // This lets us send a proper error status code before any bytes are written.
      const ctx = await validate(event);
      if ('error' in ctx) {
        const errStream = awslambda.HttpResponseStream.from(responseStream, {
          statusCode: ctx.statusCode,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
        });
        errStream.write(JSON.stringify({ error: ctx.error }));
        errStream.end();
        return;
      }

      // Open the response stream now — status code is committed, tokens flow from here
      const out = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-cache',
          'x-accel-buffering': 'no' // disable nginx/ALB buffering if present
        }
      });

      try {
        const ai = await getOpenAi();
        const stream = await ai.chat.completions.create({
          model: 'gpt-5.4',
          stream: true,
          temperature: 0.7,
          max_tokens: 800,
          messages: [
            { role: 'system', content: COVER_LETTER_SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(ctx.profile, ctx.jobDescription) }
          ]
        });
        for await (const chunk of stream) {
          const token = chunk.choices[0]?.delta?.content ?? '';
          if (token) out.write(token);
        }
      } catch (aiErr) {
        await decrementBudget(ctx.userId, ctx.operationDate);
        out.write('\n\n[generation failed]');
      }
      out.end();
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'cover_letter_error', error: String(error) }));
      const errStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 500,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
      });
      errStream.write(JSON.stringify({ error: 'Internal server error' }));
      errStream.end();
    }
  }
) as (event: LambdaEvent) => Promise<APIGatewayProxyStructuredResultV2>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveUserId(event: LambdaEvent): string | null {
  // API Gateway path — JWT already verified by the authorizer
  const sub = event.requestContext?.authorizer?.jwt?.claims?.sub;
  if (typeof sub === 'string' && sub) return sub;

  return null;
}

async function verifyBearerToken(event: LambdaEvent): Promise<string | null> {
  const authHeader = event.headers?.authorization ?? event.headers?.Authorization ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return null;

  try {
    const verified = await jwtVerify(token, jwks, { issuer: cognitoIssuer });
    if (!isExpectedClient(verified.payload)) return null;
    const userId = verified.payload.sub;
    return typeof userId === 'string' && userId ? userId : null;
  } catch {
    return null;
  }
}

function isExpectedClient(payload: CognitoJwtPayload): boolean {
  const audience = payload.aud;
  if (typeof audience === 'string' && audience === cognitoAppClientId) return true;
  if (Array.isArray(audience) && audience.includes(cognitoAppClientId)) return true;
  return payload.client_id === cognitoAppClientId;
}

async function decrementBudget(userId: string, operationDate: string): Promise<void> {
  try {
    await dynamo.send(new UpdateCommand({
      TableName: tables.aiBudgets,
      Key: { userId, operationDate },
      UpdateExpression: 'SET #c = #c - :one',
      ConditionExpression: '#c > :zero',
      ExpressionAttributeNames: { '#c': 'count' },
      ExpressionAttributeValues: { ':one': 1, ':zero': 0 }
    }));
  } catch { /* best-effort */ }
}

function buildUserPrompt(
  profile: Record<string, unknown>,
  jobDescription: string
): string {
  const name       = String(profile.name       ?? '');
  const headline   = String(profile.headline   ?? profile.currentTitle ?? '');
  const resumeText = String(profile.resumeText ?? '').slice(0, 3000);
  const skills     = Array.isArray(profile.skills)
    ? (profile.skills as string[]).join(', ')
    : '';

  return [
    `Candidate: ${name}`,
    headline  ? `Role: ${headline}` : '',
    skills    ? `Key skills: ${skills}` : '',
    resumeText ? `Resume excerpt:\n${resumeText}` : '',
    '',
    `Job description:\n${jobDescription.slice(0, 3000)}`
  ].filter(Boolean).join('\n');
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function nextMidnightUtc(today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function parseBody(raw?: string): Record<string, unknown> {
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

const COVER_LETTER_SYSTEM_PROMPT = `You are an expert cover letter writer. Write a compelling, personalised cover letter based on the candidate's background and the job description provided.

Rules:
- 3 paragraphs, under 300 words total
- Opening: hook with the candidate's strongest relevant achievement or angle
- Middle: 2–3 specific skills or experiences that directly match the job
- Closing: confident call-to-action, no clichés ("I am excited to…" is a cliché)
- Use the candidate's name naturally
- Do NOT repeat the job description back verbatim
- Do NOT use the phrase "I am writing to express my interest"
- Output only the letter body — no subject line, no date, no addresses`;

// Hardcoded server-side — never exposed to the client (per plan §3d)
const SAMPLE_JOB_DESCRIPTION = `Senior Software Engineer — Product Platform
We're a fast-growing B2B SaaS company looking for a senior engineer to join our product platform team.

You will:
- Design and build scalable APIs serving 10M+ requests per day
- Lead technical design reviews and mentor junior engineers
- Work closely with product and data teams to ship new features end-to-end
- Drive reliability improvements across our distributed microservices

We're looking for:
- 5+ years of professional software engineering experience
- Strong proficiency in TypeScript / Node.js and cloud infrastructure (AWS preferred)
- Track record of leading cross-functional technical projects
- Excellent written and verbal communication

Nice to have: experience with DynamoDB, Lambda, or event-driven architectures.

We offer competitive compensation, flexible remote work, and equity.`;
