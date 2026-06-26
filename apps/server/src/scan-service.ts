import { randomUUID } from 'node:crypto';
import { scanSource, ProviderError, type ProviderContext } from '@career-ops/job-sources';
import {
  ScanRunSchema,
  type JobSource,
  type ScanError,
  type ScanResult,
  type ScanTask
} from '@career-ops/shared-types';
import { emptyScanResult } from './repository.js';

const RUN_TTL_DAYS = 90;

export interface ScanDependencies {
  repository: ScanRepositoryPort;
  providerContext?: Partial<ProviderContext>;
  now?: () => Date;
  emitMetrics?: (result: ScanResult, durationMs: number, failed: boolean) => void;
  log?: (record: Record<string, unknown>) => void;
}

export interface ScanRepositoryPort {
  getSource(sourceId: string): Promise<JobSource | null>;
  acquireLease(sourceId: string, owner: string, now: Date, leaseSeconds?: number): Promise<boolean>;
  releaseLease(sourceId: string, owner: string): Promise<void>;
  upsertJob(job: import('@career-ops/shared-types').NormalizedJob): Promise<'inserted' | 'updated' | 'unchanged'>;
  recordSuccess(source: JobSource, completedAt: Date): Promise<void>;
  recordFailure(source: JobSource, error: ScanError, completedAt: Date): Promise<void>;
  putScanRun(run: import('@career-ops/shared-types').ScanRun): Promise<void>;
}

export async function processScanTask(task: ScanTask, dependencies: ScanDependencies): Promise<ScanResult> {
  const now = dependencies.now ?? (() => new Date());
  const started = now();
  const leaseOwner = `${task.correlationId}:${randomUUID()}`;
  const result = emptyScanResult();
  let source: JobSource | null = null;
  let acquired = false;
  try {
    source = await dependencies.repository.getSource(task.sourceId);
    if (!source) throw new ProviderError(`Unknown source: ${task.sourceId}`, { code: 'SOURCE_NOT_FOUND', retryable: false });
    if (!source.enabled) {
      await writeRun('skipped');
      return result;
    }
    if (source.provider !== task.provider) {
      throw new ProviderError(`Task provider does not match source ${source.sourceId}`, {
        code: 'PROVIDER_MISMATCH',
        retryable: false
      });
    }
    acquired = await dependencies.repository.acquireLease(source.sourceId, leaseOwner, started);
    if (!acquired) {
      dependencies.log?.({ level: 'info', event: 'scan_skipped_lease', ...logContext(task) });
      await writeRun('skipped');
      return result;
    }

    const jobs = await scanSource(source, {
      ...dependencies.providerContext,
      now,
      onRejected(error, job) {
        result.rejected += 1;
        result.errors.push({
          code: 'MALFORMED_POSTING',
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
          providerJobId: job.providerJobId || undefined
        });
        dependencies.providerContext?.onRejected?.(error, job);
      }
    });
    for (const job of jobs) {
      try {
        const disposition = await dependencies.repository.upsertJob(job);
        result[disposition] += 1;
      } catch (error) {
        result.failed += 1;
        result.errors.push(toScanError(error, job.providerJobId));
      }
    }
    const completed = now();
    await dependencies.repository.recordSuccess(source, completed);
    await writeRun('succeeded', completed);
    dependencies.emitMetrics?.(result, completed.getTime() - started.getTime(), false);
    dependencies.log?.({ level: 'info', event: 'scan_succeeded', ...logContext(task), result });
    return result;
  } catch (error) {
    const completed = now();
    const scanError = toScanError(error);
    result.failed += 1;
    result.errors.push(scanError);
    if (source) await dependencies.repository.recordFailure(source, scanError, completed);
    await writeRun('failed', completed, scanError);
    dependencies.emitMetrics?.(result, completed.getTime() - started.getTime(), true);
    dependencies.log?.({ level: 'error', event: 'scan_failed', ...logContext(task), error: scanError });
    throw error;
  } finally {
    if (source && acquired) await dependencies.repository.releaseLease(source.sourceId, leaseOwner);
  }

  async function writeRun(
    status: 'succeeded' | 'failed' | 'skipped',
    completed = now(),
    error?: ScanError
  ): Promise<void> {
    await dependencies.repository.putScanRun(ScanRunSchema.parse({
      sourceId: task.sourceId,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      correlationId: task.correlationId,
      provider: task.provider,
      status,
      durationMs: completed.getTime() - started.getTime(),
      result,
      error,
      expiresAt: Math.floor(completed.getTime() / 1000) + RUN_TTL_DAYS * 86400
    }));
  }
}

function toScanError(error: unknown, providerJobId?: string): ScanError {
  if (error instanceof ProviderError) {
    return { code: error.code, message: error.message, retryable: error.retryable, providerJobId };
  }
  return {
    code: 'UNEXPECTED_ERROR',
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
    providerJobId
  };
}

function logContext(task: ScanTask): Record<string, unknown> {
  return {
    correlationId: task.correlationId,
    sourceId: task.sourceId,
    provider: task.provider,
    scheduledAt: task.scheduledAt
  };
}
