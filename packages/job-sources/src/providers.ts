import type { Compensation, JobSource } from '@career-ops/shared-types';
import { parseCompensationText } from './normalize.js';
import { ProviderError, type JobProvider, type ProviderContext, type ProviderJob } from './types.js';

function requireHttpsHost(raw: string, allowed: (host: string) => boolean, provider: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError(`${provider}: invalid URL`, { code: 'INVALID_SOURCE', retryable: false });
  }
  if (url.protocol !== 'https:' || !allowed(url.hostname)) {
    throw new ProviderError(`${provider}: untrusted source hostname ${url.hostname}`, {
      code: 'UNTRUSTED_HOST',
      retryable: false
    });
  }
  return url;
}

function isoDate(value: unknown): string | undefined {
  if (!value) return undefined;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function compact<T>(values: Array<T | undefined | null | ''>): T[] {
  return values.filter(Boolean) as T[];
}

export const greenhouseProvider: JobProvider = {
  id: 'greenhouse',
  supports: (source) => source.provider === 'greenhouse',
  async fetch(source, context) {
    const slug = source.boardIdentifier;
    const api = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
    requireHttpsHost(api, (host) => host === 'boards-api.greenhouse.io', 'greenhouse');
    const json = await context.http.fetchJson<any>(api, { redirect: 'error' });
    return (Array.isArray(json?.jobs) ? json.jobs : []).map((job: any): ProviderJob => ({
      providerJobId: String(job.id || ''),
      url: String(job.absolute_url || ''),
      title: String(job.title || ''),
      company: source.company,
      description: String(job.content || ''),
      locations: compact([job.location?.name]),
      postedAt: isoDate(job.updated_at)
    }));
  }
};

export const ashbyProvider: JobProvider = {
  id: 'ashby',
  supports: (source) => source.provider === 'ashby',
  async fetch(source, context) {
    const api = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(source.boardIdentifier)}?includeCompensation=true`;
    requireHttpsHost(api, (host) => host === 'api.ashbyhq.com', 'ashby');
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const json = await context.http.fetchJson<any>(api, { timeoutMs: 30_000, redirect: 'error' });
        return (Array.isArray(json?.jobs) ? json.jobs : []).map((job: any): ProviderJob => ({
          providerJobId: String(job.id || job.jobUrl?.split('/').at(-1) || ''),
          url: String(job.jobUrl || ''),
          title: String(job.title || ''),
          company: source.company,
          description: String(job.descriptionPlain || job.descriptionHtml || ''),
          locations: compact([job.location]),
          workMode: job.isRemote ? 'remote' : undefined,
          compensation: ashbyCompensation(job.compensation),
          postedAt: isoDate(job.publishedAt)
        }));
      } catch (error) {
        lastError = error;
        if (attempt < 2) await (context.sleep ?? defaultSleep)(1000 * 2 ** attempt);
      }
    }
    throw lastError;
  }
};

function ashbyCompensation(value: any): Compensation | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return parseCompensationText(value);
  const summary = value.compensationTierSummary || value.scrapeableCompensationSalarySummary;
  return parseCompensationText(summary);
}

export const leverProvider: JobProvider = {
  id: 'lever',
  supports: (source) => source.provider === 'lever',
  async fetch(source, context) {
    const api = `https://api.lever.co/v0/postings/${encodeURIComponent(source.boardIdentifier)}?mode=json`;
    requireHttpsHost(api, (host) => host === 'api.lever.co', 'lever');
    const json = await context.http.fetchJson<any>(api, { redirect: 'error' });
    return (Array.isArray(json) ? json : []).map((job: any): ProviderJob => ({
      providerJobId: String(job.id || ''),
      url: String(job.hostedUrl || ''),
      title: String(job.text || ''),
      company: source.company,
      description: String(job.descriptionPlain || job.description || ''),
      locations: compact([job.categories?.location]),
      workMode: String(job.workplaceType || '').toLowerCase() === 'remote' ? 'remote' : undefined,
      compensation: parseCompensationText(job.salaryRange
        ? `${job.salaryRange.currency || 'USD'} ${job.salaryRange.min}-${job.salaryRange.max} per ${job.salaryRange.interval || 'year'}`
        : undefined),
      postedAt: typeof job.createdAt === 'number' ? new Date(job.createdAt).toISOString() : undefined
    }));
  }
};

export const workableProvider: JobProvider = {
  id: 'workable',
  supports: (source) => source.provider === 'workable',
  async fetch(source, context) {
    const api = `https://apply.workable.com/${encodeURIComponent(source.boardIdentifier)}/jobs.md`;
    requireHttpsHost(api, (host) => host === 'apply.workable.com', 'workable');
    return parseWorkableMarkdown(await context.http.fetchText(api, { redirect: 'error' }), source);
  }
};

export function parseWorkableMarkdown(text: string, source: JobSource): ProviderJob[] {
  const jobs: ProviderJob[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('|') || !line.includes('[View]')) continue;
    const columns = line.split('|').map((value) => value.trim());
    const title = columns[1];
    if (!title || title === 'Title') continue;
    const rawUrl = line.match(/\[View\]\(([^)]+)\)/)?.[1]?.replace(/\.md$/, '');
    if (!rawUrl) continue;
    const url = requireHttpsHost(rawUrl, (host) => host === 'apply.workable.com', 'workable');
    const id = url.pathname.match(/\/jobs\/view\/([^/]+)/)?.[1];
    jobs.push({
      providerJobId: id || '',
      url: url.toString(),
      title,
      company: source.company,
      locations: compact([columns[3]]),
      compensation: parseCompensationText(columns[5]),
      postedAt: isoDate(columns[6])
    });
  }
  return jobs;
}

const SMART_PAGE_SIZE = 100;
export const smartRecruitersProvider: JobProvider = {
  id: 'smartrecruiters',
  supports: (source) => source.provider === 'smartrecruiters',
  async fetch(source, context) {
    const jobs: ProviderJob[] = [];
    for (let page = 0; page < 50; page += 1) {
      const offset = page * SMART_PAGE_SIZE;
      const api = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(source.boardIdentifier)}/postings?limit=${SMART_PAGE_SIZE}&offset=${offset}&status=PUBLIC`;
      requireHttpsHost(api, (host) => host === 'api.smartrecruiters.com', 'smartrecruiters');
      const json = await context.http.fetchJson<any>(api, { redirect: 'error' });
      const items = Array.isArray(json?.content) ? json.content : [];
      for (const job of items) {
        const location = job.location || {};
        const locations = compact([
          location.fullLocation || [location.city, location.region, location.country].filter(Boolean).join(', '),
          location.remote ? 'Remote' : ''
        ]);
        jobs.push({
          providerJobId: String(job.id || ''),
          url: `https://jobs.smartrecruiters.com/${source.boardIdentifier}/${job.id}`,
          title: String(job.name || ''),
          company: source.company,
          locations,
          workMode: location.remote ? 'remote' : undefined,
          postedAt: isoDate(job.releasedDate)
        });
      }
      if (items.length < SMART_PAGE_SIZE) break;
    }
    return jobs;
  }
};

const RECRUITEE_HOST = /^[a-z0-9][a-z0-9-]*\.recruitee\.com$/;
export const recruiteeProvider: JobProvider = {
  id: 'recruitee',
  supports: (source) => source.provider === 'recruitee',
  async fetch(source, context) {
    const api = `https://${source.boardIdentifier}.recruitee.com/api/offers/`;
    requireHttpsHost(api, (host) => RECRUITEE_HOST.test(host), 'recruitee');
    const json = await context.http.fetchJson<any>(api, { redirect: 'error' });
    return (Array.isArray(json?.offers) ? json.offers : []).map((job: any): ProviderJob => {
      const rawUrl = String(job.careers_url || job.url || '');
      if (rawUrl) requireHttpsHost(rawUrl, (host) => RECRUITEE_HOST.test(host), 'recruitee');
      return {
        providerJobId: String(job.id || rawUrl.split('/').filter(Boolean).at(-1) || ''),
        url: rawUrl,
        title: String(job.title || ''),
        company: source.company,
        description: String(job.description || ''),
        locations: compact([job.location || [job.city, job.country].filter(Boolean).join(', '), job.remote ? 'Remote' : '']),
        workMode: job.remote ? 'remote' : undefined,
        postedAt: isoDate(job.published_at || job.created_at)
      };
    });
  }
};

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export const providers = [
  greenhouseProvider,
  ashbyProvider,
  leverProvider,
  workableProvider,
  smartRecruitersProvider,
  recruiteeProvider
] satisfies JobProvider[];
