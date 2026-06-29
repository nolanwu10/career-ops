import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { NormalizedJobSchema, parseJobSource, type JobSource, type ProviderId } from '@career-ops/shared-types';
import {
  canonicalizeJobUrl,
  computeJobContentHash,
  createHttpClient,
  getProvider,
  inferCountries,
  inferEmploymentType,
  inferSeniority,
  ProviderError,
  scanSource,
  type HttpClient
} from './index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
const fixtures: Record<ProviderId, unknown> = {
  greenhouse: readJson('greenhouse.json'),
  ashby: readJson('ashby.json'),
  lever: readJson('lever.json'),
  workable: fs.readFileSync(path.join(root, 'workable.md'), 'utf8'),
  smartrecruiters: readJson('smartrecruiters.json'),
  recruitee: readJson('recruitee.json')
};

const sourceIds: Record<ProviderId, string> = {
  greenhouse: 'acme',
  ashby: 'acme',
  lever: 'acme',
  workable: 'acme',
  smartrecruiters: 'acme',
  recruitee: 'acme'
};

for (const provider of Object.keys(fixtures) as ProviderId[]) {
  test(`${provider} fixture normalizes against the shared schema`, async () => {
    const source = makeSource(provider);
    const http: HttpClient = {
      fetchJson: async <T>() => fixtures[provider] as T,
      fetchText: async () => String(fixtures[provider])
    };
    const jobs = await scanSource(source, {
      http,
      now: () => new Date('2026-06-19T12:00:00Z'),
      sleep: async () => {}
    });
    assert.equal(jobs.length, 1);
    assert.equal(NormalizedJobSchema.safeParse(jobs[0]).success, true);
    assert.equal(jobs[0]?.sourceId, source.sourceId);
    assert.match(jobs[0]?.contentHash || '', /^[a-f0-9]{64}$/);
  });
}

test('canonical URL removes fragments and tracking parameters deterministically', () => {
  assert.equal(
    canonicalizeJobUrl('https://EXAMPLE.com/jobs/1/?utm_source=x&b=2&a=1#apply'),
    'https://example.com/jobs/1?a=1&b=2'
  );
});

test('content hashes are stable and change with material content', () => {
  const job = {
    provider: 'greenhouse' as const,
    providerJobId: '1',
    company: 'Acme',
    title: 'Engineer',
    description: 'Build systems',
    locations: ['Remote'],
    workMode: 'remote' as const
  };
  assert.equal(computeJobContentHash(job), computeJobContentHash({ ...job }));
  assert.notEqual(computeJobContentHash(job), computeJobContentHash({ ...job, title: 'Staff Engineer' }));
});

test('classification detects internships, seniority, and country restrictions', () => {
  assert.equal(inferEmploymentType('Software Engineer Intern', 'Summer internship'), 'internship');
  assert.equal(inferEmploymentType('Software Engineer', 'This is a full-time position.'), 'full_time');
  assert.equal(inferSeniority('Senior Software Engineer'), 'senior');
  assert.equal(inferSeniority('Software Engineering Intern'), 'intern');
  assert.deepEqual(inferCountries(['Remote - Canada']), ['CA']);
  assert.deepEqual(inferCountries(['New York, NY']), ['US']);
});

test('duplicate provider jobs collapse by stable provider id', async () => {
  const fixture = readJson('greenhouse.json') as any;
  fixture.jobs.push({ ...fixture.jobs[0], title: 'Platform Engineer Updated' });
  const jobs = await scanSource(makeSource('greenhouse'), {
    http: { fetchJson: async <T>() => fixture as T, fetchText: async () => '' },
    now: () => new Date('2026-06-19T12:00:00Z')
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.title, 'Platform Engineer Updated');
});

test('smartrecruiters paginates until a short page', async () => {
  let calls = 0;
  const first = Array.from({ length: 100 }, (_, index) => ({
    id: `job-${index}`,
    name: `Job ${index}`,
    location: { country: 'US' }
  }));
  const jobs = await scanSource(makeSource('smartrecruiters'), {
    http: {
      fetchJson: async <T>() => {
        calls += 1;
        return (calls === 1 ? { content: first } : fixtures.smartrecruiters) as T;
      },
      fetchText: async () => ''
    },
    now: () => new Date('2026-06-19T12:00:00Z')
  });
  assert.equal(calls, 2);
  assert.equal(jobs.length, 101);
});

test('ashby retries transient provider failures', async () => {
  let calls = 0;
  const jobs = await scanSource(makeSource('ashby'), {
    http: {
      fetchJson: async <T>() => {
        calls += 1;
        if (calls < 3) throw new ProviderError('temporary', { code: 'HTTP_429', retryable: true });
        return fixtures.ashby as T;
      },
      fetchText: async () => ''
    },
    sleep: async () => {},
    now: () => new Date('2026-06-19T12:00:00Z')
  });
  assert.equal(calls, 3);
  assert.equal(jobs.length, 1);
});

test('HTTP client rejects non-HTTPS URLs, redirects, oversized bodies, and timeouts', async () => {
  const client = createHttpClient(async (_input, init) => {
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return new Response('x'.repeat(20), { status: 200, headers: { 'content-length': '20' } });
  });
  await assert.rejects(() => client.fetchText('http://example.com'), /Only HTTPS/);
  await assert.rejects(() => client.fetchText('https://example.com', { maxBytes: 5 }), /exceeds 5 bytes/);

  const redirectClient = createHttpClient(async () => new Response('', { status: 302, headers: { location: 'https://evil.example' } }));
  await assert.rejects(() => redirectClient.fetchText('https://example.com'), /HTTP 302/);

  const timeoutClient = createHttpClient(async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
  await assert.rejects(() => timeoutClient.fetchText('https://example.com', { timeoutMs: 1 }), /timed out/);
});

test('provider registry rejects unsupported ids', () => {
  assert.throws(() => getProvider('unknown' as ProviderId), /Unsupported provider/);
});

function makeSource(provider: ProviderId): JobSource {
  return parseJobSource({
    sourceId: `acme-${provider}`,
    provider,
    company: 'Acme',
    boardUrl: boardUrl(provider),
    boardIdentifier: sourceIds[provider],
    cadenceMinutes: ['greenhouse', 'ashby', 'lever'].includes(provider) ? 15 : 30
  });
}

function boardUrl(provider: ProviderId): string {
  const urls: Record<ProviderId, string> = {
    greenhouse: 'https://job-boards.greenhouse.io/acme',
    ashby: 'https://jobs.ashbyhq.com/acme',
    lever: 'https://jobs.lever.co/acme',
    workable: 'https://apply.workable.com/acme',
    smartrecruiters: 'https://jobs.smartrecruiters.com/acme',
    recruitee: 'https://acme.recruitee.com'
  };
  return urls[provider]!;
}

function readJson(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
}
