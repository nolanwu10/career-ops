import { createRequire } from 'node:module';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import OpenAI from 'openai';
import mammoth from 'mammoth';

// pdf-parse is CJS with no @types — load via require
const require = createRequire(`${process.cwd()}/resume-parser.cjs`);
const pdfParse = require('pdf-parse') as (data: Buffer) => Promise<{ text: string }>;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true }
});
const s3 = new S3Client({});
const secrets = new SecretsManagerClient({});

const tables = {
  profiles: requiredEnv('PROFILES_TABLE'),
  aiBudgets: requiredEnv('AI_BUDGETS_TABLE')
};
const userFilesBucket = requiredEnv('USER_FILES_BUCKET');
const openAiSecretArn = requiredEnv('OPENAI_SECRET_ARN');

const DAILY_LIMIT = 3;
const OPERATION = 'resume_parse';

let openAiClient: OpenAI | undefined;

async function getOpenAi(): Promise<OpenAI> {
  if (openAiClient) return openAiClient;
  const r = await secrets.send(new GetSecretValueCommand({ SecretId: openAiSecretArn }));
  openAiClient = new OpenAI({ apiKey: r.SecretString! });
  return openAiClient;
}

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const userId = event.requestContext.authorizer.jwt.claims.sub;
    if (typeof userId !== 'string' || !userId) return respond(401, { error: 'Unauthorized' });

    const body = parseBody(event.body);
    const s3Key = String(body.s3Key ?? '');
    if (!s3Key || !s3Key.startsWith(`users/${userId}/resumes/`)) {
      return respond(400, { error: 'Missing or invalid s3Key' });
    }

    // Increment budget atomically — decrement on any downstream failure
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
        return respond(429, { error: 'daily_limit_reached', operation: OPERATION, resetsAt });
      }
      throw err;
    }

    // Download and extract text
    let text: string;
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: userFilesBucket, Key: s3Key }));
      const buf = await streamToBuffer(obj.Body as AsyncIterable<Uint8Array>);
      const ext = s3Key.split('.').pop()?.toLowerCase() ?? '';
      if (ext === 'pdf') {
        text = (await pdfParse(buf)).text;
      } else if (ext === 'docx' || ext === 'doc') {
        text = (await mammoth.extractRawText({ buffer: buf })).value;
      } else {
        text = buf.toString('utf8');
      }
    } catch (extractErr) {
      await decrementBudget(userId, operationDate);
      throw extractErr;
    }

    // Single OpenAI call: profile fields + role/location chips
    let parsed: ParsedResume;
    try {
      const ai = await getOpenAi();
      const completion = await ai.chat.completions.create({
        model: 'gpt-5.4-mini',
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 2000,
        messages: [
          { role: 'system', content: PARSE_SYSTEM_PROMPT },
          { role: 'user', content: `Resume text:\n\n${text.slice(0, 12000)}` }
        ]
      });
      parsed = JSON.parse(completion.choices[0]?.message.content ?? '{}') as ParsedResume;
    } catch (aiErr) {
      await decrementBudget(userId, operationDate);
      throw aiErr;
    }

    // Merge into profile — don't clobber fields the user already set explicitly
    const existing = await dynamo.send(new GetCommand({ TableName: tables.profiles, Key: { userId } }));
    const prev = existing.Item ?? {};
    const profile: Record<string, unknown> = {
      ...prev,
      userId,
      profileVersion: Number(prev.profileVersion ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      name:           prev.name           || parsed.name           || '',
      email:          prev.email          || parsed.email          || '',
      headline:       prev.headline       || parsed.headline       || '',
      currentTitle:   parsed.currentTitle || prev.currentTitle     || '',
      currentCompany: parsed.currentCompany || prev.currentCompany || '',
      seniority:      parsed.seniority    || prev.seniority        || 'mid',
      skills:         parsed.skills?.length ? parsed.skills : (prev.skills ?? []),
      // Stored for cover-letter generation — avoids re-downloading the S3 file on every generate
      resumeText: text.slice(0, 50000)
    };
    await dynamo.send(new PutCommand({ TableName: tables.profiles, Item: profile }));

    return respond(200, {
      profile,
      roleChips:     (parsed.roleChips     ?? []).slice(0, 15),
      locationChips: (parsed.locationChips ?? []).slice(0, 15)
    });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'resume_parse_error', error: String(error) }));
    return respond(500, { error: 'Internal server error' });
  }
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

async function streamToBuffer(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

interface ParsedResume {
  name?: string;
  email?: string;
  headline?: string;
  currentTitle?: string;
  currentCompany?: string;
  seniority?: string;
  skills?: string[];
  roleChips?: string[];
  locationChips?: string[];
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function nextMidnightUtc(today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

function parseBody(raw?: string): Record<string, unknown> {
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function respond(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body)
  };
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const PARSE_SYSTEM_PROMPT = `You are a resume parser. Extract structured data from the resume text and return a JSON object with exactly these fields:

- name: full name of the candidate
- email: email address (empty string if not found)
- headline: concise professional headline or most impactful one-liner summarising their background
- currentTitle: most recent job title
- currentCompany: most recent employer name
- seniority: one of "entry" | "mid" | "senior" | "staff" | "principal" | "executive" based on years of experience and scope of impact
- skills: array of up to 20 specific technical or domain skills mentioned in the resume
- roleChips: array of 10–15 job title strings the candidate could realistically target next, ordered most-to-least relevant (e.g. ["Senior Software Engineer", "Staff Engineer", "Engineering Manager"])
- locationChips: array of 5–10 city/region strings where the candidate has lived or worked; always include "Remote" if any remote work appears

Return only valid JSON. No markdown fences, no explanation, no extra keys.`;
