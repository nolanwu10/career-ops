import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJobSource, type NormalizedJob, type ScanError, type ScanRun, type ScanTask } from '@career-ops/shared-types';
import { ProviderError, type HttpClient } from '@career-ops/job-sources';
import { processScanTask, type ScanRepositoryPort } from './scan-service.js';

const source = parseJobSource({
  sourceId: 'acme-greenhouse',
  provider: 'greenhouse',
  company: 'Acme',
  boardUrl: 'https://job-boards.greenhouse.io/acme',
  boardIdentifier: 'acme',
  cadenceMinutes: 15
});
const task: ScanTask = {
  sourceId: source.sourceId,
  provider: source.provider,
  scheduledAt: '2026-06-19T12:00:00.000Z',
  attempt: 0,
  correlationId: 'b0dbf0bd-18a9-4ac8-a392-a30a236dc58d'
};

class FakeRepository implements ScanRepositoryPort {
  source = { ...source };
  lease = true;
  dispositions: Array<'inserted' | 'updated' | 'unchanged'> = ['inserted'];
  runs: ScanRun[] = [];
  successes = 0;
  failures: ScanError[] = [];
  released = 0;
  jobs: NormalizedJob[] = [];

  async getSource() { return this.source; }
  async acquireLease() { return this.lease; }
  async releaseLease() { this.released += 1; }
  async upsertJob(job: NormalizedJob) {
    this.jobs.push(job);
    return this.dispositions.shift() ?? 'unchanged';
  }
  async recordSuccess() { this.successes += 1; }
  async recordFailure(_source: typeof source, error: ScanError) { this.failures.push(error); }
  async putScanRun(run: ScanRun) { this.runs.push(run); }
}

test('scan task inserts normalized jobs, records health, and releases its lease', async () => {
  const repository = new FakeRepository();
  const result = await processScanTask(task, {
    repository,
    providerContext: { http: greenhouseHttp() },
    now: clock(
      new Date('2026-06-19T12:00:00.000Z'),
      new Date('2026-06-19T12:00:01.000Z')
    )
  });
  assert.equal(result.inserted, 1);
  assert.equal(repository.jobs.length, 1);
  assert.equal(repository.successes, 1);
  assert.equal(repository.runs[0]?.status, 'succeeded');
  assert.equal(repository.released, 1);
});

test('duplicate and changed scans are classified by repository disposition', async () => {
  const repository = new FakeRepository();
  repository.dispositions = ['unchanged', 'updated'];
  const fixture = {
    jobs: [
      { id: 1, title: 'Engineer', absolute_url: 'https://example.com/1' },
      { id: 2, title: 'Manager', absolute_url: 'https://example.com/2' }
    ]
  };
  const result = await processScanTask(task, {
    repository,
    providerContext: {
      http: { fetchJson: async <T>() => fixture as T, fetchText: async () => '' }
    },
    now: clock(new Date('2026-06-19T12:00:00Z'), new Date('2026-06-19T12:00:01Z'))
  });
  assert.equal(result.unchanged, 1);
  assert.equal(result.updated, 1);
});

test('malformed postings are rejected without failing a valid source scan', async () => {
  const repository = new FakeRepository();
  const result = await processScanTask(task, {
    repository,
    providerContext: {
      http: {
        fetchJson: async <T>() => ({
          jobs: [
            { id: 1, title: '', absolute_url: 'https://example.com/invalid' },
            { id: 2, title: 'Engineer', absolute_url: 'https://example.com/valid' }
          ]
        }) as T,
        fetchText: async () => ''
      }
    },
    now: clock(new Date('2026-06-19T12:00:00Z'), new Date('2026-06-19T12:00:01Z'))
  });
  assert.equal(result.inserted, 1);
  assert.equal(result.rejected, 1);
  assert.equal(result.errors[0]?.code, 'MALFORMED_POSTING');
  assert.equal(repository.runs[0]?.status, 'succeeded');
});

test('concurrent task skips when the source lease is held', async () => {
  const repository = new FakeRepository();
  repository.lease = false;
  const result = await processScanTask(task, {
    repository,
    providerContext: { http: greenhouseHttp() },
    now: clock(new Date('2026-06-19T12:00:00Z'), new Date('2026-06-19T12:00:00Z'))
  });
  assert.deepEqual(result, {
    inserted: 0, updated: 0, unchanged: 0, rejected: 0, failed: 0, errors: []
  });
  assert.equal(repository.runs[0]?.status, 'skipped');
  assert.equal(repository.released, 0);
});

test('provider failure records source health and a failed scan run before retrying', async () => {
  const repository = new FakeRepository();
  const error = new ProviderError('rate limited', { code: 'HTTP_429', retryable: true });
  await assert.rejects(() => processScanTask(task, {
    repository,
    providerContext: {
      http: { fetchJson: async <T>() => { throw error; }, fetchText: async () => '' }
    },
    now: clock(new Date('2026-06-19T12:00:00Z'), new Date('2026-06-19T12:00:02Z'))
  }), /rate limited/);
  assert.equal(repository.failures[0]?.code, 'HTTP_429');
  assert.equal(repository.runs[0]?.status, 'failed');
  assert.equal(repository.released, 1);
});

function greenhouseHttp(): HttpClient {
  return {
    fetchJson: async <T>() => ({
      jobs: [{
        id: 1,
        title: 'Engineer',
        absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/1',
        location: { name: 'Remote' }
      }]
    }) as T,
    fetchText: async () => ''
  };
}

function clock(...dates: Date[]): () => Date {
  let index = 0;
  return () => dates[Math.min(index++, dates.length - 1)] ?? new Date();
}
