import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JobSourceSchema,
  NormalizedJobSchema,
  parseJobSource,
  parseScanTask,
  parseUserMatchingProfile
} from './index.js';

test('parseJobSource applies operational defaults', () => {
  const source = parseJobSource({
    sourceId: 'acme-greenhouse',
    provider: 'greenhouse',
    company: 'Acme',
    boardUrl: 'https://job-boards.greenhouse.io/acme',
    boardIdentifier: 'acme',
    cadenceMinutes: 15
  });
  assert.equal(source.priority, 'normal');
  assert.equal(source.health, 'healthy');
  assert.equal(source.consecutiveFailures, 0);
});

test('parseScanTask rejects malformed messages', () => {
  assert.throws(() => parseScanTask({
    sourceId: 'acme-greenhouse',
    provider: 'unknown',
    scheduledAt: 'not-a-date',
    correlationId: 'bad value!'
  }));
});

test('normalized job requires a stable id and content hash', () => {
  const result = NormalizedJobSchema.safeParse({
    provider: 'greenhouse',
    providerJobId: '',
    sourceId: 'acme-greenhouse',
    canonicalUrl: 'https://example.com/job/1',
    company: 'Acme',
    title: 'Engineer',
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    contentHash: 'bad'
  });
  assert.equal(result.success, false);
});

test('compensation minimum cannot exceed maximum', () => {
  const result = JobSourceSchema.safeParse({
    sourceId: 'acme-greenhouse',
    provider: 'greenhouse',
    company: 'Acme',
    boardUrl: 'https://job-boards.greenhouse.io/acme',
    boardIdentifier: 'acme',
    cadenceMinutes: 15
  });
  assert.equal(result.success, true);

  const job = NormalizedJobSchema.safeParse({
    provider: 'greenhouse',
    providerJobId: '1',
    sourceId: 'acme-greenhouse',
    canonicalUrl: 'https://example.com/job/1',
    company: 'Acme',
    title: 'Engineer',
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    contentHash: 'a'.repeat(64),
    compensation: { currency: 'USD', min: 200, max: 100 }
  });
  assert.equal(job.success, false);
});

test('matching profile applies safe feedback and enrichment defaults', () => {
  const profile = parseUserMatchingProfile({
    userId: 'user-1',
    profileVersion: 1,
    targetRoles: ['Product Manager'],
    updatedAt: new Date().toISOString()
  });
  assert.deepEqual(profile.feedbackAffinity.roles, {});
  assert.equal(profile.enrichmentDailyLimit, 10);
  assert.ok(profile.acceptedWorkModes.includes('remote'));
});
