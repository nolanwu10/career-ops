import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { parseUserMatchingProfile } from '@career-ops/shared-types';
import { MatchingRepository, type MatchingRepositoryConfig } from './matching-repository.js';

export class EnrichmentRepository extends MatchingRepository {
  constructor(
    private readonly documentClient: DynamoDBDocumentClient,
    private readonly tables: MatchingRepositoryConfig
  ) {
    super(documentClient, tables);
  }

  async getProfile(userId: string) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tables.profilesTable,
      Key: { userId },
      ConsistentRead: true
    }));
    return response.Item ? parseUserMatchingProfile(response.Item) : null;
  }
}
