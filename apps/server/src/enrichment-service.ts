import {
  EnrichmentOutputSchema,
  type EnrichmentOutput,
  type EnrichmentTask,
  type NormalizedJob,
  type Recommendation,
  type UserMatchingProfile
} from '@career-ops/shared-types';

export interface RecommendationEnricher {
  enrich(input: {
    job: NormalizedJob;
    profile: UserMatchingProfile;
    recommendation: Recommendation;
  }): Promise<EnrichmentOutput>;
}

export interface EnrichmentRepositoryPort {
  getJob(jobKey: string): Promise<NormalizedJob | null>;
  getRecommendation(userId: string, recommendationId: string): Promise<Recommendation | null>;
  getProfile(userId: string): Promise<UserMatchingProfile | null>;
  getEnrichment(cacheKey: string): Promise<EnrichmentOutput | null>;
  putEnrichment(cacheKey: string, output: EnrichmentOutput, now: Date): Promise<void>;
  applyEnrichment(userId: string, recommendationId: string, output: EnrichmentOutput, now: Date): Promise<void>;
  markEnrichmentFailed(userId: string, recommendationId: string, now: Date): Promise<void>;
}

export async function processEnrichmentTask(
  task: EnrichmentTask,
  dependencies: {
    repository: EnrichmentRepositoryPort;
    enricher: RecommendationEnricher;
    now?: () => Date;
  }
): Promise<'cached' | 'enriched' | 'stale'> {
  const now = dependencies.now?.() ?? new Date();
  const cached = await dependencies.repository.getEnrichment(task.cacheKey);
  if (cached) {
    await dependencies.repository.applyEnrichment(task.userId, task.recommendationId, cached, now);
    return 'cached';
  }
  const [job, profile, recommendation] = await Promise.all([
    dependencies.repository.getJob(task.jobKey),
    dependencies.repository.getProfile(task.userId),
    dependencies.repository.getRecommendation(task.userId, task.recommendationId)
  ]);
  if (!job || !profile || !recommendation
      || job.contentHash !== task.jobContentHash
      || profile.profileVersion !== task.profileVersion
      || recommendation.jobContentHash !== task.jobContentHash) {
    return 'stale';
  }
  try {
    const output = EnrichmentOutputSchema.parse(await dependencies.enricher.enrich({ job, profile, recommendation }));
    await dependencies.repository.putEnrichment(task.cacheKey, output, now);
    await dependencies.repository.applyEnrichment(task.userId, task.recommendationId, output, now);
    return 'enriched';
  } catch (error) {
    await dependencies.repository.markEnrichmentFailed(task.userId, task.recommendationId, now);
    throw error;
  }
}
