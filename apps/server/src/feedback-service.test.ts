import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUserMatchingProfile, type FeedbackEvent, type UserMatchingProfile } from '@career-ops/shared-types';
import { processFeedbackEvent, type FeedbackRepositoryPort } from './feedback-service.js';
import { feedbackWeight } from './ranking.js';

const profile = parseUserMatchingProfile({
  userId: 'user-1',
  profileVersion: 1,
  targetRoles: ['Product Manager'],
  updatedAt: '2026-06-19T00:00:00Z'
});

class FakeRepository implements FeedbackRepositoryPort {
  saved?: { event: FeedbackEvent; profile: UserMatchingProfile; expected: number };
  async getProfile() { return profile; }
  async saveFeedbackAndProfile(event: FeedbackEvent, updated: UserMatchingProfile, expected: number) {
    this.saved = { event, profile: updated, expected };
  }
}

test('feedback is persisted atomically with an incremented profile version and affinities', async () => {
  const repository = new FakeRepository();
  const updated = await processFeedbackEvent({
    userId: profile.userId,
    eventId: 'event-123456',
    recommendationId: 'user-1#greenhouse#1',
    jobKey: 'greenhouse#1',
    action: 'not_interested',
    dimensions: {
      role: 'Sales Product Manager',
      company: 'Acme',
      skills: ['sales'],
      locations: ['Remote'],
      workMode: 'remote'
    },
    weight: feedbackWeight('not_interested'),
    createdAt: '2026-06-19T12:00:00Z'
  }, repository, new Date('2026-06-19T12:00:01Z'));
  assert.equal(updated.profileVersion, 2);
  assert.ok(updated.feedbackAffinity.roles['sales product manager']! < 0);
  assert.equal(repository.saved?.expected, 1);
});
