import {
  FeedbackEventSchema,
  UserMatchingProfileSchema,
  type FeedbackEvent,
  type UserMatchingProfile
} from '@career-ops/shared-types';
import { applyFeedbackToProfile } from './ranking.js';
import { feedbackWeight } from './ranking.js';

export interface FeedbackRepositoryPort {
  getProfile(userId: string): Promise<UserMatchingProfile | null>;
  saveFeedbackAndProfile(
    event: FeedbackEvent,
    profile: UserMatchingProfile,
    expectedProfileVersion: number
  ): Promise<void>;
}

export async function processFeedbackEvent(
  input: unknown,
  repository: FeedbackRepositoryPort,
  now = new Date()
): Promise<UserMatchingProfile> {
  const parsed = FeedbackEventSchema.parse(input);
  const event = FeedbackEventSchema.parse({ ...parsed, weight: feedbackWeight(parsed.action) });
  const current = await repository.getProfile(event.userId);
  if (!current) throw new Error(`Profile not found for ${event.userId}`);
  const updated = UserMatchingProfileSchema.parse({
    ...applyFeedbackToProfile(current, event),
    profileVersion: current.profileVersion + 1,
    updatedAt: now.toISOString()
  });
  await repository.saveFeedbackAndProfile(event, updated, current.profileVersion);
  return updated;
}
