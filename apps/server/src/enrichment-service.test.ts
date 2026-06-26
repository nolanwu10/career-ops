import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseEnrichmentTask,
  parseNormalizedJob,
  parseRecommendation,
  parseUserMatchingProfile,
  type EnrichmentOutput
} from '@career-ops/shared-types';
import { processEnrichmentTask, type EnrichmentRepositoryPort } from './enrichment-service.js';

const now = new Date('2026-06-19T12:00:00Z');
const job = parseNormalizedJob({
  provider: 'greenhouse',
  providerJobId: '1',
  sourceId: 'acme-greenhouse',
  canonicalUrl: 'https://example.com/jobs/1',
  company: 'Acme',
  title: 'AI Product Manager',
  description: 'Lead AI products.',
  locations: ['Remote'],
  workMode: 'remote',
  firstSeenAt: now.toISOString(),
  lastSeenAt: now.toISOString(),
  status: 'active',
  contentHash: 'a'.repeat(64)
});
const profile = parseUserMatchingProfile({
  userId: 'user-1',
  profileVersion: 2,
  targetRoles: ['AI Product Manager'],
  skills: ['AI'],
  updatedAt: now.toISOString()
});
const recommendation = parseRecommendation({
  userId: profile.userId,
  recommendationId: 'user-1#greenhouse#1',
  jobKey: 'greenhouse#1',
  profileVersion: profile.profileVersion,
  jobContentHash: job.contentHash,
  fitScore: 80,
  scoreBand: 'strong',
  scoreBreakdown: {
    skillsEvidence: 25,
    targetRole: 20,
    careerGoals: 10,
    locationWorkMode: 15,
    compensation: 5,
    feedbackAffinity: 5
  },
  eligible: true,
  strongMatches: ['Role alignment'],
  concerns: [],
  explanationStatus: 'pending',
  status: 'recommended',
  saved: false,
  hiddenByDefault: false,
  rankTieBreaker: now.getTime(),
  createdAt: now.toISOString(),
  updatedAt: now.toISOString()
});
const task = parseEnrichmentTask({
  userId: profile.userId,
  recommendationId: recommendation.recommendationId,
  jobKey: recommendation.jobKey,
  profileVersion: profile.profileVersion,
  jobContentHash: job.contentHash,
  cacheKey: `${job.contentHash}#${profile.userId}#${profile.profileVersion}`,
  correlationId: 'correlation-1'
});

class FakeRepository implements EnrichmentRepositoryPort {
  cached: EnrichmentOutput | null = null;
  currentJob = job;
  currentProfile = profile;
  currentRecommendation = recommendation;
  applied = 0;
  stored = 0;
  failed = 0;

  async getJob() { return this.currentJob; }
  async getRecommendation() { return this.currentRecommendation; }
  async getProfile() { return this.currentProfile; }
  async getEnrichment() { return this.cached; }
  async putEnrichment() { this.stored += 1; }
  async applyEnrichment() { this.applied += 1; }
  async markEnrichmentFailed() { this.failed += 1; }
}

test('enrichment uses cache when available', async () => {
  const repository = new FakeRepository();
  repository.cached = { strongMatches: ['Cached'], concerns: [], applicationAngles: [] };
  let calls = 0;
  const disposition = await processEnrichmentTask(task, {
    repository,
    enricher: { enrich: async () => { calls += 1; return repository.cached!; } },
    now: () => now
  });
  assert.equal(disposition, 'cached');
  assert.equal(calls, 0);
  assert.equal(repository.applied, 1);
});

test('enrichment stores and applies validated model output', async () => {
  const repository = new FakeRepository();
  const disposition = await processEnrichmentTask(task, {
    repository,
    enricher: {
      enrich: async () => ({
        strongMatches: ['Strong role alignment'],
        concerns: ['Confirm scope'],
        applicationAngles: ['Lead with AI delivery evidence']
      })
    },
    now: () => now
  });
  assert.equal(disposition, 'enriched');
  assert.equal(repository.stored, 1);
  assert.equal(repository.applied, 1);
});

test('stale content or profile versions are ignored', async () => {
  const repository = new FakeRepository();
  repository.currentJob = { ...job, contentHash: 'b'.repeat(64) };
  const disposition = await processEnrichmentTask(task, {
    repository,
    enricher: { enrich: async () => { throw new Error('should not run'); } },
    now: () => now
  });
  assert.equal(disposition, 'stale');
});

test('model failure marks enrichment failed while deterministic text remains stored', async () => {
  const repository = new FakeRepository();
  await assert.rejects(() => processEnrichmentTask(task, {
    repository,
    enricher: { enrich: async () => { throw new Error('model unavailable'); } },
    now: () => now
  }), /model unavailable/);
  assert.equal(repository.failed, 1);
});
