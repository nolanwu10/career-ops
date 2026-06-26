import type { JobSource, NormalizedJob, ProviderId } from '@career-ops/shared-types';
import { createHttpClient } from './http-client.js';
import { normalizeProviderJob } from './normalize.js';
import { providers } from './providers.js';
import { ProviderError, type JobProvider, type ProviderContext } from './types.js';

export * from './http-client.js';
export * from './normalize.js';
export * from './providers.js';
export * from './types.js';

const registry = new Map<ProviderId, JobProvider>(providers.map((provider) => [provider.id, provider]));

export function getProvider(providerId: ProviderId): JobProvider {
  const provider = registry.get(providerId);
  if (!provider) {
    throw new ProviderError(`Unsupported provider: ${providerId}`, {
      code: 'UNSUPPORTED_PROVIDER',
      retryable: false
    });
  }
  return provider;
}

export async function scanSource(source: JobSource, context: Partial<ProviderContext> = {}): Promise<NormalizedJob[]> {
  const provider = getProvider(source.provider);
  if (!provider.supports(source)) {
    throw new ProviderError(`${source.provider} does not support source ${source.sourceId}`, {
      code: 'UNSUPPORTED_SOURCE',
      retryable: false
    });
  }
  const effectiveContext: ProviderContext = {
    http: context.http ?? createHttpClient(),
    now: context.now ?? (() => new Date()),
    sleep: context.sleep,
    onRejected: context.onRejected
  };
  const fetched = await provider.fetch(source, effectiveContext);
  const normalized = new Map<string, NormalizedJob>();
  for (const job of fetched) {
    try {
      const item = normalizeProviderJob(source, job, effectiveContext.now?.() ?? new Date());
      normalized.set(`${item.provider}#${item.providerJobId}`, item);
    } catch (error) {
      effectiveContext.onRejected?.(error, job);
    }
  }
  return [...normalized.values()];
}
