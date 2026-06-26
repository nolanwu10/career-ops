import assert from 'node:assert/strict';
import test from 'node:test';
import { FeedbackEventSchema, parseNormalizedJob, parseUserMatchingProfile } from '@career-ops/shared-types';
import { applyFeedbackToProfile, evaluateEligibility, feedbackWeight, rankJobForProfile, scoreBand } from './ranking.js';

const now = new Date('2026-06-19T12:00:00Z');
const job = parseNormalizedJob({
  provider: 'greenhouse',
  providerJobId: '1',
  sourceId: 'acme-greenhouse',
  canonicalUrl: 'https://example.com/jobs/1',
  company: 'Acme AI',
  title: 'Senior AI Product Manager',
  description: 'Lead generative AI products, roadmap, discovery, analytics, and cross-functional delivery.',
  locations: ['New York, NY', 'Remote'],
  workMode: 'remote',
  compensation: { currency: 'USD', min: 180000, max: 220000, interval: 'year' },
  postedAt: '2026-06-18T12:00:00Z',
  firstSeenAt: '2026-06-18T12:00:00Z',
  lastSeenAt: '2026-06-19T12:00:00Z',
  status: 'active',
  contentHash: 'a'.repeat(64)
});
const profile = parseUserMatchingProfile({
  userId: 'user-1',
  profileVersion: 3,
  targetRoles: ['AI Product Manager', 'Technical Product Manager'],
  excludedTitles: ['Sales'],
  skills: ['generative AI', 'product discovery', 'analytics', 'roadmap'],
  evidenceKeywords: ['cross-functional delivery'],
  careerGoals: ['lead AI product strategy and delivery'],
  targetLocations: ['New York', 'Remote'],
  authorizedLocations: ['United States', 'New York'],
  acceptedWorkModes: ['remote', 'hybrid'],
  acceptedSeniorities: ['senior', 'lead', 'manager'],
  minimumCompensation: { currency: 'USD', min: 160000, interval: 'year' },
  feedbackAffinity: {
    roles: { 'ai product manager': 0.8 },
    companies: { 'acme ai': 0.5 },
    skills: { 'generative ai': 0.7 },
    locations: { remote: 0.6 },
    workModes: { remote: 0.8 }
  },
  updatedAt: now.toISOString()
});

test('strong matching job receives weighted score and deterministic reasons', () => {
  const recommendation = rankJobForProfile(job, profile, now);
  assert.equal(recommendation.eligible, true);
  assert.ok(recommendation.fitScore >= 80);
  assert.equal(recommendation.scoreBand, 'strong');
  assert.equal(recommendation.explanationStatus, 'deterministic');
  assert.ok(recommendation.strongMatches.length >= 3);
  assert.equal(recommendation.hiddenByDefault, false);
});

test('each hard eligibility rule can reject a job', () => {
  const cases = [
    { job: { ...job, title: 'Enterprise Sales Director' }, profile },
    { job, profile: { ...profile, acceptedSeniorities: ['entry' as const] } },
    { job: { ...job, workMode: 'onsite' as const }, profile },
    { job: { ...job, workMode: 'onsite' as const, locations: ['Paris, France'] }, profile },
    { job: { ...job, compensation: { currency: 'USD', max: 100000, interval: 'year' as const } }, profile },
    { job: { ...job, postedAt: '2025-01-01T00:00:00Z' }, profile: { ...profile, maxPostingAgeDays: 30 } }
  ];
  for (const item of cases) {
    assert.equal(evaluateEligibility(item.job, item.profile, now).eligible, false);
  }
});

test('unknown compensation remains eligible and produces a concern', () => {
  const result = rankJobForProfile({ ...job, compensation: undefined }, profile, now);
  assert.equal(result.eligible, true);
  assert.ok(result.concerns.some((value) => value.includes('Compensation')));
});

test('internship-only profile rejects full-time jobs and reviews ambiguous postings', () => {
  const internshipProfile = {
    ...profile,
    targetRoles: ['Software Engineer Intern'],
    acceptedSeniorities: ['intern' as const],
    acceptedEmploymentTypes: ['internship' as const],
    acceptedWorkModes: ['remote' as const],
    authorizedCountries: ['US'],
    remoteLocationPolicy: 'authorized_only' as const
  };
  const fullTime = rankJobForProfile({
    ...job,
    title: 'Software Engineer',
    employmentType: 'full_time',
    seniority: 'entry',
    countries: ['US']
  }, internshipProfile, now);
  assert.equal(fullTime.matchDisposition, 'outside_preferences');
  assert.ok(fullTime.eligibilityReasons.some((reason) => reason.includes('Employment type')));

  const ambiguous = rankJobForProfile({
    ...job,
    title: 'Software Engineer',
    employmentType: 'unknown',
    seniority: 'unknown',
    countries: ['US']
  }, internshipProfile, now);
  assert.equal(ambiguous.matchDisposition, 'needs_review');
  assert.ok(ambiguous.reviewReasons.some((reason) => reason.includes('Seniority')));
});

test('authorized-country policy rejects international remote jobs and exceptions stay scoped', () => {
  const internshipProfile = {
    ...profile,
    targetRoles: ['Software Engineer Intern'],
    acceptedSeniorities: ['intern' as const],
    acceptedEmploymentTypes: ['internship' as const],
    authorizedCountries: ['US'],
    remoteLocationPolicy: 'authorized_only' as const,
    exceptions: [{
      kind: 'company' as const,
      value: 'OpenAI',
      allowSeniorities: ['entry' as const],
      allowEmploymentTypes: ['full_time' as const],
      allowCountries: ['US']
    }]
  };
  const international = rankJobForProfile({
    ...job,
    title: 'Software Engineer Intern',
    employmentType: 'internship',
    seniority: 'intern',
    countries: ['CA'],
    locations: ['Remote - Canada']
  }, internshipProfile, now);
  assert.equal(international.matchDisposition, 'outside_preferences');

  const exception = rankJobForProfile({
    ...job,
    company: 'OpenAI',
    title: 'Entry Software Engineer',
    employmentType: 'full_time',
    seniority: 'entry',
    countries: ['US']
  }, internshipProfile, now);
  assert.notEqual(exception.matchDisposition, 'outside_preferences');
});

test('feedback affinity increases or decreases score and not-interested is stronger than dismiss', () => {
  const positive = rankJobForProfile(job, profile, now);
  const negative = rankJobForProfile(job, {
    ...profile,
    feedbackAffinity: {
      roles: { 'ai product manager': -1 },
      companies: { 'acme ai': -1 },
      skills: { 'generative ai': -1 },
      locations: { remote: -1 },
      workModes: { remote: -1 }
    }
  }, now);
  assert.ok(positive.fitScore > negative.fitScore);
  assert.ok(Math.abs(feedbackWeight('not_interested')) > Math.abs(feedbackWeight('dismissed')));
});

test('score bands use documented thresholds', () => {
  assert.equal(scoreBand(80), 'strong');
  assert.equal(scoreBand(65), 'good');
  assert.equal(scoreBand(50), 'possible');
  assert.equal(scoreBand(49), 'low');
});

test('feedback events update all supplied affinity dimensions', () => {
  const event = FeedbackEventSchema.parse({
    userId: profile.userId,
    eventId: 'event-123456',
    recommendationId: 'rec-123',
    jobKey: 'greenhouse#1',
    action: 'not_interested',
    dimensions: {
      role: job.title,
      company: job.company,
      skills: ['generative AI'],
      locations: ['Remote'],
      workMode: 'remote'
    },
    weight: feedbackWeight('not_interested'),
    createdAt: now.toISOString()
  });
  const updated = applyFeedbackToProfile(profile, event);
  assert.ok(updated.feedbackAffinity.roles['senior ai product manager']! < 0);
  assert.ok(updated.feedbackAffinity.companies['acme ai']! < profile.feedbackAffinity.companies['acme ai']!);
  assert.ok(updated.feedbackAffinity.workModes.remote! < profile.feedbackAffinity.workModes.remote!);
});

test('jobs requiring PhD or MD are auto-disqualified when education level does not match', () => {
  const bachelorsProfile = { ...profile, educationLevel: 'bachelors' as const };

  const cases: [string, string][] = [
    ['Must be currently pursuing a PhD in computer science.', 'PhD'],
    ['Candidates must be pursuing an MD or PhD.', 'PhD/MD'],
    ['PhD required for this research position.', 'PhD'],
    ['PhD or MD required.', 'PhD/MD'],
    ['Doctoral candidates only.', 'PhD'],
    ['Currently enrolled in an MD program.', 'MD'],
  ];
  for (const [description, label] of cases) {
    const result = evaluateEligibility({ ...job, description }, bachelorsProfile, now);
    assert.equal(result.eligible, false, `Expected ineligible for: ${description}`);
    assert.ok(result.reasons.some((r) => r.includes(label)), `Expected reason to mention ${label}`);
  }

  // Non-requirement mentions should not disqualify
  const softMentions = [
    'We collaborate with PhD scientists on cutting-edge research.',
    'A PhD is a plus but not required.',
  ];
  for (const description of softMentions) {
    const result = evaluateEligibility({ ...job, description }, bachelorsProfile, now);
    assert.equal(result.eligible, true, `Expected eligible for: ${description}`);
  }

  // PhD holder qualifies for PhD role
  const phdProfile = { ...profile, educationLevel: 'phd' as const };
  const phdResult = evaluateEligibility({ ...job, description: 'PhD required.' }, phdProfile, now);
  assert.equal(phdResult.eligible, true);

  // Profile without educationLevel set is unaffected
  const result = evaluateEligibility({ ...job, description: 'Must be pursuing a PhD.' }, profile, now);
  assert.equal(result.eligible, true);
});

test('recency changes only the tie-breaker, not the weighted score', () => {
  const recent = rankJobForProfile(job, profile, now);
  const older = rankJobForProfile({
    ...job,
    postedAt: '2026-05-01T00:00:00Z',
    contentHash: 'b'.repeat(64)
  }, profile, now);
  assert.equal(recent.fitScore, older.fitScore);
  assert.ok(recent.rankTieBreaker > older.rankTieBreaker);
});
