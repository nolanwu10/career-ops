import type { EnrichmentTask, NormalizedJob, UserMatchingProfile } from '@career-ops/shared-types';
import { rankJobForProfile } from './ranking.js';

export const ENRICHMENT_SCORE_THRESHOLD = 60;

export interface MatchingDependencies {
  repository: MatchingRepositoryPort;
  enqueueEnrichment(task: EnrichmentTask): Promise<void>;
  now?: () => Date;
  correlationId: string;
  enrichmentScoreThreshold?: number;
}

export interface MatchingRepositoryPort {
  listActiveProfiles(): Promise<UserMatchingProfile[]>;
  putRecommendation(recommendation: ReturnType<typeof rankJobForProfile>): Promise<ReturnType<typeof rankJobForProfile>>;
  getEnrichment(cacheKey: string): Promise<import('@career-ops/shared-types').EnrichmentOutput | null>;
  applyEnrichment(userId: string, recommendationId: string, output: import('@career-ops/shared-types').EnrichmentOutput, now: Date): Promise<void>;
  markEnrichmentPending(userId: string, recommendationId: string, now: Date): Promise<void>;
  reserveDailyEnrichment(
    userId: string,
    date: string,
    limit: number,
    reservationId: string
  ): Promise<'reserved' | 'existing' | 'exhausted'>;
}

export async function matchJob(job: NormalizedJob, dependencies: MatchingDependencies): Promise<{
  matched: number;
  enrichmentQueued: number;
  enrichmentCached: number;
}> {
  const now = dependencies.now?.() ?? new Date();
  const profiles = await dependencies.repository.listActiveProfiles();
  const enrichmentScoreThreshold = dependencies.enrichmentScoreThreshold
    ?? ENRICHMENT_SCORE_THRESHOLD;
  let enrichmentQueued = 0;
  let enrichmentCached = 0;
  for (const profile of profiles) {
    const recommendation = await dependencies.repository.putRecommendation(rankJobForProfile(job, profile, now));
    if (!recommendation.eligible || recommendation.fitScore < enrichmentScoreThreshold) continue;
    const cacheKey = `${job.contentHash}#${profile.userId}#${profile.profileVersion}`;
    const cached = await dependencies.repository.getEnrichment(cacheKey);
    if (cached) {
      await dependencies.repository.applyEnrichment(profile.userId, recommendation.recommendationId, cached, now);
      enrichmentCached += 1;
      continue;
    }
    const reservation = await dependencies.repository.reserveDailyEnrichment(
      profile.userId,
      now.toISOString().slice(0, 10),
      profile.enrichmentDailyLimit,
      cacheKey
    );
    if (reservation === 'exhausted') continue;
    await dependencies.repository.markEnrichmentPending(profile.userId, recommendation.recommendationId, now);
    await dependencies.enqueueEnrichment({
      userId: profile.userId,
      recommendationId: recommendation.recommendationId,
      jobKey: recommendation.jobKey,
      profileVersion: profile.profileVersion,
      jobContentHash: job.contentHash,
      cacheKey,
      correlationId: dependencies.correlationId
    });
    enrichmentQueued += 1;
  }
  return { matched: profiles.length, enrichmentQueued, enrichmentCached };
}
