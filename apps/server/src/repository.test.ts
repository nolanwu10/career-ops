import assert from 'node:assert/strict';
import test from 'node:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { NormalizedJob } from '@career-ops/shared-types';
import { ScanRepository } from './repository.js';

test('job upsert preserves firstSeenAt and merges source ids atomically', async () => {
  let commandInput: Record<string, any> | undefined;
  const client = {
    async send(command: { input: Record<string, any> }) {
      commandInput = command.input;
      return { Attributes: { contentHash: 'old-hash' } };
    }
  } as unknown as DynamoDBDocumentClient;
  const repository = new ScanRepository(client, {
    sourcesTable: 'sources',
    jobsTable: 'jobs',
    scanRunsTable: 'runs'
  });
  const result = await repository.upsertJob(job());
  assert.equal(result, 'updated');
  assert.match(commandInput?.UpdateExpression, /if_not_exists\(firstSeenAt/);
  assert.match(commandInput?.UpdateExpression, /ADD sourceIds/);
  assert.equal(commandInput?.Key.jobKey, 'greenhouse#1');
});

test('job upsert classifies first writes and unchanged content', async () => {
  const responses = [{}, { Attributes: { contentHash: job().contentHash } }];
  const client = {
    async send() { return responses.shift(); }
  } as unknown as DynamoDBDocumentClient;
  const repository = new ScanRepository(client, {
    sourcesTable: 'sources',
    jobsTable: 'jobs',
    scanRunsTable: 'runs'
  });
  assert.equal(await repository.upsertJob(job()), 'inserted');
  assert.equal(await repository.upsertJob(job()), 'unchanged');
});

function job(): NormalizedJob {
  return {
    provider: 'greenhouse',
    providerJobId: '1',
    sourceId: 'acme-greenhouse',
    canonicalUrl: 'https://example.com/jobs/1',
    company: 'Acme',
    title: 'Engineer',
    description: 'Build systems',
    locations: ['Remote'],
    workMode: 'remote',
    employmentType: 'unknown',
    seniority: 'unknown',
    countries: [],
    classificationConfidence: 0,
    classificationEvidence: [],
    firstSeenAt: '2026-06-19T12:00:00.000Z',
    lastSeenAt: '2026-06-19T12:00:00.000Z',
    status: 'active',
    contentHash: 'a'.repeat(64)
  };
}
