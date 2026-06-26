import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createHttpClient } from '@career-ops/job-sources';
import { parseScanTask, type ScanResult } from '@career-ops/shared-types';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { ScanRepository } from './repository.js';
import { processScanTask } from './scan-service.js';

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true }
});
const repository = new ScanRepository(documentClient, {
  sourcesTable: requiredEnv('SOURCES_TABLE'),
  jobsTable: requiredEnv('JOBS_TABLE'),
  scanRunsTable: requiredEnv('SCAN_RUNS_TABLE')
});

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      const task = parseScanTask(JSON.parse(record.body));
      await processScanTask(task, {
        repository,
        providerContext: { http: createHttpClient() },
        log: (entry) => console.log(JSON.stringify(entry)),
        emitMetrics
      });
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'sqs_record_failed',
        messageId: record.messageId,
        error: error instanceof Error ? error.message : String(error)
      }));
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

function emitMetrics(result: ScanResult, durationMs: number, failed: boolean): void {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'CareerOps/Scanner',
        Dimensions: [[]],
        Metrics: [
          { Name: 'Scans', Unit: 'Count' },
          { Name: 'JobsInserted', Unit: 'Count' },
          { Name: 'JobsUpdated', Unit: 'Count' },
          { Name: 'ScanFailures', Unit: 'Count' },
          { Name: 'ScanDuration', Unit: 'Milliseconds' }
        ]
      }]
    },
    Scans: 1,
    JobsInserted: result.inserted,
    JobsUpdated: result.updated,
    ScanFailures: failed ? 1 : 0,
    ScanDuration: durationMs
  }));
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
