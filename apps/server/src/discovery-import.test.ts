import assert from 'node:assert/strict';
import test from 'node:test';
import {
  comparableUrl,
  deduplicateSourceJobs,
  mergeImportedJobs,
  parseDiscoverySource,
  sanitizeDiscoveryJobs
} from './discovery-import.js';

test('parseDiscoverySource extracts GitHub-style markdown job tables', () => {
  const jobs = parseDiscoverySource({
    label: 'example/jobs',
    type: 'markdown',
    sourceUrl: 'https://github.com/example/jobs',
    content: [
      '| Company | Role | Apply | Added |',
      '| --- | --- | --- | --- |',
      '| Acme | Product Intern | [apply](https://jobs.ashbyhq.com/acme/product) | 2026-06-19 |',
      '| ↳ | Data Intern | [apply](https://boards.greenhouse.io/acme/jobs/2) | 2026-06-21 |',
      '| Noise | Community | [Discord](https://discord.gg/example) | 2026-06-22 |'
    ].join('\n')
  });
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[0], {
    url: 'https://jobs.ashbyhq.com/acme/product',
    company: 'Acme',
    role: 'Product Intern',
    datePosted: '2026-06-19',
    location: ''
  });
  assert.equal(jobs[1]?.company, 'Acme');
});

test('parseDiscoverySource handles quoted Google Sheets CSV columns', () => {
  const jobs = parseDiscoverySource({
    label: 'Google Sheets',
    type: 'csv',
    sourceUrl: 'https://docs.google.com/spreadsheets/d/example/edit?gid=0',
    content: [
      'Company,Role Name,Locations,Full Application Link,Date Posted',
      'Example Labs,"AI Intern, Product","New York, NY",https://example.com/careers/jobs/123?from_page=sheet,Jun 22'
    ].join('\n')
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.company, 'Example Labs');
  assert.equal(jobs[0]?.role, 'AI Intern, Product');
  assert.equal(jobs[0]?.url, 'https://example.com/careers/jobs/123?from_page=sheet');
  assert.equal(jobs[0]?.datePosted, '2026-06-22');
  assert.equal(jobs[0]?.location, 'New York, NY');
});

test('parseDiscoverySource extracts generic HTML job tables', () => {
  const jobs = parseDiscoverySource({
    label: 'Example',
    type: 'html',
    sourceUrl: 'https://example.com/internships',
    content: `
      <table>
        <tr><th>Company</th><th>Job title</th><th>Apply</th><th>Posted</th></tr>
        <tr>
          <td>Northstar</td>
          <td>Software Intern</td>
          <td><a href="/careers/jobs/software-intern">Apply</a></td>
          <td>2026-06-20</td>
        </tr>
      </table>
    `
  });
  assert.deepEqual(jobs, [{
    url: 'https://example.com/careers/jobs/software-intern',
    company: 'Northstar',
    role: 'Software Intern',
    datePosted: '2026-06-20',
    location: ''
  }]);
});

test('deduplicate and merge imported jobs preserve unseen postings only', () => {
  const imported = deduplicateSourceJobs([
    { url: 'https://example.com/jobs/1', company: 'Acme', role: 'Intern', datePosted: '', location: '' },
    { url: 'https://example.com/jobs/1#apply', company: 'Acme', role: 'Intern', datePosted: '2026-06-20', location: '' },
    { url: 'https://example.com/jobs/2', company: 'Beta', role: 'Analyst', datePosted: '', location: '' }
  ]);
  assert.equal(imported.length, 2);
  assert.equal(comparableUrl(imported[0]!.url), 'https://example.com/jobs/1');

  const merged = mergeImportedJobs(
    sanitizeDiscoveryJobs([{ url: 'https://example.com/jobs/3', company: 'Saved', role: 'Saved', datePosted: '', location: '' }]),
    imported,
    ['https://example.com/jobs/2']
  );
  assert.equal(merged.added, 1);
  assert.equal(merged.jobs.length, 2);
  assert.equal(merged.jobs.some((job) => comparableUrl(job.url) === 'https://example.com/jobs/2'), false);
});
