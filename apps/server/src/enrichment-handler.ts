import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { parseEnrichmentTask } from '@career-ops/shared-types';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { BedrockRecommendationEnricher } from './bedrock-enricher.js';
import { EnrichmentRepository } from './enrichment-repository.js';
import { processEnrichmentTask } from './enrichment-service.js';

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true }
});
const repository = new EnrichmentRepository(documentClient, {
  jobsTable: requiredEnv('JOBS_TABLE'),
  profilesTable: requiredEnv('PROFILES_TABLE'),
  recommendationsTable: requiredEnv('RECOMMENDATIONS_TABLE'),
  enrichmentCacheTable: requiredEnv('ENRICHMENT_CACHE_TABLE'),
  enrichmentBudgetsTable: requiredEnv('ENRICHMENT_BUDGETS_TABLE')
});
const enricher = new BedrockRecommendationEnricher(
  new BedrockRuntimeClient({}),
  process.env.BEDROCK_MODEL_ID || 'amazon.nova-pro-v1:0'
);

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      const task = parseEnrichmentTask(JSON.parse(record.body));
      const disposition = await processEnrichmentTask(task, { repository, enricher });
      console.log(JSON.stringify({
        level: 'info',
        event: 'recommendation_enrichment_processed',
        recommendationId: task.recommendationId,
        disposition
      }));
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'recommendation_enrichment_failed',
        messageId: record.messageId,
        error: error instanceof Error ? error.message : String(error)
      }));
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
