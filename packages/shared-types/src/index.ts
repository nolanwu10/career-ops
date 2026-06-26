import { z } from 'zod';

export const ProviderIdSchema = z.enum([
  'greenhouse',
  'ashby',
  'lever',
  'workable',
  'smartrecruiters',
  'recruitee'
]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const SourceHealthSchema = z.enum(['healthy', 'degraded', 'failing', 'disabled']);
export type SourceHealth = z.infer<typeof SourceHealthSchema>;

export const SourcePrioritySchema = z.enum(['high', 'normal', 'low']);
export const WorkModeSchema = z.enum(['remote', 'hybrid', 'onsite', 'unknown']);
export const EmploymentTypeSchema = z.enum([
  'internship',
  'full_time',
  'part_time',
  'contract',
  'temporary',
  'apprenticeship',
  'unknown'
]);
export type EmploymentType = z.infer<typeof EmploymentTypeSchema>;
export const SenioritySchema = z.enum([
  'intern',
  'entry',
  'mid',
  'senior',
  'staff',
  'principal',
  'lead',
  'manager',
  'director',
  'executive',
  'unknown'
]);
export type Seniority = z.infer<typeof SenioritySchema>;
export const EducationLevelSchema = z.enum(['high_school', 'associate', 'bachelors', 'masters', 'phd', 'md']);
export type EducationLevel = z.infer<typeof EducationLevelSchema>;
export const JobStatusSchema = z.enum(['active', 'inactive']);
export const ScanRunStatusSchema = z.enum(['running', 'succeeded', 'failed', 'skipped']);
export const ScoreBandSchema = z.enum(['strong', 'good', 'possible', 'low']);
export type ScoreBand = z.infer<typeof ScoreBandSchema>;
export const MatchDispositionSchema = z.enum(['recommended', 'needs_review', 'outside_preferences']);
export type MatchDisposition = z.infer<typeof MatchDispositionSchema>;
export const RecommendationStatusSchema = z.enum(['recommended', 'dismissed', 'not_interested', 'evaluated', 'applied']);
export const ExplanationStatusSchema = z.enum(['deterministic', 'pending', 'enriched', 'failed']);
export const FeedbackActionSchema = z.enum(['saved', 'dismissed', 'not_interested', 'evaluated', 'applied', 'restored']);
export type FeedbackAction = z.infer<typeof FeedbackActionSchema>;

const IsoDateSchema = z.string().datetime({ offset: true });
const CorrelationIdSchema = z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/);
const HttpUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === 'https:' || protocol === 'http:';
}, 'URL must use HTTP or HTTPS');

export const CompensationSchema = z.object({
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
  min: z.number().nonnegative().optional(),
  max: z.number().nonnegative().optional(),
  interval: z.enum(['hour', 'day', 'week', 'month', 'year']).optional(),
  text: z.string().trim().optional()
}).superRefine((value, context) => {
  if (value.min !== undefined && value.max !== undefined && value.min > value.max) {
    context.addIssue({ code: 'custom', message: 'Compensation minimum cannot exceed maximum' });
  }
});
export type Compensation = z.infer<typeof CompensationSchema>;

export const JobSourceSchema = z.object({
  sourceId: z.string().trim().min(3).max(120).regex(/^[a-z0-9][a-z0-9-]*$/),
  provider: ProviderIdSchema,
  company: z.string().trim().min(1).max(200),
  boardUrl: z.string().url(),
  boardIdentifier: z.string().trim().min(1).max(300),
  cadenceMinutes: z.number().int().min(5).max(1440),
  priority: SourcePrioritySchema.default('normal'),
  enabled: z.boolean().default(true),
  health: SourceHealthSchema.default('healthy'),
  lastScanAt: IsoDateSchema.optional(),
  nextScanAt: IsoDateSchema.optional(),
  consecutiveFailures: z.number().int().nonnegative().default(0),
  latestError: z.string().max(2000).optional(),
  leaseOwner: z.string().max(200).optional(),
  leaseExpiresAt: IsoDateSchema.optional()
});
export type JobSource = z.infer<typeof JobSourceSchema>;

export const ScanTaskSchema = z.object({
  sourceId: z.string().trim().min(3).max(120),
  provider: ProviderIdSchema,
  scheduledAt: IsoDateSchema,
  attempt: z.number().int().nonnegative().default(0),
  correlationId: CorrelationIdSchema
});
export type ScanTask = z.infer<typeof ScanTaskSchema>;

export const NormalizedJobSchema = z.object({
  provider: ProviderIdSchema,
  providerJobId: z.string().trim().min(1).max(500),
  sourceId: z.string().trim().min(3).max(120),
  canonicalUrl: HttpUrlSchema,
  company: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(500),
  description: z.string().default(''),
  locations: z.array(z.string().trim().min(1).max(300)).default([]),
  workMode: WorkModeSchema.default('unknown'),
  employmentType: EmploymentTypeSchema.default('unknown'),
  seniority: SenioritySchema.default('unknown'),
  countries: z.array(z.string().trim().min(2).max(3).transform((value) => value.toUpperCase())).default([]),
  classificationConfidence: z.number().min(0).max(1).default(0),
  classificationEvidence: z.array(z.string().trim().min(1).max(300)).default([]),
  compensation: CompensationSchema.optional(),
  postedAt: IsoDateSchema.optional(),
  firstSeenAt: IsoDateSchema,
  lastSeenAt: IsoDateSchema,
  lastVerifiedAt: IsoDateSchema.optional(),
  status: JobStatusSchema.default('active'),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/)
});
export type NormalizedJob = z.infer<typeof NormalizedJobSchema>;

export const StoredJobSchema = NormalizedJobSchema.extend({
  jobKey: z.string().min(3),
  canonicalUrlHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceIds: z.preprocess(
    (value) => value instanceof Set ? [...value] : value,
    z.array(z.string().min(3)).min(1)
  )
});
export type StoredJob = z.infer<typeof StoredJobSchema>;

export const FeedbackAffinitySchema = z.object({
  roles: z.record(z.string(), z.number().min(-1).max(1)).default({}),
  companies: z.record(z.string(), z.number().min(-1).max(1)).default({}),
  skills: z.record(z.string(), z.number().min(-1).max(1)).default({}),
  locations: z.record(z.string(), z.number().min(-1).max(1)).default({}),
  workModes: z.record(z.string(), z.number().min(-1).max(1)).default({})
});
export type FeedbackAffinity = z.infer<typeof FeedbackAffinitySchema>;

export const MatchingHardConstraintsSchema = z.object({
  targetRole: z.boolean().default(true),
  seniority: z.boolean().default(true),
  employmentType: z.boolean().default(true),
  workMode: z.boolean().default(true),
  geography: z.boolean().default(true),
  compensation: z.boolean().default(true)
});
export type MatchingHardConstraints = z.infer<typeof MatchingHardConstraintsSchema>;

export const MatchingExceptionSchema = z.object({
  kind: z.enum(['company', 'title_pattern']),
  value: z.string().trim().min(1).max(200),
  allowSeniorities: z.array(SenioritySchema).default([]),
  allowEmploymentTypes: z.array(EmploymentTypeSchema).default([]),
  allowCountries: z.array(z.string().trim().min(2).max(3).transform((value) => value.toUpperCase())).default([]),
  expiresAt: IsoDateSchema.optional()
});
export type MatchingException = z.infer<typeof MatchingExceptionSchema>;

export const UserMatchingProfileSchema = z.object({
  userId: z.string().trim().min(1).max(200),
  profileVersion: z.number().int().positive(),
  active: z.boolean().default(true),
  targetRoles: z.array(z.string().trim().min(1).max(200)).min(1),
  excludedTitles: z.array(z.string().trim().min(1).max(200)).default([]),
  skills: z.array(z.string().trim().min(1).max(120)).default([]),
  evidenceKeywords: z.array(z.string().trim().min(1).max(120)).default([]),
  careerGoals: z.array(z.string().trim().min(1).max(300)).default([]),
  targetLocations: z.array(z.string().trim().min(1).max(200)).default([]),
  authorizedLocations: z.array(z.string().trim().min(1).max(200)).default([]),
  authorizedCountries: z.array(z.string().trim().min(2).max(3).transform((value) => value.toUpperCase())).default([]),
  remoteLocationPolicy: z.enum(['unrestricted', 'authorized_only', 'target_only']).default('authorized_only'),
  acceptedWorkModes: z.array(WorkModeSchema).min(1).default(['remote', 'hybrid', 'onsite', 'unknown']),
  acceptedSeniorities: z.array(SenioritySchema)
    .min(1)
    .default(['intern', 'entry', 'mid', 'senior', 'staff', 'principal', 'lead', 'manager', 'director', 'executive', 'unknown']),
  acceptedEmploymentTypes: z.array(EmploymentTypeSchema).min(1)
    .default(['internship', 'full_time', 'part_time', 'contract', 'temporary', 'apprenticeship', 'unknown']),
  hardConstraints: MatchingHardConstraintsSchema.default({
    targetRole: true,
    seniority: true,
    employmentType: true,
    workMode: true,
    geography: true,
    compensation: true
  }),
  exceptions: z.array(MatchingExceptionSchema).max(50).default([]),
  minimumCompensation: CompensationSchema.optional(),
  maxPostingAgeDays: z.number().int().positive().max(365).optional(),
  feedbackAffinity: FeedbackAffinitySchema.default({
    roles: {},
    companies: {},
    skills: {},
    locations: {},
    workModes: {}
  }),
  educationLevel: EducationLevelSchema.optional(),
  enrichmentDailyLimit: z.number().int().nonnegative().max(100).default(10),
  updatedAt: IsoDateSchema
});
export type UserMatchingProfile = z.infer<typeof UserMatchingProfileSchema>;

export const ScoreBreakdownSchema = z.object({
  skillsEvidence: z.number().min(0).max(30),
  targetRole: z.number().min(0).max(20),
  careerGoals: z.number().min(0).max(15),
  locationWorkMode: z.number().min(0).max(15),
  compensation: z.number().min(0).max(10),
  feedbackAffinity: z.number().min(0).max(10)
});
export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>;

export const RecommendationSchema = z.object({
  userId: z.string().trim().min(1).max(200),
  recommendationId: z.string().trim().min(3).max(800),
  jobKey: z.string().trim().min(3).max(800),
  profileVersion: z.number().int().positive(),
  jobContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  fitScore: z.number().int().min(0).max(100),
  scoreBand: ScoreBandSchema,
  scoreBreakdown: ScoreBreakdownSchema,
  eligible: z.boolean(),
  matchDisposition: MatchDispositionSchema.default('recommended'),
  eligibilityReasons: z.array(z.string().max(500)).default([]),
  reviewReasons: z.array(z.string().max(500)).default([]),
  strongMatches: z.array(z.string().max(500)).default([]),
  concerns: z.array(z.string().max(500)).default([]),
  applicationAngles: z.array(z.string().max(500)).default([]),
  explanationStatus: ExplanationStatusSchema.default('deterministic'),
  status: RecommendationStatusSchema.default('recommended'),
  saved: z.boolean().default(false),
  hiddenByDefault: z.boolean(),
  rankTieBreaker: z.number().int().nonnegative(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const FeedItemSchema = z.object({
  recommendation: RecommendationSchema,
  job: NormalizedJobSchema,
});
export type FeedItem = z.infer<typeof FeedItemSchema>;

export const FeedResponseSchema = z.object({
  items: z.array(FeedItemSchema),
  cursor: z.string().optional(),
  syncedAt: IsoDateSchema,
});
export type FeedResponse = z.infer<typeof FeedResponseSchema>;

export const SyncActionSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  recommendationId: z.string().trim().min(3).max(800),
  jobKey: z.string().trim().min(3).max(800),
  action: FeedbackActionSchema,
  createdAt: IsoDateSchema,
});
export type SyncAction = z.infer<typeof SyncActionSchema>;

export const SyncRequestSchema = z.object({
  cursor: z.string().optional(),
  actions: z.array(SyncActionSchema).max(100).default([]),
  includeNeedsReview: z.boolean().default(true),
});
export type SyncRequest = z.infer<typeof SyncRequestSchema>;

export const SyncResponseSchema = z.object({
  acceptedActionIds: z.array(z.string()),
  feed: FeedResponseSchema,
});
export type SyncResponse = z.infer<typeof SyncResponseSchema>;

export const FeedbackEventSchema = z.object({
  userId: z.string().trim().min(1).max(200),
  eventId: z.string().trim().min(8).max(200),
  recommendationId: z.string().trim().min(3).max(800),
  jobKey: z.string().trim().min(3).max(800),
  action: FeedbackActionSchema,
  dimensions: z.object({
    role: z.string().optional(),
    company: z.string().optional(),
    skills: z.array(z.string()).default([]),
    locations: z.array(z.string()).default([]),
    workMode: WorkModeSchema.optional()
  }),
  weight: z.number().min(-1).max(1),
  createdAt: IsoDateSchema
});
export type FeedbackEvent = z.infer<typeof FeedbackEventSchema>;

export const MatchJobTaskSchema = z.object({
  jobKey: z.string().trim().min(3).max(800),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  correlationId: CorrelationIdSchema
});
export type MatchJobTask = z.infer<typeof MatchJobTaskSchema>;

export const EnrichmentTaskSchema = z.object({
  userId: z.string().trim().min(1).max(200),
  recommendationId: z.string().trim().min(3).max(800),
  jobKey: z.string().trim().min(3).max(800),
  profileVersion: z.number().int().positive(),
  jobContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  cacheKey: z.string().trim().min(3).max(800),
  correlationId: CorrelationIdSchema
});
export type EnrichmentTask = z.infer<typeof EnrichmentTaskSchema>;

export const EnrichmentOutputSchema = z.object({
  strongMatches: z.array(z.string().trim().min(1).max(500)).min(1).max(5),
  concerns: z.array(z.string().trim().min(1).max(500)).max(5).default([]),
  applicationAngles: z.array(z.string().trim().min(1).max(500)).max(5).default([])
});
export type EnrichmentOutput = z.infer<typeof EnrichmentOutputSchema>;

export const ScanErrorSchema = z.object({
  code: z.string().min(1).max(120),
  message: z.string().min(1).max(2000),
  retryable: z.boolean(),
  providerJobId: z.string().optional()
});
export type ScanError = z.infer<typeof ScanErrorSchema>;

export const ScanResultSchema = z.object({
  inserted: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  errors: z.array(ScanErrorSchema).default([])
});
export type ScanResult = z.infer<typeof ScanResultSchema>;

export const ScanRunSchema = z.object({
  sourceId: z.string().trim().min(3).max(120),
  startedAt: IsoDateSchema,
  completedAt: IsoDateSchema.optional(),
  correlationId: CorrelationIdSchema,
  provider: ProviderIdSchema,
  status: ScanRunStatusSchema,
  durationMs: z.number().int().nonnegative().optional(),
  result: ScanResultSchema,
  error: ScanErrorSchema.optional(),
  expiresAt: z.number().int().positive()
});
export type ScanRun = z.infer<typeof ScanRunSchema>;

export function parseJobSource(input: unknown): JobSource {
  return JobSourceSchema.parse(input);
}

export function parseScanTask(input: unknown): ScanTask {
  return ScanTaskSchema.parse(input);
}

export function parseNormalizedJob(input: unknown): NormalizedJob {
  return NormalizedJobSchema.parse(input);
}

export function parseUserMatchingProfile(input: unknown): UserMatchingProfile {
  return UserMatchingProfileSchema.parse(input);
}

export function parseRecommendation(input: unknown): Recommendation {
  return RecommendationSchema.parse(input);
}

export function parseMatchJobTask(input: unknown): MatchJobTask {
  return MatchJobTaskSchema.parse(input);
}

export function parseEnrichmentTask(input: unknown): EnrichmentTask {
  return EnrichmentTaskSchema.parse(input);
}
