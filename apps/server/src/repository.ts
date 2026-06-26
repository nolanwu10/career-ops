import { createHash } from 'node:crypto';
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient
} from '@aws-sdk/lib-dynamodb';
import {
  parseJobSource,
  type JobSource,
  type NormalizedJob,
  type ScanError,
  type ScanResult,
  type ScanRun,
  type StoredJob
} from '@career-ops/shared-types';

export interface RepositoryConfig {
  sourcesTable: string;
  jobsTable: string;
  scanRunsTable: string;
}

export class ScanRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly config: RepositoryConfig
  ) {}

  async getSource(sourceId: string): Promise<JobSource | null> {
    const response = await this.client.send(new GetCommand({
      TableName: this.config.sourcesTable,
      Key: { sourceId },
      ConsistentRead: true
    }));
    return response.Item ? parseJobSource(response.Item) : null;
  }

  async acquireLease(sourceId: string, owner: string, now: Date, leaseSeconds = 120): Promise<boolean> {
    const nowEpoch = Math.floor(now.getTime() / 1000);
    const expiresEpoch = nowEpoch + leaseSeconds;
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.config.sourcesTable,
        Key: { sourceId },
        UpdateExpression: 'SET leaseOwner = :owner, leaseExpiresAt = :expiresAt, leaseExpiresEpoch = :expiresEpoch',
        ConditionExpression: 'attribute_not_exists(leaseExpiresEpoch) OR leaseExpiresEpoch < :now',
        ExpressionAttributeValues: {
          ':owner': owner,
          ':expiresAt': new Date(expiresEpoch * 1000).toISOString(),
          ':expiresEpoch': expiresEpoch,
          ':now': nowEpoch
        }
      }));
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      throw error;
    }
  }

  async releaseLease(sourceId: string, owner: string): Promise<void> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.config.sourcesTable,
        Key: { sourceId },
        UpdateExpression: 'REMOVE leaseOwner, leaseExpiresAt, leaseExpiresEpoch',
        ConditionExpression: 'leaseOwner = :owner',
        ExpressionAttributeValues: { ':owner': owner }
      }));
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }
  }

  async upsertJob(job: NormalizedJob): Promise<'inserted' | 'updated' | 'unchanged'> {
    const jobKey = `${job.provider}#${job.providerJobId}`;
    const canonicalUrlHash = createHash('sha256').update(job.canonicalUrl).digest('hex');
    const response = await this.client.send(new UpdateCommand({
      TableName: this.config.jobsTable,
      Key: { jobKey },
      UpdateExpression: [
        'SET provider = :provider',
        'providerJobId = :providerJobId',
        'canonicalUrl = :canonicalUrl',
        'canonicalUrlHash = :canonicalUrlHash',
        'company = :company',
        'title = :title',
        'description = :description',
        'locations = :locations',
        'workMode = :workMode',
        'employmentType = :employmentType',
        'seniority = :seniority',
        'countries = :countries',
        'classificationConfidence = :classificationConfidence',
        'classificationEvidence = :classificationEvidence',
        'compensation = :compensation',
        'postedAt = :postedAt',
        'firstSeenAt = if_not_exists(firstSeenAt, :firstSeenAt)',
        'lastSeenAt = :lastSeenAt',
        'lastVerifiedAt = :lastVerifiedAt',
        '#status = :status',
        'contentHash = :contentHash'
      ].join(', ') + ' ADD sourceIds :sourceIds',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':provider': job.provider,
        ':providerJobId': job.providerJobId,
        ':canonicalUrl': job.canonicalUrl,
        ':canonicalUrlHash': canonicalUrlHash,
        ':company': job.company,
        ':title': job.title,
        ':description': job.description,
        ':locations': job.locations,
        ':workMode': job.workMode,
        ':employmentType': job.employmentType,
        ':seniority': job.seniority,
        ':countries': job.countries,
        ':classificationConfidence': job.classificationConfidence,
        ':classificationEvidence': job.classificationEvidence,
        ':compensation': job.compensation ?? null,
        ':postedAt': job.postedAt ?? null,
        ':firstSeenAt': job.firstSeenAt,
        ':lastSeenAt': job.lastSeenAt,
        ':lastVerifiedAt': job.lastVerifiedAt ?? job.lastSeenAt,
        ':status': job.status,
        ':contentHash': job.contentHash,
        ':sourceIds': new Set([job.sourceId])
      },
      ReturnValues: 'ALL_OLD'
    }));
    if (!response.Attributes) return 'inserted';
    return response.Attributes.contentHash === job.contentHash ? 'unchanged' : 'updated';
  }

  async recordSuccess(source: JobSource, completedAt: Date): Promise<void> {
    await this.client.send(new UpdateCommand({
      TableName: this.config.sourcesTable,
      Key: { sourceId: source.sourceId },
      UpdateExpression: [
        'SET health = :health',
        'lastScanAt = :lastScanAt',
        'nextScanAt = :nextScanAt',
        'consecutiveFailures = :zero',
        'latestError = :empty'
      ].join(', '),
      ExpressionAttributeValues: {
        ':health': 'healthy',
        ':lastScanAt': completedAt.toISOString(),
        ':nextScanAt': new Date(completedAt.getTime() + source.cadenceMinutes * 60_000).toISOString(),
        ':zero': 0,
        ':empty': ''
      }
    }));
  }

  async recordFailure(source: JobSource, error: ScanError, completedAt: Date): Promise<void> {
    const failures = source.consecutiveFailures + 1;
    const health = failures >= 3 ? 'failing' : 'degraded';
    await this.client.send(new UpdateCommand({
      TableName: this.config.sourcesTable,
      Key: { sourceId: source.sourceId },
      UpdateExpression: [
        'SET health = :health',
        'lastScanAt = :lastScanAt',
        'nextScanAt = :nextScanAt',
        'consecutiveFailures = :failures',
        'latestError = :error'
      ].join(', '),
      ExpressionAttributeValues: {
        ':health': health,
        ':lastScanAt': completedAt.toISOString(),
        ':nextScanAt': new Date(completedAt.getTime() + source.cadenceMinutes * 60_000).toISOString(),
        ':failures': failures,
        ':error': error.message
      }
    }));
  }

  async putScanRun(run: ScanRun): Promise<void> {
    await this.client.send(new PutCommand({
      TableName: this.config.scanRunsTable,
      Item: run
    }));
  }
}

export function emptyScanResult(): ScanResult {
  return { inserted: 0, updated: 0, unchanged: 0, rejected: 0, failed: 0, errors: [] };
}

function isConditionalFailure(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'name' in error
    && error.name === 'ConditionalCheckFailedException');
}
