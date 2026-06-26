import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizedJobFromStoredRecord } from './stored-job-adapter.js';

test('adapts a stored DynamoDB job to the normalized matching contract', () => {
  const job = normalizedJobFromStoredRecord({
    jobKey: 'greenhouse#123',
    provider: 'greenhouse',
    providerJobId: '123',
    sourceIds: new Set(['example-greenhouse']),
    canonicalUrl: 'https://example.com/jobs/123',
    canonicalUrlHash: 'b'.repeat(64),
    company: 'Example',
    title: 'Engineer',
    description: '',
    locations: ['Remote'],
    workMode: 'remote',
    compensation: null,
    postedAt: null,
    firstSeenAt: '2026-06-19T15:00:00.000Z',
    lastSeenAt: '2026-06-19T15:00:00.000Z',
    lastVerifiedAt: null,
    status: 'active',
    contentHash: 'a'.repeat(64)
  });

  assert.equal(job.sourceId, 'example-greenhouse');
  assert.equal(job.compensation, undefined);
  assert.equal(job.postedAt, undefined);
  assert.equal(job.lastVerifiedAt, undefined);
});

test('rejects a stored job without any source identifier', () => {
  assert.throws(() => normalizedJobFromStoredRecord({
    provider: 'greenhouse',
    providerJobId: '123'
  }));
});
