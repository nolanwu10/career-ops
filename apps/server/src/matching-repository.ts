import {
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
  type DynamoDBDocumentClient
} from '@aws-sdk/lib-dynamodb';
import {
  EnrichmentOutputSchema,
  parseNormalizedJob,
  parseRecommendation,
  parseUserMatchingProfile,
  type EnrichmentOutput,
  type Recommendation,
  type UserMatchingProfile
} from '@career-ops/shared-types';

export interface MatchingRepositoryConfig {
  jobsTable: string;
  profilesTable: string;
  recommendationsTable: string;
  enrichmentCacheTable: string;
  enrichmentBudgetsTable: string;
}

export class MatchingRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly config: MatchingRepositoryConfig
  ) {}

  async getJob(jobKey: string) {
    const response = await this.client.send(new GetCommand({
      TableName: this.config.jobsTable,
      Key: { jobKey },
      ConsistentRead: true
    }));
    return response.Item ? parseNormalizedJob(response.Item) : null;
  }

  async listActiveProfiles(): Promise<UserMatchingProfile[]> {
    const profiles: UserMatchingProfile[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const response = await this.client.send(new ScanCommand({
        TableName: this.config.profilesTable,
        FilterExpression: 'active = :active',
        ExpressionAttributeValues: { ':active': true },
        ExclusiveStartKey
      }));
      profiles.push(...(response.Items || []).map(parseUserMatchingProfile));
      ExclusiveStartKey = response.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return profiles;
  }

  async putRecommendation(recommendation: Recommendation): Promise<Recommendation> {
    const response = await this.client.send(new UpdateCommand({
      TableName: this.config.recommendationsTable,
      Key: {
        userId: recommendation.userId,
        recommendationId: recommendation.recommendationId
      },
      UpdateExpression: [
        'SET jobKey = :jobKey',
        'profileVersion = :profileVersion',
        'jobContentHash = :jobContentHash',
        'fitScore = :fitScore',
        'scoreBand = :scoreBand',
        'scoreBreakdown = :scoreBreakdown',
        'eligible = :eligible',
        'matchDisposition = :matchDisposition',
        'eligibilityReasons = :eligibilityReasons',
        'reviewReasons = :reviewReasons',
        'strongMatches = :strongMatches',
        'concerns = :concerns',
        'applicationAngles = :applicationAngles',
        'explanationStatus = :explanationStatus',
        '#status = if_not_exists(#status, :status)',
        'saved = if_not_exists(saved, :saved)',
        'hiddenByDefault = :hiddenByDefault',
        'rankTieBreaker = :rankTieBreaker',
        'createdAt = if_not_exists(createdAt, :createdAt)',
        'updatedAt = :updatedAt'
      ].join(', '),
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':jobKey': recommendation.jobKey,
        ':profileVersion': recommendation.profileVersion,
        ':jobContentHash': recommendation.jobContentHash,
        ':fitScore': recommendation.fitScore,
        ':scoreBand': recommendation.scoreBand,
        ':scoreBreakdown': recommendation.scoreBreakdown,
        ':eligible': recommendation.eligible,
        ':matchDisposition': recommendation.matchDisposition,
        ':eligibilityReasons': recommendation.eligibilityReasons,
        ':reviewReasons': recommendation.reviewReasons,
        ':strongMatches': recommendation.strongMatches,
        ':concerns': recommendation.concerns,
        ':applicationAngles': recommendation.applicationAngles,
        ':explanationStatus': recommendation.explanationStatus,
        ':status': recommendation.status,
        ':saved': recommendation.saved,
        ':hiddenByDefault': recommendation.hiddenByDefault,
        ':rankTieBreaker': recommendation.rankTieBreaker,
        ':createdAt': recommendation.createdAt,
        ':updatedAt': recommendation.updatedAt
      },
      ReturnValues: 'ALL_NEW'
    }));
    return parseRecommendation(response.Attributes);
  }

  async getRecommendation(userId: string, recommendationId: string): Promise<Recommendation | null> {
    const response = await this.client.send(new GetCommand({
      TableName: this.config.recommendationsTable,
      Key: { userId, recommendationId },
      ConsistentRead: true
    }));
    return response.Item ? parseRecommendation(response.Item) : null;
  }

  async getEnrichment(cacheKey: string): Promise<EnrichmentOutput | null> {
    const response = await this.client.send(new GetCommand({
      TableName: this.config.enrichmentCacheTable,
      Key: { cacheKey }
    }));
    return response.Item?.output ? EnrichmentOutputSchema.parse(response.Item.output) : null;
  }

  async putEnrichment(cacheKey: string, output: EnrichmentOutput, now: Date): Promise<void> {
    await this.client.send(new PutCommand({
      TableName: this.config.enrichmentCacheTable,
      Item: {
        cacheKey,
        output,
        createdAt: now.toISOString(),
        expiresAt: Math.floor(now.getTime() / 1000) + 180 * 86_400
      }
    }));
  }

  async applyEnrichment(
    userId: string,
    recommendationId: string,
    output: EnrichmentOutput,
    now: Date
  ): Promise<void> {
    await this.client.send(new UpdateCommand({
      TableName: this.config.recommendationsTable,
      Key: { userId, recommendationId },
      UpdateExpression: 'SET strongMatches = :strongMatches, concerns = :concerns, applicationAngles = :angles, explanationStatus = :status, updatedAt = :updatedAt',
      ExpressionAttributeValues: {
        ':strongMatches': output.strongMatches,
        ':concerns': output.concerns,
        ':angles': output.applicationAngles,
        ':status': 'enriched',
        ':updatedAt': now.toISOString()
      }
    }));
  }

  async markEnrichmentPending(userId: string, recommendationId: string, now: Date): Promise<void> {
    await this.client.send(new UpdateCommand({
      TableName: this.config.recommendationsTable,
      Key: { userId, recommendationId },
      UpdateExpression: 'SET explanationStatus = :status, updatedAt = :updatedAt',
      ExpressionAttributeValues: {
        ':status': 'pending',
        ':updatedAt': now.toISOString()
      }
    }));
  }

  async markEnrichmentFailed(userId: string, recommendationId: string, now: Date): Promise<void> {
    await this.client.send(new UpdateCommand({
      TableName: this.config.recommendationsTable,
      Key: { userId, recommendationId },
      UpdateExpression: 'SET explanationStatus = :status, updatedAt = :updatedAt',
      ExpressionAttributeValues: {
        ':status': 'failed',
        ':updatedAt': now.toISOString()
      }
    }));
  }

  async reserveDailyEnrichment(
    userId: string,
    date: string,
    limit: number,
    reservationId: string
  ): Promise<'reserved' | 'existing' | 'exhausted'> {
    if (limit <= 0) return 'exhausted';
    const userDate = `${userId}#${date}`;
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.config.enrichmentBudgetsTable,
        Key: { userDate },
        UpdateExpression: 'SET expiresAt = :expiresAt ADD used :one, reservationIds :reservationSet',
        ConditionExpression: '(attribute_not_exists(used) OR used < :limit) AND (attribute_not_exists(reservationIds) OR NOT contains(reservationIds, :reservation))',
        ExpressionAttributeValues: {
          ':one': 1,
          ':limit': limit,
          ':reservation': reservationId,
          ':reservationSet': new Set([reservationId]),
          ':expiresAt': Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000) + 3 * 86_400
        }
      }));
      return 'reserved';
    } catch (error) {
      if (isConditionalFailure(error)) {
        const existing = await this.client.send(new GetCommand({
          TableName: this.config.enrichmentBudgetsTable,
          Key: { userDate },
          ConsistentRead: true
        }));
        const reservations = existing.Item?.reservationIds;
        if (reservations instanceof Set && reservations.has(reservationId)) return 'existing';
        if (Array.isArray(reservations) && reservations.includes(reservationId)) return 'existing';
        return 'exhausted';
      }
      throw error;
    }
  }
}

function isConditionalFailure(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'name' in error
    && error.name === 'ConditionalCheckFailedException');
}
