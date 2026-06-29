import {
  RecommendationSchema,
  type Compensation,
  type NormalizedJob,
  type Recommendation,
  type FeedbackEvent,
  type ScoreBand,
  type ScoreBreakdown,
  type UserMatchingProfile
} from '@career-ops/shared-types';

export interface EligibilityResult {
  eligible: boolean;
  disposition: 'recommended' | 'needs_review' | 'outside_preferences';
  reasons: string[];
  reviewReasons: string[];
  concerns: string[];
}

export function evaluateEligibility(
  job: NormalizedJob,
  profile: UserMatchingProfile,
  now = new Date()
): EligibilityResult {
  const title = normalize(job.title);
  const reasons: string[] = [];
  const reviewReasons: string[] = [];
  const concerns: string[] = [];
  const exception = matchingException(job, profile, now);
  const seniority = job.seniority === 'unknown' ? inferSeniorityFromTitle(job.title) : job.seniority;
  const employmentType = job.employmentType === 'unknown' && seniority === 'intern'
    ? 'internship'
    : job.employmentType;

  const excluded = profile.excludedTitles.find((value) => title.includes(normalize(value)));
  if (excluded) reasons.push(`Title matches excluded preference: ${excluded}`);

  const roleAlignment = bestTokenSimilarity(job.title, profile.targetRoles);
  if (profile.targetRoles.length && roleAlignment < 0.25) {
    addConstraintResult(profile.hardConstraints.targetRole, reasons, concerns, 'Title does not align with a target role');
  }

  if (seniority === 'unknown' && !profile.acceptedSeniorities.includes('unknown')) {
    addUnknownResult(profile.hardConstraints.seniority, reviewReasons, concerns, 'Seniority could not be determined');
  } else if (!profile.acceptedSeniorities.includes(seniority)
      && !exception?.allowSeniorities.includes(seniority)) {
    addConstraintResult(profile.hardConstraints.seniority, reasons, concerns, `Seniority ${seniority} is outside accepted levels`);
  }

  if (employmentType === 'unknown' && !profile.acceptedEmploymentTypes.includes('unknown')) {
    addUnknownResult(profile.hardConstraints.employmentType, reviewReasons, concerns, 'Employment type could not be determined');
  } else if (!profile.acceptedEmploymentTypes.includes(employmentType)
      && !exception?.allowEmploymentTypes.includes(employmentType)) {
    addConstraintResult(
      profile.hardConstraints.employmentType,
      reasons,
      concerns,
      `Employment type ${employmentType} is not accepted`
    );
  }

  if (!profile.acceptedWorkModes.includes(job.workMode)) {
    if (job.workMode === 'unknown') {
      addUnknownResult(profile.hardConstraints.workMode, reviewReasons, concerns, 'Work mode could not be determined');
    } else {
      addConstraintResult(profile.hardConstraints.workMode, reasons, concerns, `Work mode ${job.workMode} is not accepted`);
    }
  }

  const location = evaluateLocation(job, profile, exception);
  if (location.status === 'outside') {
    addConstraintResult(profile.hardConstraints.geography, reasons, concerns, location.reason);
  } else if (location.status === 'unknown') {
    addUnknownResult(profile.hardConstraints.geography, reviewReasons, concerns, location.reason);
  }

  if (profile.minimumCompensation && job.compensation) {
    if (profile.minimumCompensation.currency !== job.compensation.currency) {
      concerns.push('Compensation uses a different currency than your configured minimum');
    } else {
      const required = annualize(profile.minimumCompensation);
      const offered = annualize(job.compensation);
      if (required !== undefined && offered !== undefined && offered < required) {
        addConstraintResult(
          profile.hardConstraints.compensation,
          reasons,
          concerns,
          'Known compensation maximum is below the configured minimum'
        );
      }
    }
  } else if (profile.minimumCompensation && !job.compensation) {
    concerns.push('Compensation is not listed');
  }

  if (profile.maxPostingAgeDays && job.postedAt) {
    const ageDays = Math.floor((now.getTime() - new Date(job.postedAt).getTime()) / 86_400_000);
    if (ageDays > profile.maxPostingAgeDays) reasons.push(`Posting is ${ageDays} days old`);
  }

  if (profile.educationLevel) {
    const requiredDegrees = detectRequiredDegrees(`${job.title}\n${job.description}`);
    if (requiredDegrees.size) {
      const edu = profile.educationLevel;
      const qualifies = (edu === 'phd' || edu === 'md') && requiredDegrees.has(edu);
      if (!qualifies) {
        const labels = [...requiredDegrees].map((d) => d === 'phd' ? 'PhD' : 'MD').join('/');
        reasons.push(`Role requires a ${labels} degree — education requirement not met`);
      }
    }
  }

  const disposition = reasons.length
    ? 'outside_preferences'
    : reviewReasons.length
      ? 'needs_review'
      : 'recommended';
  return {
    eligible: disposition === 'recommended',
    disposition,
    reasons,
    reviewReasons,
    concerns
  };
}

export function rankJobForProfile(
  job: NormalizedJob,
  profile: UserMatchingProfile,
  now = new Date()
): Recommendation {
  const eligibility = evaluateEligibility(job, profile, now);
  const breakdown: ScoreBreakdown = {
    skillsEvidence: scoreSkills(job, profile),
    targetRole: round(bestTokenSimilarity(job.title, profile.targetRoles) * 20),
    careerGoals: scoreGoals(job, profile),
    locationWorkMode: scoreLocationAndMode(job, profile),
    compensation: scoreCompensation(job, profile),
    feedbackAffinity: scoreFeedback(job, profile)
  };
  const fitScore = clamp(Math.round(Object.values(breakdown).reduce((sum, value) => sum + value, 0)), 0, 100);
  const strongMatches = buildStrongMatches(job, profile, breakdown);
  const concerns = [...eligibility.concerns, ...buildConcerns(job, profile, breakdown)];
  const timestamp = new Date(job.postedAt || job.firstSeenAt).getTime();
  return RecommendationSchema.parse({
    userId: profile.userId,
    recommendationId: `${profile.userId}#${job.provider}#${job.providerJobId}`,
    jobKey: `${job.provider}#${job.providerJobId}`,
    profileVersion: profile.profileVersion,
    jobContentHash: job.contentHash,
    fitScore,
    scoreBand: scoreBand(fitScore),
    scoreBreakdown: breakdown,
    eligible: eligibility.eligible,
    matchDisposition: eligibility.disposition,
    eligibilityReasons: eligibility.reasons,
    reviewReasons: eligibility.reviewReasons,
    strongMatches,
    concerns,
    applicationAngles: [],
    explanationStatus: 'deterministic',
    status: 'recommended',
    saved: false,
    hiddenByDefault: eligibility.disposition === 'outside_preferences' || fitScore < 50,
    rankTieBreaker: Number.isFinite(timestamp) ? Math.max(0, timestamp) : 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  });
}

export function scoreBand(score: number): ScoreBand {
  if (score >= 80) return 'strong';
  if (score >= 65) return 'good';
  if (score >= 50) return 'possible';
  return 'low';
}

export function feedbackWeight(action: 'saved' | 'dismissed' | 'not_interested' | 'evaluated' | 'applied' | 'restored'): number {
  const weights = {
    saved: 0.35,
    dismissed: -0.3,
    not_interested: -0.8,
    evaluated: 0.55,
    applied: 1,
    restored: 0.15
  };
  return weights[action];
}

export function applyFeedbackToProfile(
  profile: UserMatchingProfile,
  event: FeedbackEvent
): UserMatchingProfile {
  const next = structuredClone(profile);
  const weight = event.weight;
  if (event.dimensions.role) adjust(next.feedbackAffinity.roles, event.dimensions.role, weight);
  if (event.dimensions.company) adjust(next.feedbackAffinity.companies, event.dimensions.company, weight);
  for (const skill of event.dimensions.skills) adjust(next.feedbackAffinity.skills, skill, weight);
  for (const location of event.dimensions.locations) adjust(next.feedbackAffinity.locations, location, weight);
  if (event.dimensions.workMode) {
    const current = next.feedbackAffinity.workModes[event.dimensions.workMode] ?? 0;
    next.feedbackAffinity.workModes[event.dimensions.workMode] = clamp(current + weight * 0.5, -1, 1);
  }
  return next;
}

function scoreSkills(job: NormalizedJob, profile: UserMatchingProfile): number {
  const terms = unique([...profile.skills, ...profile.evidenceKeywords]);
  if (!terms.length) return 15;
  const haystack = normalize(`${job.title} ${job.description}`);
  const matched = terms.filter((term) => includesTerm(haystack, term));
  return round((matched.length / terms.length) * 30);
}

function scoreGoals(job: NormalizedJob, profile: UserMatchingProfile): number {
  if (!profile.careerGoals.length) return 7.5;
  const text = normalize(`${job.title} ${job.description}`);
  const similarities = profile.careerGoals.map((goal) => tokenSimilarity(text, goal));
  return round(Math.max(0, ...similarities) * 15);
}

function scoreLocationAndMode(job: NormalizedJob, profile: UserMatchingProfile): number {
  const mode = profile.acceptedWorkModes.includes(job.workMode)
    ? job.workMode === 'unknown' ? 4 : 7
    : 0;
  if (!profile.targetLocations.length) return mode + 8;
  const locationText = normalize(job.locations.join(' '));
  const location = job.workMode === 'remote' && profile.acceptedWorkModes.includes('remote')
    ? 8
    : Math.max(0, ...profile.targetLocations.map((value) => tokenSimilarity(locationText, value))) * 8;
  return round(mode + location);
}

function scoreCompensation(job: NormalizedJob, profile: UserMatchingProfile): number {
  if (!profile.minimumCompensation) return job.compensation ? 10 : 7;
  if (!job.compensation) return 4;
  if (profile.minimumCompensation.currency !== job.compensation.currency) return 5;
  const required = annualize(profile.minimumCompensation);
  const offered = annualize(job.compensation);
  if (required === undefined || offered === undefined) return 5;
  if (offered >= required) return 10;
  return round(clamp(offered / required, 0, 1) * 10);
}

function scoreFeedback(job: NormalizedJob, profile: UserMatchingProfile): number {
  const affinity = profile.feedbackAffinity;
  const values: number[] = [];
  values.push(bestAffinity(affinity.roles, job.title));
  values.push(affinity.companies[normalize(job.company)] ?? 0);
  values.push(...profile.skills
    .filter((skill) => includesTerm(normalize(`${job.title} ${job.description}`), skill))
    .map((skill) => affinity.skills[normalize(skill)] ?? 0));
  values.push(...job.locations.map((location) => bestAffinity(affinity.locations, location)));
  values.push(affinity.workModes[job.workMode] ?? 0);
  const meaningful = values.filter((value) => value !== 0);
  if (!meaningful.length) return 5;
  const average = meaningful.reduce((sum, value) => sum + value, 0) / meaningful.length;
  return round(((clamp(average, -1, 1) + 1) / 2) * 10);
}

function buildStrongMatches(job: NormalizedJob, profile: UserMatchingProfile, scores: ScoreBreakdown): string[] {
  const reasons: string[] = [];
  if (scores.targetRole >= 14) reasons.push(`Role aligns with ${bestLabel(job.title, profile.targetRoles)}`);
  if (scores.skillsEvidence >= 18) {
    const matched = unique([...profile.skills, ...profile.evidenceKeywords])
      .filter((term) => includesTerm(normalize(`${job.title} ${job.description}`), term))
      .slice(0, 4);
    if (matched.length) reasons.push(`Relevant evidence: ${matched.join(', ')}`);
  }
  if (scores.locationWorkMode >= 12) reasons.push(`${label(job.workMode)} work arrangement fits your preferences`);
  if (scores.compensation >= 9 && job.compensation) reasons.push('Listed compensation meets your preference');
  if (scores.feedbackAffinity >= 7) reasons.push('Similar to roles you previously favored');
  return reasons.slice(0, 5);
}

function buildConcerns(job: NormalizedJob, profile: UserMatchingProfile, scores: ScoreBreakdown): string[] {
  const concerns: string[] = [];
  if (scores.skillsEvidence < 12 && profile.skills.length) concerns.push('Limited overlap with recorded skills and evidence');
  if (scores.targetRole < 10) concerns.push('Role title is only a partial match');
  if (job.workMode === 'unknown') concerns.push('Work mode is not specified');
  if (!job.compensation && profile.minimumCompensation) concerns.push('Verify compensation before investing significant time');
  if (scores.feedbackAffinity < 4) concerns.push('Similar attributes received negative feedback previously');
  return unique(concerns).slice(0, 5);
}

function evaluateLocation(
  job: NormalizedJob,
  profile: UserMatchingProfile,
  exception?: UserMatchingProfile['exceptions'][number]
): { status: 'accepted' | 'outside' | 'unknown'; reason: string } {
  if (profile.remoteLocationPolicy === 'unrestricted' && job.workMode === 'remote') {
    return { status: 'accepted', reason: '' };
  }
  const authorizedCountries = new Set([
    ...profile.authorizedCountries,
    ...(exception?.allowCountries || [])
  ]);
  if (job.countries.length && authorizedCountries.size) {
    const accepted = job.countries.some((country) => authorizedCountries.has(country));
    return accepted
      ? { status: 'accepted', reason: '' }
      : { status: 'outside', reason: `Job countries ${job.countries.join(', ')} are outside authorized countries` };
  }
  const concreteLocations = job.locations.filter((location) => !/^\s*(remote|anywhere)\s*$/i.test(location));
  if (job.workMode === 'remote' && concreteLocations.length === 0) {
    if (profile.remoteLocationPolicy === 'authorized_only' && authorizedCountries.size) {
      return { status: 'unknown', reason: 'Remote job does not specify an authorized country' };
    }
    if (profile.remoteLocationPolicy === 'target_only' && profile.targetLocations.length) {
      return { status: 'unknown', reason: 'Remote job does not specify a target location' };
    }
    return { status: 'accepted', reason: '' };
  }
  if (!profile.authorizedLocations.length && !authorizedCountries.size) {
    return job.locations.length
      ? { status: 'accepted', reason: '' }
      : { status: 'unknown', reason: 'Job location could not be determined' };
  }
  if (!concreteLocations.length) return { status: 'unknown', reason: 'Job location could not be determined' };
  const jobText = normalize(concreteLocations.join(' '));
  return profile.authorizedLocations.some((location) => tokenSimilarity(jobText, location) >= 0.5)
    ? { status: 'accepted', reason: '' }
    : { status: 'unknown', reason: 'Job country could not be verified against authorized locations' };
}

function matchingException(job: NormalizedJob, profile: UserMatchingProfile, now: Date) {
  return profile.exceptions.find((exception) => {
    if (exception.expiresAt && new Date(exception.expiresAt) < now) return false;
    const subject = exception.kind === 'company' ? job.company : job.title;
    return normalize(subject).includes(normalize(exception.value));
  });
}

function inferSeniorityFromTitle(title: string): UserMatchingProfile['acceptedSeniorities'][number] {
  const value = normalize(title);
  if (/\bintern(?:ship)?\b|co op/.test(value)) return 'intern';
  if (/\bchief\b|\bvp\b|vice president|\bcxo\b/.test(value)) return 'executive';
  if (/\bdirector\b|\bhead of\b/.test(value)) return 'director';
  if (/\bmanager\b/.test(value)) return 'manager';
  if (/\bprincipal\b/.test(value)) return 'principal';
  if (/\bstaff\b/.test(value)) return 'staff';
  if (/\blead\b/.test(value)) return 'lead';
  if (/\bsenior\b|\bsr\b/.test(value)) return 'senior';
  if (/\bjunior\b|\bjr\b|\bentry level\b|\bnew grad(?:uate)?\b/.test(value)) return 'entry';
  return 'unknown';
}

function detectRequiredDegrees(text: string): Set<'phd' | 'md'> {
  const required = new Set<'phd' | 'md'>();
  const PHD_TERM = /\bph\.?\s*d\.?\b|\bdoctorate\b|\bdoctoral\b/i;
  const MD_TERM = /\bm\.?d\.?\b|medical\s+degree|doctor\s+of\s+medicine/i;
  const PURSUIT = /\b(?:pursuing|must\s+(?:be\s+)?pursuing|currently\s+pursuing|enrolled\s+in|working\s+toward[s]?)\b/i;
  const REQUIRED = /\b(?:(?<!not\s)required|is\s+required|must\s+have|minimum\s+(?:education|degree|qualification)|candidates?\s+(?:only|must|are\s+required)|students?\s+(?:only|must))\b/i;
  for (const sentence of text.split(/[.!?\n]+/)) {
    if (PURSUIT.test(sentence) || REQUIRED.test(sentence)) {
      if (PHD_TERM.test(sentence)) required.add('phd');
      if (MD_TERM.test(sentence)) required.add('md');
    }
  }
  return required;
}

function addConstraintResult(hard: boolean, reasons: string[], concerns: string[], message: string): void {
  (hard ? reasons : concerns).push(message);
}

function addUnknownResult(hard: boolean, reviewReasons: string[], concerns: string[], message: string): void {
  (hard ? reviewReasons : concerns).push(message);
}

function annualize(compensation: Compensation): number | undefined {
  const value = compensation.max ?? compensation.min;
  if (value === undefined) return undefined;
  const multiplier = {
    hour: 2080,
    day: 260,
    week: 52,
    month: 12,
    year: 1
  }[compensation.interval ?? 'year'];
  return value * multiplier;
}

function bestTokenSimilarity(value: string, candidates: string[]): number {
  if (!candidates.length) return 0.5;
  return Math.max(0, ...candidates.map((candidate) => tokenSimilarity(value, candidate)));
}

function tokenSimilarity(left: string, right: string): number {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...b].filter((token) => a.has(token)).length;
  return intersection / b.size;
}

function bestAffinity(values: Record<string, number>, subject: string): number {
  let best = 0;
  for (const [key, value] of Object.entries(values)) {
    if (tokenSimilarity(subject, key) >= 0.5 && Math.abs(value) > Math.abs(best)) best = value;
  }
  return best;
}

function adjust(values: Record<string, number>, key: string, weight: number): void {
  const normalized = normalize(key);
  values[normalized] = clamp((values[normalized] ?? 0) + weight * 0.5, -1, 1);
}

function bestLabel(value: string, candidates: string[]): string {
  return candidates
    .map((candidate) => ({ candidate, score: tokenSimilarity(value, candidate) }))
    .sort((a, b) => b.score - a.score)[0]?.candidate || 'a target role';
}

function includesTerm(haystack: string, term: string): boolean {
  const needle = normalize(term);
  return needle.length > 1 && haystack.includes(needle);
}

function tokenSet(value: string): Set<string> {
  return new Set(normalize(value).split(' ').filter((token) => token.length > 1));
}

function normalize(value: string): string {
  return String(value || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function unique(values: string[]): string[] {
  return [...new Map(values.map((value) => [normalize(value), value.trim()])).values()].filter(Boolean);
}

function label(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
