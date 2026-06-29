import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseNormalizedJob,
  parseUserMatchingProfile,
  type EnrichmentOutput,
  type EnrichmentTask,
  type Recommendation,
  type UserMatchingProfile
} from '@career-ops/shared-types';
import { matchJob, type MatchingRepositoryPort } from './matching-service.js';

const now = new Date('2026-06-19T12:00:00Z');
const job = parseNormalizedJob({
  provider: 'greenhouse',
  providerJobId: '1',
  sourceId: 'acme-greenhouse',
  canonicalUrl: 'https://example.com/jobs/1',
  company: 'Acme',
  title: 'AI Product Manager',
  description: 'Lead AI product discovery, roadmap, analytics, and delivery.',
  locations: ['Remote'],
  workMode: 'remote',
  compensation: { currency: 'USD', min: 180000, interval: 'year' },
  postedAt: '2026-06-18T12:00:00Z',
  firstSeenAt: '2026-06-18T12:00:00Z',
  lastSeenAt: '2026-06-19T12:00:00Z',
  status: 'active',
  contentHash: 'a'.repeat(64)
});

class FakeRepository implements MatchingRepositoryPort {
  profiles: UserMatchingProfile[] = [profile('user-1'), profile('user-2')];
  recommendations: Recommendation[] = [];
  cache: EnrichmentOutput | null = null;
  reservation: 'reserved' | 'existing' | 'exhausted' = 'reserved';
  applied = 0;
  pending = 0;

  async listActiveProfiles() { return this.profiles; }
  async putRecommendation(recommendation: Recommendation) {
    this.recommendations.push(recommendation);
    return recommendation;
  }
  async getEnrichment() { return this.cache; }
  async applyEnrichment() { this.applied += 1; }
  async markEnrichmentPending() { this.pending += 1; }
  async reserveDailyEnrichment() { return this.reservation; }
}

test('matching persists one recommendation per active profile and queues strong matches', async () => {
  const repository = new FakeRepository();
  const tasks: EnrichmentTask[] = [];
  const result = await matchJob(job, {
    repository,
    correlationId: 'stream-event-1',
    now: () => now,
    enqueueEnrichment: async (task) => { tasks.push(task); }
  });
  assert.equal(result.matched, 2);
  assert.equal(result.enrichmentQueued, 2);
  assert.equal(repository.recommendations.length, 2);
  assert.equal(tasks[0]?.cacheKey, `${job.contentHash}#user-1#1`);
  assert.equal(repository.pending, 2);
});

test('cached enrichment bypasses daily budget and queue', async () => {
  const repository = new FakeRepository();
  repository.cache = {
    strongMatches: ['Cached reason'],
    concerns: [],
    applicationAngles: []
  };
  let queued = 0;
  const result = await matchJob(job, {
    repository,
    correlationId: 'stream-event-2',
    now: () => now,
    enqueueEnrichment: async () => { queued += 1; }
  });
  assert.equal(result.enrichmentCached, 2);
  assert.equal(repository.applied, 2);
  assert.equal(queued, 0);
});

test('daily budget exhaustion preserves deterministic recommendations without queueing', async () => {
  const repository = new FakeRepository();
  repository.reservation = 'exhausted';
  let queued = 0;
  const result = await matchJob(job, {
    repository,
    correlationId: 'stream-event-3',
    now: () => now,
    enqueueEnrichment: async () => { queued += 1; }
  });
  assert.equal(result.matched, 2);
  assert.equal(result.enrichmentQueued, 0);
  assert.equal(queued, 0);
  assert.equal(repository.pending, 0);
  assert.ok(repository.recommendations.every((item) => item.strongMatches.length > 0));
});

test('an existing reservation can re-enqueue safely after a stream retry', async () => {
  const repository = new FakeRepository();
  repository.profiles = [profile('user-1')];
  repository.reservation = 'existing';
  let queued = 0;
  const result = await matchJob(job, {
    repository,
    correlationId: 'stream-retry',
    now: () => now,
    enqueueEnrichment: async () => { queued += 1; }
  });
  assert.equal(result.enrichmentQueued, 1);
  assert.equal(queued, 1);
});

test('enrichment threshold is configurable without changing deterministic ranking', async () => {
  const repository = new FakeRepository();
  repository.profiles = [profile('user-1')];
  let queued = 0;
  await matchJob(job, {
    repository,
    correlationId: 'threshold-test',
    enrichmentScoreThreshold: 101,
    now: () => now,
    enqueueEnrichment: async () => { queued += 1; }
  });
  assert.equal(repository.recommendations.length, 1);
  assert.equal(queued, 0);
});

function profile(userId: string): UserMatchingProfile {
  return parseUserMatchingProfile({
    userId,
    profileVersion: 1,
    targetRoles: ['AI Product Manager'],
    skills: ['AI', 'product discovery', 'analytics', 'roadmap'],
    evidenceKeywords: ['delivery'],
    careerGoals: ['lead AI product delivery'],
    targetLocations: ['Remote'],
    authorizedLocations: ['United States'],
    acceptedWorkModes: ['remote'],
    acceptedSeniorities: ['manager', 'unknown'],
    enrichmentDailyLimit: 5,
    updatedAt: now.toISOString()
  });
}
