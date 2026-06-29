import {
  parseJobSource,
  parseUserMatchingProfile,
  type JobSource,
  type UserMatchingProfile
} from '@career-ops/shared-types';

export const developmentSources: JobSource[] = [
  {
    sourceId: 'anthropic-greenhouse',
    provider: 'greenhouse',
    company: 'Anthropic',
    boardUrl: 'https://job-boards.greenhouse.io/anthropic',
    boardIdentifier: 'anthropic',
    cadenceMinutes: 15,
    priority: 'high',
    enabled: true,
    health: 'healthy',
    consecutiveFailures: 0
  },
  {
    sourceId: 'elevenlabs-ashby',
    provider: 'ashby',
    company: 'ElevenLabs',
    boardUrl: 'https://jobs.ashbyhq.com/elevenlabs',
    boardIdentifier: 'elevenlabs',
    cadenceMinutes: 15,
    priority: 'high',
    enabled: true,
    health: 'healthy',
    consecutiveFailures: 0
  },
  {
    sourceId: 'netlify-lever',
    provider: 'lever',
    company: 'Netlify',
    boardUrl: 'https://jobs.lever.co/netlify',
    boardIdentifier: 'netlify',
    cadenceMinutes: 15,
    priority: 'normal',
    enabled: true,
    health: 'healthy',
    consecutiveFailures: 0
  },
  {
    sourceId: 'workable-demo',
    provider: 'workable',
    company: 'Workable',
    boardUrl: 'https://apply.workable.com/workable',
    boardIdentifier: 'workable',
    cadenceMinutes: 30,
    priority: 'normal',
    enabled: true,
    health: 'healthy',
    consecutiveFailures: 0
  },
  {
    sourceId: 'bosch-smartrecruiters',
    provider: 'smartrecruiters',
    company: 'Bosch Group',
    boardUrl: 'https://jobs.smartrecruiters.com/BoschGroup',
    boardIdentifier: 'BoschGroup',
    cadenceMinutes: 30,
    priority: 'normal',
    enabled: true,
    health: 'healthy',
    consecutiveFailures: 0
  },
  {
    sourceId: 'recruitee-demo',
    provider: 'recruitee',
    company: 'Recruitee',
    boardUrl: 'https://recruitee.recruitee.com',
    boardIdentifier: 'recruitee',
    cadenceMinutes: 30,
    priority: 'normal',
    enabled: true,
    health: 'healthy',
    consecutiveFailures: 0
  }
].map(parseJobSource);

export const developmentProfiles: UserMatchingProfile[] = [
  parseUserMatchingProfile({
    userId: 'development-user',
    profileVersion: 1,
    active: true,
    targetRoles: ['AI Product Manager', 'Technical Product Manager', 'Product Operations'],
    excludedTitles: ['Sales', 'Account Executive'],
    skills: ['artificial intelligence', 'product discovery', 'analytics', 'strategy', 'roadmap'],
    evidenceKeywords: ['cross-functional delivery', 'stakeholder management'],
    careerGoals: ['lead AI product strategy and delivery'],
    targetLocations: ['Remote', 'New York'],
    authorizedLocations: ['United States', 'New York'],
    acceptedWorkModes: ['remote', 'hybrid'],
    acceptedSeniorities: ['mid', 'senior', 'lead', 'manager', 'director', 'unknown'],
    minimumCompensation: { currency: 'USD', min: 120000, interval: 'year' },
    enrichmentDailyLimit: 20,
    updatedAt: '2026-06-19T00:00:00.000Z'
  })
];
