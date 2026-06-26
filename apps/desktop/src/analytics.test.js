const assert = require('node:assert/strict');
const test = require('node:test');

const {
  computeAdvancedAnalytics,
  classifyRejection,
  responseByScoreBucket,
  staleHighFitJobs
} = require('./analytics');

const apps = [
  {
    number: 1,
    date: '2026-05-01',
    company: 'Acme',
    role: 'AI Analytics Intern',
    score: 4.6,
    status: 'Evaluated',
    notes: 'Remote. Strong LLM analytics match.',
    jobUrl: 'https://job-boards.greenhouse.io/acme/jobs/1',
    lastContact: '2026-05-01'
  },
  {
    number: 2,
    date: '2026-05-03',
    company: 'Beta',
    role: 'Data Science Intern',
    score: 4.2,
    status: 'Applied',
    notes: 'Applied through Ashby.',
    jobUrl: 'https://jobs.ashbyhq.com/beta/2',
    lastContact: '2026-05-03'
  },
  {
    number: 3,
    date: '2026-05-04',
    company: 'Beta',
    role: 'ML Intern',
    score: 4.1,
    status: 'Responded',
    notes: 'Recruiter responded 2026-05-08.',
    jobUrl: 'https://jobs.ashbyhq.com/beta/3',
    lastContact: '2026-05-08'
  },
  {
    number: 4,
    date: '2026-05-05',
    company: 'Gamma',
    role: 'Research Intern',
    score: 2.8,
    status: 'SKIP',
    notes: 'Research pubs required, PyTorch gap, grad year mismatch.',
    jobUrl: 'https://jobs.lever.co/gamma/4',
    lastContact: '2026-05-05'
  },
  {
    number: 5,
    date: '2026-05-06',
    company: 'Delta',
    role: 'Analytics Intern',
    score: 3.7,
    status: 'Rejected',
    notes: 'Role closed and posting appears filled.',
    jobUrl: 'https://job-boards.greenhouse.io/delta/jobs/5',
    lastContact: '2026-05-10'
  }
];

const scanHistory = [
  { url: 'https://job-boards.greenhouse.io/acme/jobs/1', firstSeen: '2026-05-01', portal: 'greenhouse-search-1', title: 'AI Analytics Intern', company: 'Acme', status: 'added' },
  { url: 'https://jobs.ashbyhq.com/beta/2', firstSeen: '2026-05-03', portal: 'ashby-search-1', title: 'Data Science Intern', company: 'Beta', status: 'added' },
  { url: 'https://jobs.ashbyhq.com/beta/3', firstSeen: '2026-05-04', portal: 'ashby-search-1', title: 'ML Intern', company: 'Beta', status: 'added' },
  { url: 'https://jobs.lever.co/gamma/4', firstSeen: '2026-05-05', portal: 'lever-search-1', title: 'Research Intern', company: 'Gamma', status: 'added' },
  { url: 'https://job-boards.greenhouse.io/delta/jobs/5', firstSeen: '2026-05-06', portal: 'greenhouse-search-1', title: 'Analytics Intern', company: 'Delta', status: 'expired' }
];

test('responseByScoreBucket measures response rate by applied jobs in each score band', () => {
  const buckets = responseByScoreBucket(apps);
  const high = buckets.find((bucket) => bucket.label === '4.0-4.4');

  assert.equal(high.evaluated, 2);
  assert.equal(high.applied, 2);
  assert.equal(high.responded, 1);
  assert.equal(high.responseRate, 50);
});

test('staleHighFitJobs returns unapplied high-fit evaluated jobs older than two weeks', () => {
  const stale = staleHighFitJobs(apps, new Date('2026-06-11T12:00:00'));

  assert.equal(stale.length, 1);
  assert.equal(stale[0].number, 1);
  assert.equal(stale[0].ageDays, 41);
});

test('classifyRejection detects closed postings before generic low-fit reasons', () => {
  const reason = classifyRejection(apps[4]);

  assert.deepEqual(reason, { key: 'closed', label: 'Closed or filled' });
});

test('computeAdvancedAnalytics ranks source quality and builds recommendations', () => {
  const analytics = computeAdvancedAnalytics(apps, {
    scanHistory,
    pendingJobs: [
      { url: 'https://jobs.ashbyhq.com/beta/6', portal: 'ashby-search-1', company: 'Beta', role: 'Product Data Intern', firstSeen: '2026-06-10', ageDays: 1, alreadyTracked: false }
    ],
    now: new Date('2026-06-11T12:00:00')
  });

  assert.equal(analytics.sourceQuality.byPortal[0].label, 'ashby-search-1');
  assert.equal(analytics.sourceQuality.byCompany[0].label, 'Beta');
  assert.equal(analytics.rejectionReasons[0].label, 'Closed or filled');
  assert.ok(analytics.recommendations.some((item) => item.title.includes('strongest evaluated')));
});
