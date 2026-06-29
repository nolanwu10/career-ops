import assert from 'node:assert/strict';
import test from 'node:test';
import { JobSourceSchema } from '@career-ops/shared-types';
import { UserMatchingProfileSchema } from '@career-ops/shared-types';
import { developmentProfiles, developmentSources } from './catalog.js';

test('development catalog covers all API providers with unique ids', () => {
  const providers = new Set(developmentSources.map((source) => source.provider));
  assert.equal(providers.size, 6);
  assert.equal(new Set(developmentSources.map((source) => source.sourceId)).size, developmentSources.length);
  assert.equal(developmentSources.every((source) => JobSourceSchema.safeParse(source).success), true);
});

test('development profile contains only approved matching preferences and evidence', () => {
  assert.equal(developmentProfiles.length, 1);
  assert.equal(UserMatchingProfileSchema.safeParse(developmentProfiles[0]).success, true);
  assert.equal(developmentProfiles[0]?.enrichmentDailyLimit, 20);
  assert.equal('resume' in developmentProfiles[0]!, false);
});

test('development catalog uses source-aware cadence', () => {
  for (const source of developmentSources) {
    const expected = ['greenhouse', 'ashby', 'lever'].includes(source.provider) ? 15 : 30;
    assert.equal(source.cadenceMinutes, expected);
  }
});
