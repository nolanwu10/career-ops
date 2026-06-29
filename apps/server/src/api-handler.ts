import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { AdminDeleteUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand
} from '@aws-sdk/lib-dynamodb';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { UserMatchingProfileSchema, parseUserMatchingProfile } from '@career-ops/shared-types';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2
} from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import {
  deduplicateSourceJobs,
  fetchDiscoverySource,
  mergeImportedJobs,
  parseDiscoverySource,
  portalFromUrl,
  sanitizeDiscoveryJobs,
  sanitizeDiscoverySources,
  upsertDiscoverySource
} from './discovery-import.js';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true }
});
const s3 = new S3Client({});
const cognito = new CognitoIdentityProviderClient({});

const tables = {
  profiles: requiredEnv('PROFILES_TABLE'),
  onboardingStates: requiredEnv('ONBOARDING_STATES_TABLE'),
  applications: requiredEnv('APPLICATIONS_TABLE'),
  resumeVariants: requiredEnv('RESUME_VARIANTS_TABLE'),
  knowledge: requiredEnv('KNOWLEDGE_TABLE'),
  aiBudgets: requiredEnv('AI_BUDGETS_TABLE')
};
const userFilesBucket = requiredEnv('USER_FILES_BUCKET');
const cognitoUserPoolId = requiredEnv('COGNITO_USER_POOL_ID');

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const claims = event.requestContext.authorizer.jwt.claims;
    const userId = claims.sub;
    const cognitoUsername = claims['cognito:username'];
    if (typeof userId !== 'string' || !userId) return response(401, { error: 'Unauthorized' });

    const route = event.routeKey;

    // ─── Profile ──────────────────────────────────────────────────────────────

    if (route === 'GET /v1/profile') {
      const item = await dynamo.send(new GetCommand({ TableName: tables.profiles, Key: { userId } }));
      return item.Item
        ? response(200, withDiscoveryState(parseUserMatchingProfile(item.Item), item.Item))
        : response(404, { error: 'Profile not found' });
    }

    if (route === 'PUT /v1/profile') {
      const body = parseBody(event.body);
      const existing = await dynamo.send(new GetCommand({ TableName: tables.profiles, Key: { userId } }));
      const currentVersion = Number(existing.Item?.profileVersion || 0);
      const profile = UserMatchingProfileSchema.parse({
        ...(existing.Item || {}),
        ...body,
        userId,
        profileVersion: currentVersion + 1,
        updatedAt: new Date().toISOString()
      });
      const nextItem = withDiscoveryState(profile, existing.Item);
      await dynamo.send(new PutCommand({ TableName: tables.profiles, Item: nextItem }));
      return response(200, nextItem);
    }

    // ─── Onboarding ───────────────────────────────────────────────────────────

    if (route === 'GET /v1/onboarding/resume/upload-url') {
      const ext = String(event.queryStringParameters?.ext || 'pdf').replace(/[^a-z]/g, '');
      const fileId = randomUUID();
      const key = `users/${userId}/resumes/${fileId}.${ext}`;
      const url = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: userFilesBucket, Key: key }),
        { expiresIn: 300 }
      );
      return response(200, { url, key });
    }

    if (route === 'GET /v1/onboarding/state') {
      const item = await dynamo.send(new GetCommand({
        TableName: tables.onboardingStates,
        Key: { userId }
      }));
      return response(200, item.Item ?? defaultOnboardingState());
    }

    if (route === 'PUT /v1/onboarding/state') {
      const body = parseBody(event.body);
      const currentStep = String(body.currentStep ?? '').trim() || 'welcome';
      const completedAt = body.completedAt ? String(body.completedAt) : null;
      const item = {
        userId,
        currentStep,
        completedAt,
        updatedAt: new Date().toISOString()
      };
      await dynamo.send(new PutCommand({ TableName: tables.onboardingStates, Item: item }));
      return response(200, item);
    }

    if (route === 'POST /v1/onboarding/profile') {
      const body = parseBody(event.body);
      const existing = await dynamo.send(new GetCommand({ TableName: tables.profiles, Key: { userId } }));
      const profile = UserMatchingProfileSchema.parse({
        ...(existing.Item || {}),
        ...body,
        userId,
        profileVersion: Number(existing.Item?.profileVersion || 0) + 1,
        updatedAt: new Date().toISOString()
      });
      const nextItem = withDiscoveryState(profile, existing.Item);
      await dynamo.send(new PutCommand({ TableName: tables.profiles, Item: nextItem }));
      return response(200, nextItem);
    }

    // ─── Applications ─────────────────────────────────────────────────────────

    if (route === 'GET /v1/applications') {
      const result = await dynamo.send(new QueryCommand({
        TableName: tables.applications,
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId }
      }));
      return response(200, { items: result.Items || [] });
    }

    if (route === 'POST /v1/applications') {
      const body = parseBody(event.body);
      const applicationId = randomUUID();
      const item = { ...body, userId, applicationId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await dynamo.send(new PutCommand({ TableName: tables.applications, Item: item }));
      return response(201, item);
    }

    if (route === 'PATCH /v1/applications/{id}') {
      const applicationId = event.pathParameters?.id;
      if (!applicationId) return response(400, { error: 'Missing id' });
      const body = parseBody(event.body);
      const updates = Object.fromEntries(
        Object.entries(body).filter(([, value]) => value !== undefined)
      );
      if (Object.keys(updates).length === 0) {
        return response(400, { error: 'No fields to update' });
      }

      const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
      const values: Record<string, unknown> = { ':updatedAt': new Date().toISOString() };
      const sets = ['#updatedAt = :updatedAt'];
      let index = 0;
      for (const [key, value] of Object.entries(updates)) {
        const nameKey = `#f${index}`;
        const valueKey = `:v${index}`;
        names[nameKey] = key;
        values[valueKey] = value;
        sets.push(`${nameKey} = ${valueKey}`);
        index += 1;
      }

      const result = await dynamo.send(new UpdateCommand({
        TableName: tables.applications,
        Key: { userId, applicationId },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: 'attribute_exists(userId) AND attribute_exists(applicationId)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW'
      }));
      return response(200, result.Attributes ?? null);
    }

    if (route === 'DELETE /v1/applications/{id}') {
      const applicationId = event.pathParameters?.id;
      if (!applicationId) return response(400, { error: 'Missing id' });
      await dynamo.send(new DeleteCommand({ TableName: tables.applications, Key: { userId, applicationId } }));
      return response(204, null);
    }

    // ─── Resume variants ──────────────────────────────────────────────────────

    if (route === 'GET /v1/resume-variants') {
      const result = await dynamo.send(new QueryCommand({
        TableName: tables.resumeVariants,
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId }
      }));
      return response(200, { items: result.Items || [] });
    }

    if (route === 'POST /v1/resume-variants') {
      const body = parseBody(event.body);
      const variantId = randomUUID();
      const item = {
        userId,
        variantId,
        name: String(body.name ?? '').trim() || 'Untitled variant',
        baseResumeId: body.baseResumeId ?? null,
        status: body.status ?? 'draft',
        isPrimary: Boolean(body.isPrimary),
        content: body.content ?? '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await dynamo.send(new PutCommand({ TableName: tables.resumeVariants, Item: item }));
      return response(201, item);
    }

    if (route === 'DELETE /v1/resume-variants/{id}') {
      const variantId = event.pathParameters?.id;
      if (!variantId) return response(400, { error: 'Missing id' });
      await dynamo.send(new DeleteCommand({ TableName: tables.resumeVariants, Key: { userId, variantId } }));
      return response(204, null);
    }

    // ─── Discovery ────────────────────────────────────────────────────────────

    if (route === 'POST /v1/discovery/import') {
      const body = parseBody(event.body);
      const sourceUrl = String(body.url ?? '').trim();
      if (!sourceUrl) return response(400, { error: 'Missing url' });

      const existingProfile = await dynamo.send(new GetCommand({ TableName: tables.profiles, Key: { userId } }));
      if (!existingProfile.Item) return response(404, { error: 'Profile not found' });

      const source = await fetchDiscoverySource(sourceUrl);
      const extracted = parseDiscoverySource(source);
      if (extracted.length === 0) {
        return response(400, {
          error: 'No job listings were found. Use a public GitHub repository, Google Sheet, or webpage with job links.'
        });
      }

      const jobs = deduplicateSourceJobs(extracted).slice(0, 1000).map((job) => ({
        ...job,
        portal: portalFromUrl(job.url),
        sourceLabel: source.label,
        importedAt: new Date().toISOString()
      }));
      const currentPendingJobs = sanitizeDiscoveryJobs(existingProfile.Item.pendingJobs);
      const currentSources = sanitizeDiscoverySources(existingProfile.Item.discoverySources);
      const applications = await dynamo.send(new QueryCommand({
        TableName: tables.applications,
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId },
        ProjectionExpression: 'url'
      }));
      const trackedUrls = (applications.Items || [])
        .map((item) => typeof item.url === 'string' ? item.url : '')
        .filter(Boolean);
      const merged = mergeImportedJobs(currentPendingJobs, jobs, trackedUrls);

      const nextSources = body.saveSource === false
        ? currentSources
        : upsertDiscoverySource(currentSources, {
            url: source.sourceUrl,
            label: source.label,
            sourceType: source.type,
            lastRefreshedAt: new Date().toISOString(),
            lastError: ''
          });

      await dynamo.send(new UpdateCommand({
        TableName: tables.profiles,
        Key: { userId },
        ConditionExpression: 'attribute_exists(userId)',
        UpdateExpression: 'SET pendingJobs = :pendingJobs, discoverySources = :discoverySources',
        ExpressionAttributeValues: {
          ':pendingJobs': merged.jobs,
          ':discoverySources': nextSources
        }
      }));

      return response(200, {
        ok: true,
        sourceType: source.type,
        extracted: extracted.length,
        unique: jobs.length,
        added: merged.added,
        duplicates: jobs.length - merged.added,
        recorded: merged.added,
        pendingJobs: merged.jobs,
        discoverySources: nextSources,
        message: `Imported ${merged.added} new job${merged.added === 1 ? '' : 's'} from ${source.label}.`
      });
    }

    // ─── Knowledge center ─────────────────────────────────────────────────────

    if (route === 'GET /v1/knowledge') {
      const result = await dynamo.send(new QueryCommand({
        TableName: tables.knowledge,
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId }
      }));
      return response(200, { items: result.Items || [] });
    }

    if (route === 'POST /v1/knowledge') {
      const body = parseBody(event.body);
      const factId = randomUUID();
      const item = { ...body, userId, factId, createdAt: new Date().toISOString() };
      await dynamo.send(new PutCommand({ TableName: tables.knowledge, Item: item }));
      return response(201, item);
    }

    if (route === 'DELETE /v1/knowledge/{id}') {
      const factId = event.pathParameters?.id;
      if (!factId) return response(400, { error: 'Missing id' });
      await dynamo.send(new DeleteCommand({ TableName: tables.knowledge, Key: { userId, factId } }));
      return response(204, null);
    }

    // ─── Files ────────────────────────────────────────────────────────────────

    if (route === 'GET /v1/files/upload-url') {
      const type = event.queryStringParameters?.type ?? 'knowledge';
      const ext = String(event.queryStringParameters?.ext || 'pdf').replace(/[^a-z0-9]/g, '');
      const fileId = randomUUID();
      const folder = type === 'resume' ? 'resumes' : 'files';
      const key = `users/${userId}/${folder}/${fileId}.${ext}`;
      const url = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: userFilesBucket, Key: key }),
        { expiresIn: 300 }
      );
      return response(200, { url, key });
    }

    if (route === 'GET /v1/files/download-url') {
      const key = event.queryStringParameters?.key ?? '';
      if (!key || !key.startsWith(`users/${userId}/`)) {
        return response(400, { error: 'Missing or unauthorized key' });
      }
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: userFilesBucket, Key: key }),
        { expiresIn: 900 }
      );
      return response(200, { url });
    }

    // ─── Account ──────────────────────────────────────────────────────────────

    if (route === 'DELETE /v1/account') {
      // 1. Delete all S3 objects under users/{userId}/
      let continuationToken: string | undefined;
      do {
        const listed = await s3.send(new ListObjectsV2Command({
          Bucket: userFilesBucket,
          Prefix: `users/${userId}/`,
          ContinuationToken: continuationToken
        }));
        if (listed.Contents && listed.Contents.length > 0) {
          await s3.send(new DeleteObjectsCommand({
            Bucket: userFilesBucket,
            Delete: {
              Objects: listed.Contents.map(o => ({ Key: o.Key! })),
              Quiet: true
            }
          }));
        }
        continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
      } while (continuationToken);

      // 2. Delete all DynamoDB records across every table
      const tableConfigs: Array<{ name: string; skAttr: string }> = [
        { name: tables.profiles,      skAttr: ''              }, // single-item table (PK only)
        { name: tables.onboardingStates, skAttr: ''           },
        { name: tables.applications,  skAttr: 'applicationId' },
        { name: tables.resumeVariants,skAttr: 'variantId'     },
        { name: tables.knowledge,     skAttr: 'factId'        },
        { name: tables.aiBudgets,     skAttr: 'operationDate' }
      ];

      for (const tbl of tableConfigs) {
        if (!tbl.skAttr) {
          // profiles: single item, just delete it
          await dynamo.send(new DeleteCommand({ TableName: tbl.name, Key: { userId } }));
          continue;
        }

        // Query all SK values then batch-delete in chunks of 25
        let lastKey: Record<string, unknown> | undefined;
        do {
          const result = await dynamo.send(new QueryCommand({
            TableName: tbl.name,
            KeyConditionExpression: 'userId = :uid',
            ExpressionAttributeValues: { ':uid': userId },
            ProjectionExpression: `userId, ${tbl.skAttr}`,
            ExclusiveStartKey: lastKey
          }));
          const items = result.Items ?? [];
          for (let i = 0; i < items.length; i += 25) {
            const chunk = items.slice(i, i + 25);
            await dynamo.send(new BatchWriteCommand({
              RequestItems: {
                [tbl.name]: chunk.map(item => ({
                  DeleteRequest: { Key: { userId: item.userId, [tbl.skAttr]: item[tbl.skAttr] } }
                }))
              }
            }));
          }
          lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
        } while (lastKey);
      }

      // 3. Delete the Cognito user (best-effort — user is already wiped from our data)
      try {
        await cognito.send(new AdminDeleteUserCommand({
          UserPoolId: cognitoUserPoolId,
          Username: typeof cognitoUsername === 'string' && cognitoUsername ? cognitoUsername : userId
        }));
      } catch (cognitoErr: unknown) {
        // UserNotFoundException means already deleted — that's fine
        if ((cognitoErr as { name?: string }).name !== 'UserNotFoundException') {
          console.warn(JSON.stringify({ level: 'warn', event: 'cognito_delete_failed', error: String(cognitoErr) }));
        }
      }

      return response(204, null);
    }

    return response(404, { error: 'Route not found' });
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'api_error',
      error: error instanceof Error ? error.message : String(error)
    }));
    return response(500, { error: 'Internal server error' });
  }
}

function parseBody(body?: string): Record<string, unknown> {
  return body ? JSON.parse(body) as Record<string, unknown> : {};
}

function response(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: body !== null ? JSON.stringify(body) : undefined
  };
}

function notImplemented(route: string): APIGatewayProxyStructuredResultV2 {
  return response(501, { error: 'Not implemented', route });
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function defaultOnboardingState(): Record<string, unknown> {
  return {
    currentStep: 'welcome',
    completedAt: null
  };
}

function withDiscoveryState<T extends Record<string, unknown>>(
  profile: T,
  rawProfile?: Record<string, unknown>
): T & { pendingJobs: unknown[]; discoverySources: unknown[] } {
  return {
    ...profile,
    pendingJobs: sanitizeDiscoveryJobs(rawProfile?.pendingJobs),
    discoverySources: sanitizeDiscoverySources(rawProfile?.discoverySources)
  };
}
