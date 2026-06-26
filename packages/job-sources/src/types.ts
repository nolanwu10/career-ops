import type { Compensation, JobSource, NormalizedJob, ProviderId } from '@career-ops/shared-types';

export interface HttpRequestOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  redirect?: 'error' | 'follow' | 'manual';
  maxBytes?: number;
}

export interface HttpClient {
  fetchJson<T = unknown>(url: string, options?: HttpRequestOptions): Promise<T>;
  fetchText(url: string, options?: HttpRequestOptions): Promise<string>;
}

export interface ProviderContext {
  http: HttpClient;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  onRejected?: (error: unknown, job: ProviderJob) => void;
}

export interface ProviderJob {
  providerJobId: string;
  url: string;
  title: string;
  company?: string;
  description?: string;
  locations?: string[];
  workMode?: NormalizedJob['workMode'];
  employmentType?: NormalizedJob['employmentType'];
  seniority?: NormalizedJob['seniority'];
  countries?: string[];
  compensation?: Compensation;
  postedAt?: string;
}

export interface JobProvider {
  id: ProviderId;
  supports(source: JobSource): boolean;
  fetch(source: JobSource, context: ProviderContext): Promise<ProviderJob[]>;
}

export class ProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: { code?: string; retryable?: boolean; status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
    this.code = options.code ?? 'PROVIDER_ERROR';
    this.retryable = options.retryable ?? true;
    this.status = options.status;
  }
}
