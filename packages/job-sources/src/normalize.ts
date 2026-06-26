import { createHash } from 'node:crypto';
import { parseNormalizedJob, type Compensation, type JobSource, type NormalizedJob } from '@career-ops/shared-types';
import type { ProviderJob } from './types.js';

const TRACKING_PARAMS = new Set([
  'gh_src', 'source', 'ref', 'referrer', 'utm_campaign', 'utm_content',
  'utm_medium', 'utm_source', 'utm_term'
]);

export function canonicalizeJobUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Job URL must use HTTP or HTTPS');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  const sorted = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  url.search = '';
  for (const [key, value] of sorted) url.searchParams.append(key, value);
  return url.toString();
}

export function normalizeLocations(values: string[] = []): string[] {
  const locations = values
    .flatMap((value) => String(value || '').split(/\s*[;|]\s*/))
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return [...new Map(locations.map((value) => [value.toLowerCase(), value])).values()];
}

export function inferWorkMode(locations: string[], explicit?: NormalizedJob['workMode']): NormalizedJob['workMode'] {
  if (explicit && explicit !== 'unknown') return explicit;
  const text = locations.join(' ').toLowerCase();
  if (/\bhybrid\b/.test(text)) return 'hybrid';
  if (/\bremote\b|anywhere/.test(text)) return 'remote';
  if (/\bon[- ]?site\b|\boffice\b/.test(text)) return 'onsite';
  return 'unknown';
}

export function inferEmploymentType(title: string, description = '', explicit?: NormalizedJob['employmentType']): NormalizedJob['employmentType'] {
  if (explicit && explicit !== 'unknown') return explicit;
  const text = `${title} ${description}`.toLowerCase();
  if (/\bintern(?:ship)?\b|co-?op|summer associate|currently pursuing (?:a |an )?(?:degree|bachelor|master)/.test(text)) return 'internship';
  if (/\bapprentice(?:ship)?\b/.test(text)) return 'apprenticeship';
  if (/\bpart[- ]time\b/.test(text)) return 'part_time';
  if (/\bcontract(?:or)?\b|fixed[- ]term|1099/.test(text)) return 'contract';
  if (/\btemporary\b|\btemp\b/.test(text)) return 'temporary';
  if (/\bfull[- ]time\b/.test(text)) return 'full_time';
  return 'unknown';
}

export function inferSeniority(title: string, description = '', explicit?: NormalizedJob['seniority']): NormalizedJob['seniority'] {
  if (explicit && explicit !== 'unknown') return explicit;
  const value = `${title} ${description.slice(0, 500)}`.toLowerCase();
  if (/\bintern(?:ship)?\b|co-?op/.test(value)) return 'intern';
  if (/\bchief\b|\bvp\b|vice president|\bcxo\b/.test(value)) return 'executive';
  if (/\bdirector\b|\bhead of\b/.test(value)) return 'director';
  if (/\bmanager\b/.test(value)) return 'manager';
  if (/\bprincipal\b/.test(value)) return 'principal';
  if (/\bstaff\b/.test(value)) return 'staff';
  if (/\blead\b/.test(value)) return 'lead';
  if (/\bsenior\b|\bsr\.?\b/.test(value)) return 'senior';
  if (/\bjunior\b|\bjr\.?\b|\bentry[- ]level\b|\bnew grad(?:uate)?\b/.test(value)) return 'entry';
  return 'unknown';
}

export function inferCountries(locations: string[], explicit: string[] = []): string[] {
  const countries = new Set(explicit.map((value) => value.toUpperCase()));
  const text = locations.join(' | ').toLowerCase();
  const mappings: Array<[RegExp, string]> = [
    [/\b(?:united states|usa|u\.s\.|us only)\b|,\s*(?:al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)\b/i, 'US'],
    [/\bcanada\b|,\s*(?:on|qc|bc|ab|mb|nb|nl|ns|nt|nu|pe|sk|yt)\b/i, 'CA'],
    [/\bunited kingdom\b|\buk\b|\bengland\b|\bscotland\b|\bwales\b/i, 'GB'],
    [/\bfrance\b/i, 'FR'],
    [/\bgermany\b/i, 'DE'],
    [/\bindia\b/i, 'IN'],
    [/\baustralia\b/i, 'AU'],
    [/\bireland\b/i, 'IE'],
    [/\bspain\b/i, 'ES'],
    [/\bnetherlands\b/i, 'NL']
  ];
  for (const [pattern, code] of mappings) if (pattern.test(text)) countries.add(code);
  return [...countries];
}

export function parseCompensationText(text: string | undefined): Compensation | undefined {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return undefined;
  const currency = /\bEUR\b|€/.test(raw) ? 'EUR'
    : /\bGBP\b|£/.test(raw) ? 'GBP'
      : /\bCAD\b/.test(raw) ? 'CAD'
        : 'USD';
  const interval = /\/\s*(?:hr|hour)|per hour/i.test(raw) ? 'hour'
    : /\/\s*month|per month/i.test(raw) ? 'month'
      : /\/\s*week|per week/i.test(raw) ? 'week'
        : /\/\s*day|per day/i.test(raw) ? 'day'
          : 'year';
  const numbers = [...raw.matchAll(/(?:[$€£]\s*)?(\d[\d,.]*)(\s*[kK])?/g)]
    .map((match) => Number(match[1]?.replaceAll(',', '')) * (match[2] ? 1000 : 1))
    .filter(Number.isFinite);
  if (!numbers.length) return { currency, interval, text: raw };
  return {
    currency,
    min: numbers[0],
    max: numbers[1],
    interval,
    text: raw
  };
}

export function computeJobContentHash(job: Pick<NormalizedJob,
  'provider' | 'providerJobId' | 'company' | 'title' | 'description' | 'locations' | 'workMode'
> & Partial<Pick<NormalizedJob, 'compensation' | 'postedAt' | 'employmentType' | 'seniority' | 'countries'>>): string {
  const stable = JSON.stringify({
    provider: job.provider,
    providerJobId: job.providerJobId,
    company: job.company.trim(),
    title: job.title.trim(),
    description: job.description.trim(),
    locations: [...job.locations].sort(),
    workMode: job.workMode,
    employmentType: job.employmentType,
    seniority: job.seniority,
    countries: job.countries,
    compensation: job.compensation,
    postedAt: job.postedAt
  });
  return createHash('sha256').update(stable).digest('hex');
}

export function normalizeProviderJob(source: JobSource, job: ProviderJob, now = new Date()): NormalizedJob {
  const canonicalUrl = canonicalizeJobUrl(job.url);
  const locations = normalizeLocations(job.locations);
  const employmentType = inferEmploymentType(job.title, job.description, job.employmentType);
  const seniority = inferSeniority(job.title, job.description, job.seniority);
  const countries = inferCountries(locations, job.countries);
  const evidence = [
    employmentType !== 'unknown' ? `Employment type inferred as ${employmentType}` : '',
    seniority !== 'unknown' ? `Seniority inferred as ${seniority}` : '',
    countries.length ? `Countries inferred as ${countries.join(', ')}` : ''
  ].filter(Boolean);
  const base = {
    provider: source.provider,
    providerJobId: job.providerJobId.trim(),
    sourceId: source.sourceId,
    canonicalUrl,
    company: (job.company || source.company).trim(),
    title: job.title.trim(),
    description: String(job.description || '').trim(),
    locations,
    workMode: inferWorkMode(locations, job.workMode),
    employmentType,
    seniority,
    countries,
    classificationConfidence: evidence.length ? 0.85 : 0,
    classificationEvidence: evidence,
    compensation: job.compensation,
    postedAt: job.postedAt,
    firstSeenAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    status: 'active' as const
  };
  return parseNormalizedJob({ ...base, contentHash: computeJobContentHash(base) });
}
