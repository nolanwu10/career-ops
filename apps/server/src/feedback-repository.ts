import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient
} from '@aws-sdk/lib-dynamodb';
import {
  parseUserMatchingProfile,
  type FeedbackEvent,
  type UserMatchingProfile
} from '@career-ops/shared-types';

export class FeedbackRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly profilesTable: string,
    private readonly feedbackEventsTable: string
  ) {}

  async getProfile(userId: string): Promise<UserMatchingProfile | null> {
    const response = await this.client.send(new GetCommand({
      TableName: this.profilesTable,
      Key: { userId },
      ConsistentRead: true
    }));
    return response.Item ? parseUserMatchingProfile(response.Item) : null;
  }

  async saveFeedbackAndProfile(
    event: FeedbackEvent,
    profile: UserMatchingProfile,
    expectedProfileVersion: number
  ): Promise<void> {
    await this.client.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: this.feedbackEventsTable,
            Item: event,
            ConditionExpression: 'attribute_not_exists(eventId)'
          }
        },
        {
          Put: {
            TableName: this.profilesTable,
            Item: profile,
            ConditionExpression: 'profileVersion = :expected',
            ExpressionAttributeValues: { ':expected': expectedProfileVersion }
          }
        }
      ]
    }));
  }
}
