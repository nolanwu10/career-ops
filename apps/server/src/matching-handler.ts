import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from 'aws-lambda';
import { MatchingRepository } from './matching-repository.js';
import { matchJob } from './matching-service.js';
import { normalizedJobFromStoredRecord } from './stored-job-adapter.js';

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true }
});
const sqs = new SQSClient({});
const repository = new MatchingRepository(documentClient, {
  jobsTable: requiredEnv('JOBS_TABLE'),
  profilesTable: requiredEnv('PROFILES_TABLE'),
  recommendationsTable: requiredEnv('RECOMMENDATIONS_TABLE'),
  enrichmentCacheTable: requiredEnv('ENRICHMENT_CACHE_TABLE'),
  enrichmentBudgetsTable: requiredEnv('ENRICHMENT_BUDGETS_TABLE')
});
const enrichmentQueueUrl = requiredEnv('ENRICHMENT_QUEUE_URL');

export async function handler(event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> {
  const batchItemFailures: DynamoDBBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      if (!record.dynamodb?.NewImage) continue;
      const current = unmarshall(record.dynamodb.NewImage as Parameters<typeof unmarshall>[0]);
      const previous = record.dynamodb.OldImage
        ? unmarshall(record.dynamodb.OldImage as Parameters<typeof unmarshall>[0])
        : undefined;
      if (previous?.contentHash === current.contentHash) continue;
      const job = normalizedJobFromStoredRecord(current);
      const result = await matchJob(job, {
        repository,
        correlationId: record.eventID || `${job.provider}#${job.providerJobId}`,
        enrichmentScoreThreshold: Number(process.env.ENRICHMENT_SCORE_THRESHOLD || 60),
        enqueueEnrichment: async (task) => {
          await sqs.send(new SendMessageCommand({
            QueueUrl: enrichmentQueueUrl,
            MessageBody: JSON.stringify(task)
          }));
        }
      });
      console.log(JSON.stringify({
        level: 'info',
        event: 'job_matched',
        jobKey: current.jobKey,
        ...result
      }));
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'job_match_failed',
        eventId: record.eventID,
        error: error instanceof Error ? error.message : String(error)
      }));
      if (record.eventID) batchItemFailures.push({ itemIdentifier: record.eventID });
    }
  }
  return { batchItemFailures };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
