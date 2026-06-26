const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'career-ops-extension-'));
process.env.CAREER_OPS_ROOT = tempRoot;
process.env.CAREER_OPS_USER_DATA = path.join(tempRoot, '.settings');
process.env.CAREER_OPS_APP_DATA = path.join(tempRoot, '.app-data');

for (const name of ['merge-tracker.mjs', 'tracker-links.mjs']) {
  fs.copyFileSync(path.join(__dirname, '..', 'test', 'fixtures', name), path.join(tempRoot, name));
}
fs.mkdirSync(path.join(tempRoot, 'data'), { recursive: true });
fs.mkdirSync(path.join(tempRoot, 'batch', 'tracker-additions'), { recursive: true });
fs.writeFileSync(path.join(tempRoot, 'scan.mjs'), '');
fs.writeFileSync(path.join(tempRoot, 'portals.yml'), 'title_filter:\n  positive: []\n');
fs.writeFileSync(path.join(tempRoot, 'cv.md'), '# Test CV\n');
fs.mkdirSync(path.join(tempRoot, 'config'), { recursive: true });
fs.writeFileSync(path.join(tempRoot, 'config', 'profile.yml'), 'candidate:\n  full_name: Test User\n  email: test@example.com\n');
fs.writeFileSync(path.join(tempRoot, 'data', 'applications.md'), [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|'
].join('\n'));

const core = require('./app-core');
const sqliteStore = require('./storage/sqlite-store');

test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

test('parseScoreField keeps N/A distinct from a zero score', () => {
  assert.deepEqual(core.parseScoreField('N/A'), { score: null, isScored: false, scoreRaw: 'N/A' });
  assert.deepEqual(core.parseScoreField('0.0/5'), { score: 0, isScored: true, scoreRaw: '0.0/5' });
});

test('validateExternalApplication normalizes fields and rejects invalid URLs', () => {
  const value = core.validateExternalApplication({
    url: 'https://example.com/jobs/1#apply',
    company: ' Example Inc. ',
    role: ' Data Intern ',
    appliedAt: '2026-06-17',
    source: 'manual'
  });
  assert.equal(value.url, 'https://example.com/jobs/1');
  assert.equal(value.company, 'Example Inc.');
  assert.throws(() => core.validateExternalApplication({ url: 'file:///tmp/job', company: 'A', role: 'B' }), /HTTP or HTTPS/);
});

test('extractPageTitle and deriveJobIdentity identify pasted ATS links', () => {
  const title = core.extractPageTitle('<html><head><meta property="og:title" content="Data Science Intern - Example Labs"></head></html>');
  assert.equal(title, 'Data Science Intern - Example Labs');
  assert.deepEqual(
    core.deriveJobIdentity('https://jobs.ashbyhq.com/example-labs/12345678-1234-1234-1234-123456789012', title),
    { company: 'Example Labs', role: 'Data Science Intern' }
  );
  assert.deepEqual(
    core.deriveJobIdentity('https://job-boards.greenhouse.io/acme/jobs/12345'),
    { company: 'Acme', role: 'Job posting' }
  );
});

test('addPendingJobLink writes a pasted link once and returns it in Discovery', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    async text() {
      return '<html><head><title>Machine Learning Intern - Acme</title></head></html>';
    }
  });
  try {
    const first = await core.addPendingJobLink({ url: 'https://jobs.ashbyhq.com/acme/12345678-1234-1234-1234-123456789012#apply' });
    assert.equal(first.ok, true);
    assert.equal(first.duplicate, false);
    assert.equal(first.job.company, 'Acme');
    assert.equal(first.job.role, 'Machine Learning Intern');
    assert.equal(first.dashboard.pendingJobs.length, 1);

    const second = await core.addPendingJobLink({ url: 'https://jobs.ashbyhq.com/acme/12345678-1234-1234-1234-123456789012' });
    assert.equal(second.duplicate, true);
    const pipeline = fs.readFileSync(path.join(tempRoot, 'data', 'pipeline.md'), 'utf8');
    assert.equal((pipeline.match(/jobs\.ashbyhq\.com/g) || []).length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('parseDiscoverySource extracts GitHub-style markdown job tables', () => {
  const jobs = core.parseDiscoverySource({
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
  assert.equal(jobs[1].company, 'Acme');
});

test('parseDiscoverySource handles quoted Google Sheets CSV columns', () => {
  const jobs = core.parseDiscoverySource({
    type: 'csv',
    sourceUrl: 'https://docs.google.com/spreadsheets/d/example/edit?gid=0',
    content: [
      'Company,Role Name,Locations,Full Application Link,Date Posted',
      'Example Labs,\"AI Intern, Product\",\"New York, NY\",https://example.com/careers/jobs/123?from_page=sheet,Jun 22'
    ].join('\n')
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].company, 'Example Labs');
  assert.equal(jobs[0].role, 'AI Intern, Product');
  assert.equal(jobs[0].url, 'https://example.com/careers/jobs/123?from_page=sheet');
  assert.equal(jobs[0].datePosted, '2026-06-22');
  assert.equal(jobs[0].location, 'New York, NY');
});

test('parseDiscoverySource extracts generic HTML job tables', () => {
  const jobs = core.parseDiscoverySource({
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

test('rankDiscoveryJobs prioritizes recent target roles and reports days ago', () => {
  const ranked = core.rankDiscoveryJobs([
    {
      url: 'https://example.com/jobs/old',
      company: 'Example',
      role: 'Product Manager Intern',
      location: 'New York, NY',
      datePosted: '2026-05-01'
    },
    {
      url: 'https://example.com/jobs/recent',
      company: 'Example',
      role: 'AI Product Management Intern',
      location: 'Remote',
      datePosted: '2026-06-22'
    }
  ], {
    profile: {
      target_roles: { primary: ['AI Product Manager'] },
      location: { target_locations: ['New York'] }
    },
    titleKeywords: ['product management', 'artificial intelligence'],
    resume: 'Product strategy, AI analytics, roadmap, and customer discovery.'
  });
  assert.equal(ranked[0].url, 'https://example.com/jobs/recent');
  assert.equal(ranked[0].postedDaysAgo >= 0, true);
  assert.equal(ranked[0].recommendationScore > ranked[1].recommendationScore, true);
  assert.match(ranked[0].recommendationReason, /Recently posted|Matches/);
});

test('rankDiscoveryJobs generically excludes roles unrelated to user intent', () => {
  const ranked = core.rankDiscoveryJobs([
    {
      url: 'https://example.com/jobs/unrelated',
      company: 'Example',
      role: 'Museum Collections Curator',
      location: 'Boston, MA',
      datePosted: '2026-06-22'
    },
    {
      url: 'https://example.com/jobs/product',
      company: 'Software Co',
      role: 'AI Product Management Intern',
      location: 'New York, NY',
      datePosted: '2026-06-20'
    }
  ], {
    profile: { target_roles: { primary: ['AI Product Manager'] } },
    titleKeywords: ['product management', 'technology'],
    resume: 'Product strategy, AI analytics, customer discovery, and software projects.'
  });
  const unrelated = ranked.find((job) => job.url.endsWith('/unrelated'));
  const product = ranked.find((job) => job.url.endsWith('/product'));
  assert.equal(unrelated.isRelevant, false);
  assert.equal(product.isRelevant, true);
  assert.equal(ranked[0].url, product.url);
});

test('rankDiscoveryJobs does not accept a long unrelated title from one target word', () => {
  const [job] = core.rankDiscoveryJobs([{
    url: 'https://example.com/jobs/catalog',
    company: 'Example',
    role: 'Museum Product Catalog Preservation Operations Coordinator',
    datePosted: '2026-06-22'
  }], {
    profile: { target_roles: { primary: ['Product Manager'] } },
    titleKeywords: ['product management'],
    resume: 'Software product strategy and customer discovery.'
  });
  assert.equal(job.isRelevant, false);
});

test('rankDiscoveryJobs honors explicit exclusions and discarded-role similarity', () => {
  const ranked = core.rankDiscoveryJobs([
    {
      url: 'https://example.com/jobs/excluded',
      company: 'Example',
      role: 'Senior Product Marketing Manager',
      datePosted: '2026-06-22'
    },
    {
      url: 'https://example.com/jobs/discarded',
      company: 'Example',
      role: 'Technical Program Coordinator',
      datePosted: '2026-06-22'
    }
  ], {
    profile: {
      target_roles: { primary: ['Product Manager', 'Technical Program Manager'] },
      job_preferences: { excluded_titles: ['product marketing'] }
    },
    discardedRoles: ['Technical Program Coordinator']
  });
  assert.equal(ranked.find((job) => job.url.endsWith('/excluded')).isRelevant, false);
  assert.match(ranked.find((job) => job.url.endsWith('/excluded')).exclusionReason, /Excluded title/);
  assert.equal(ranked.find((job) => job.url.endsWith('/discarded')).isRelevant, false);
  assert.match(ranked.find((job) => job.url.endsWith('/discarded')).exclusionReason, /discarded roles/);
});

test('logExternalApplication creates an N/A Applied row and updates duplicates', async () => {
  const first = await core.logExternalApplication({
    url: 'https://example.com/jobs/1',
    company: 'Example Inc.',
    role: 'Data Intern',
    appliedAt: '2026-06-17',
    source: 'example.com'
  });
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  let tracker = fs.readFileSync(path.join(tempRoot, 'data', 'applications.md'), 'utf8');
  assert.match(tracker, /\| N\/A \| Applied \|/);
  assert.match(tracker, /URL: https:\/\/example\.com\/jobs\/1/);

  const second = await core.logExternalApplication({
    url: 'https://example.com/jobs/1',
    company: 'Example Inc.',
    role: 'Data Intern',
    appliedAt: '2026-06-18',
    source: 'example.com'
  });
  assert.equal(second.duplicate, true);
  tracker = fs.readFileSync(path.join(tempRoot, 'data', 'applications.md'), 'utf8');
  assert.equal((tracker.match(/Example Inc\./g) || []).length, 1);
  assert.match(tracker, /\| 2026-06-18 \| Example Inc\. \|/);
});

test('addDashboardJobLink creates a job in the selected pipeline stage', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    text: async () => '<html><head><title>Operations Intern | Acme</title></head><body></body></html>'
  });
  try {
    const result = await core.addDashboardJobLink({
      url: 'https://example.com/jobs/operations-intern',
      crmStatus: 'interview'
    });
    assert.equal(result.ok, true);
    assert.equal(result.job.crmStatus, 'interview');
    const application = result.dashboard.applications.find((row) => row.number === result.number);
    assert.equal(application.crmStatus, 'interview');
    assert.equal(application.status, 'Interview');
  } finally {
    global.fetch = originalFetch;
  }
});

test('updateApplicationNotes persists editable notes for a dashboard job', async () => {
  const created = await core.logExternalApplication({
    url: 'https://example.com/jobs/notes-test',
    company: 'Notes Example',
    role: 'Operations Intern',
    appliedAt: '2026-06-22',
    source: 'example.com'
  });
  const dashboard = await core.updateApplicationNotes({
    number: created.number,
    notes: 'Follow up with the recruiter on Friday.'
  });
  const application = dashboard.applications.find((row) => row.number === created.number);
  assert.equal(application.notes, 'Follow up with the recruiter on Friday.');
});

test('normalizeExtensionSettings stores only supported demographic fields', () => {
  const settings = core.normalizeExtensionSettings({
    showLogPrompt: false,
    contact: {
      addressLine1: '123 Main St',
      addressLine2: 'Apt 4',
      city: 'Ithaca',
      state: 'NY',
      phoneType: 'Mobile',
      unknown: 'ignored'
    },
    demographics: { pronouns: 'he/him', unknown: 'ignored' }
  });
  assert.equal(settings.showLogPrompt, false);
  assert.equal(settings.contact.addressLine1, '123 Main St');
  assert.equal(settings.contact.addressLine2, 'Apt 4');
  assert.equal(settings.contact.city, 'Ithaca');
  assert.equal(settings.contact.state, 'NY');
  assert.equal(settings.contact.phoneType, 'Mobile');
  assert.equal(settings.contact.unknown, undefined);
  assert.equal(settings.demographics.pronouns, 'he/him');
  assert.equal(settings.demographics.unknown, undefined);
});

test('extensionDocument returns the selected primary resume file', async () => {
  const resumePath = path.join(tempRoot, 'primary-resume.pdf');
  fs.writeFileSync(resumePath, '%PDF-1.4 test resume');
  await core.uploadResumeFromPath(resumePath, 'Nolan-Primary-Resume.pdf');
  const document = core.extensionDocument({}, 'resume');
  assert.equal(document.name, 'Nolan-Primary-Resume.pdf');
  assert.equal(document.mediaType, 'application/pdf');
  assert.equal(fs.existsSync(document.path), true);
});

test('heuristic resume extraction creates categorized facts with evidence', () => {
  const facts = core.extractKnowledgeHeuristically([
    '# Experience',
    '- Led a cross-functional launch for Acme.',
    '- Increased activation by 22%.',
    '# Skills',
    'SQL, Python, Tableau'
  ].join('\n'));
  assert.ok(facts.some((fact) => fact.category === 'employment'));
  assert.ok(facts.some((fact) => fact.category === 'accomplishments' && /22%/.test(fact.summary)));
  assert.ok(facts.some((fact) => fact.category === 'skills'));
  assert.ok(facts.every((fact) => fact.sourceExcerpt));
});

test('knowledge records consolidate projects and employment metadata while preserving details', () => {
  const source = { label: 'Resume.pdf' };
  const records = core.buildKnowledgeRecords([
    {
      id: 'employment-1',
      category: 'employment',
      factType: 'employment',
      title: 'Mentor at Curious Cardinals',
      summary: 'been a Mentor at Curious Cardinals, remote from Ithaca, NY, from November 2024 to present',
      details: {},
      confidence: 0.9,
      source
    },
    {
      id: 'tsa-1',
      category: 'projects',
      factType: 'project',
      title: 'TSA Volume Forecasting for Prediction Market',
      summary: 'Forecasted TSA passenger volume',
      details: {},
      confidence: 0.9,
      source
    },
    {
      id: 'tsa-2',
      category: 'projects',
      factType: 'metric',
      title: 'TSA forecasting accuracy',
      summary: 'Improved forecasting accuracy by 18%',
      details: {},
      confidence: 0.9,
      source
    },
    {
      id: 'tsa-3',
      category: 'projects',
      factType: 'deliverable',
      title: 'TSA forecasting dashboard',
      summary: 'Built interactive forecasting dashboard',
      details: {},
      confidence: 0.9,
      source
    }
  ]);

  const employment = records.find((record) => record.category === 'employment');
  const projects = records.filter((record) => record.category === 'projects');
  assert.equal(employment.name, 'Curious Cardinals');
  assert.equal(employment.metadata.Role, 'Mentor');
  assert.equal(employment.metadata.Location, 'Ithaca, NY');
  assert.equal(employment.metadata['Work mode'], 'Remote');
  assert.equal(employment.metadata.Dates, 'November 2024 to present');
  assert.equal(employment.facts.length, 0);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, 'TSA Volume Forecasting for Prediction Market');
  assert.equal(projects[0].facts.length, 3);
  assert.ok(projects[0].facts.some((fact) => /18%/.test(fact.summary)));
});

test('knowledge records split every listed skill and collapse duplicate preferences', () => {
  const source = { label: 'Resume.pdf' };
  const records = core.buildKnowledgeRecords([
    {
      id: 'skills-1',
      category: 'skills',
      factType: 'technical-skills',
      title: 'Listed technical and language skills',
      summary: 'lists programming, analytics, cloud, design, office software, and Mandarin language skills',
      sourceExcerpt: 'Python, SQL, AWS, Figma, Excel, Mandarin',
      details: {},
      confidence: 0.9,
      source
    },
    {
      id: 'location-1',
      category: 'role-preferences',
      factType: 'target_location',
      title: 'Target location',
      summary: 'Ithaca',
      details: {},
      confidence: 1,
      source
    },
    {
      id: 'location-2',
      category: 'role-preferences',
      factType: 'target_location',
      title: 'Target location',
      summary: 'Ithaca, NY',
      details: {},
      confidence: 1,
      source
    }
  ]);

  const skills = records.find((record) => record.category === 'skills');
  const preferences = records.find((record) => record.category === 'role-preferences');
  assert.deepEqual(skills.facts.map((fact) => fact.summary), ['Python', 'SQL', 'AWS', 'Figma', 'Excel', 'Mandarin']);
  assert.equal(preferences.metadata.Locations, 'Ithaca, NY');
  assert.equal(preferences.facts.length, 0);
});

test('transcript courses are grouped under the matching education record', () => {
  const records = core.buildKnowledgeRecords([
    {
      id: 'education-1',
      category: 'education',
      factType: 'gpa',
      title: 'GPA',
      summary: 'GPA: 3.63',
      details: { entity: 'Cornell University' },
      confidence: 1,
      source: { id: 'resume-source', label: 'Resume.pdf' }
    },
    {
      id: 'course-1',
      category: 'skills',
      factType: 'skill',
      title: 'Skill',
      summary: 'ORIE 3500: Engineering Probability and Statistics',
      details: {},
      confidence: 1,
      source: { id: 'transcript-source', label: 'SSR_TSRPT.pdf' }
    }
  ]);

  assert.equal(records.some((record) => record.category === 'skills'), false);
  const education = records.find((record) => record.name === 'Cornell University');
  assert.ok(education.facts.some((fact) => fact.factType === 'course' && /ORIE 3500/.test(fact.summary)));
});

test('guided setup settings persist normalized preferences and update the effective profile', async () => {
  const saved = core.saveSetupSettings({
    profile: {
      fullName: ' Test User ',
      email: 'test@example.com',
      headline: 'Product leader'
    },
    careerGoals: {
      targetRoles: ['Product Manager', 'Product Manager', 'Program Manager'],
      targetLocations: 'New York, Remote'
    },
    jobPreferences: {
      compensationMin: '120000',
      compensationCurrency: 'USD',
      workModes: ['Remote', 'Hybrid'],
      employmentTypes: ['Internship'],
      acceptedSeniorities: ['intern'],
      authorizedCountries: ['US']
    },
    privacy: { localOnly: true, analytics: false }
  });

  assert.equal(saved.profile.fullName, 'Test User');
  assert.deepEqual(saved.careerGoals.targetRoles, ['Product Manager', 'Program Manager']);
  assert.deepEqual(saved.careerGoals.targetLocations, ['New York', 'Remote']);
  assert.equal(saved.jobPreferences.compensationMin, 120000);
  assert.deepEqual(saved.jobPreferences.employmentTypes, ['internship']);
  assert.deepEqual(saved.jobPreferences.acceptedSeniorities, ['intern']);
  assert.deepEqual(saved.jobPreferences.authorizedCountries, ['US']);
  const cloudProfile = core.buildCloudMatchingProfile();
  assert.deepEqual(cloudProfile.acceptedSeniorities, ['intern']);
  assert.deepEqual(cloudProfile.acceptedEmploymentTypes, ['internship']);
  assert.deepEqual(cloudProfile.authorizedCountries, ['US']);
  assert.equal(cloudProfile.remoteLocationPolicy, 'authorized_only');

  const dashboard = await core.loadDashboard();
  assert.equal(dashboard.settings.candidate.full_name, 'Test User');
  assert.equal(dashboard.settings.profileDefaults.headline, 'Product leader');
  assert.deepEqual(dashboard.settings.targetRoles, ['Product Manager', 'Program Manager']);
  assert.deepEqual(dashboard.settings.profileDefaults.targetLocations, ['New York', 'Remote']);
  assert.equal(dashboard.settings.profileDefaults.compensationMin, 120000);

  const diagnostic = core.testSetup();
  assert.equal(diagnostic.checks.find((check) => check.id === 'resume').ok, true);
  assert.equal(diagnostic.checks.find((check) => check.id === 'profile').ok, true);
  assert.equal(diagnostic.checks.find((check) => check.id === 'roles').ok, true);
  assert.equal(diagnostic.checks.find((check) => check.id === 'preferences').ok, true);
});

test('AI settings expose a fixed internal model and a configurable cover-letter model', async () => {
  const settings = core.saveAiSettings({
    apiKey: 'test-key',
    coverLetterModel: 'gpt-5.5'
  });

  assert.equal(settings.ai.internalModel, 'gpt-5.4-mini');
  assert.equal(settings.ai.coverLetterModel, 'gpt-5.5');
  assert.equal(settings.ai.model, 'gpt-5.5');

  const originalFetch = global.fetch;
  let requestedModel = '';
  global.fetch = async (_url, options) => {
    requestedModel = JSON.parse(options.body).model;
    return {
      ok: true,
      async json() {
        return {
          id: 'response-test',
          model: requestedModel,
          output: [{ content: [{ type: 'output_text', text: 'career-ops-api-ok' }] }]
        };
      }
    };
  };
  try {
    const result = await core.testAi();
    assert.equal(requestedModel, 'gpt-5.5');
    assert.equal(result.internalModel, 'gpt-5.4-mini');
  } finally {
    global.fetch = originalFetch;
  }
});

test('job evaluation always uses gpt-5.4-mini regardless of the cover-letter setting', async () => {
  const originalFetch = global.fetch;
  const requestedModels = [];
  const requestedInputs = [];
  global.fetch = async (url, options = {}) => {
    if (url === 'https://api.openai.com/v1/responses') {
      const body = JSON.parse(options.body);
      requestedModels.push(body.model);
      requestedInputs.push(body.input);
      return {
        ok: true,
        async json() {
          return {
            model: requestedModels.at(-1),
            output: [{
              content: [{
                type: 'output_text',
                text: JSON.stringify({
                  score: 4.2,
                  recommendation: 'Apply',
                  legitimacy: 'active',
                  notes: 'Strong fit.',
                  reportMarkdown: [
                    '# Test report',
                    '',
                    '## TL;DR',
                    'Strong fit.',
                    '',
                    '## Fit',
                    'Relevant experience.',
                    '',
                    '## Risks',
                    'None identified.',
                    '',
                    '## Resume angles',
                    'Use supported evidence.',
                    '',
                    '## First-round interview assessment',
                    'Yes. I would move this applicant into a first-round interview because the resume shows relevant overlap.',
                    '',
                    '## Offer likelihood',
                    'Moderate. The profile is credible, but final offer odds depend on interview execution and comparison to the pool.',
                    '',
                    '## Missing / future positioning',
                    'More direct production evidence in the exact domain would strengthen the candidacy.',
                    '',
                    '## Interview preparation',
                    'Prepare concrete examples around Python, SQL, project delivery, and role motivation.',
                    '',
                    '## Application recommendation',
                    'Apply.'
                  ].join('\n')
                })
              }]
            }]
          };
        }
      };
    }
    return {
      ok: true,
      async text() {
        return '<html><body>Data science internship with Python and SQL.</body></html>';
      }
    };
  };

  try {
    const result = await core.evaluatePending({});
    assert.equal(result.ok, true);
    assert.ok(requestedModels.length > 0);
    assert.deepEqual([...new Set(requestedModels)], ['gpt-5.4-mini']);
    assert.match(requestedInputs[0], /You are the hiring manager for /);
    assert.match(requestedInputs[0], /would give this applicant a first-round interview/i);
    assert.match(requestedInputs[0], /likelihood of giving them an offer/i);
    assert.match(requestedInputs[0], /what else the applicant could do in the future to better position themselves/i);
    assert.match(requestedInputs[0], /how the applicant should prepare for an interview/i);
    const evaluated = result.results.find((item) => item.ok);
    assert.ok(evaluated.jobDescriptionPath);
    const jdPath = path.isAbsolute(evaluated.jobDescriptionPath)
      ? evaluated.jobDescriptionPath
      : path.join(tempRoot, evaluated.jobDescriptionPath);
    assert.equal(fs.existsSync(jdPath), true);
    assert.match(fs.readFileSync(jdPath, 'utf8'), /Data science internship/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('resume tailoring uses GPT-5.4 feedback before creating an AI tailored resume', async () => {
  fs.mkdirSync(process.env.CAREER_OPS_APP_DATA, { recursive: true });
  const dbPath = path.join(process.env.CAREER_OPS_APP_DATA, 'career-ops.sqlite');
  if (!fs.existsSync(dbPath)) {
    const database = new DatabaseSync(dbPath);
    database.exec(fs.readFileSync(path.join(__dirname, 'storage', 'schema.sql'), 'utf8'));
    database.close();
  }
  const database = new DatabaseSync(dbPath);
  const now = new Date().toISOString();
  database.prepare('INSERT OR IGNORE INTO users(id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('local-user', 'Local User', now, now);
  database.close();

  const resumePath = path.join(sqliteStore.dataRoot, 'files', 'uploads', 'resumes', 'ai-tailor.md');
  fs.mkdirSync(path.dirname(resumePath), { recursive: true });
  const resumeContent = '# Resume\n\n## Experience\n\n- Built forecasting models\n';
  fs.writeFileSync(resumePath, resumeContent, 'utf8');
  const resumeId = sqliteStore.addResume({
    name: 'AI Tailor Resume',
    content: resumeContent,
    storagePath: 'files/uploads/resumes/ai-tailor.md'
  });
  const sourceId = sqliteStore.addKnowledgeSource({
    sourceType: 'resume',
    label: 'AI Tailor Resume',
    referenceId: resumeId,
    storagePath: 'files/uploads/resumes/ai-tailor.md'
  });
  sqliteStore.addKnowledgeFacts([{
    category: 'experience',
    factType: 'achievement',
    title: 'Forecasting automation',
    summary: 'Built Python forecasting models that improved planning accuracy by 18%',
    confidence: 1
  }], sourceId, 'trusted');
  sqliteStore.saveEvaluation({
    job: { url: 'https://example.com/jobs/forecasting', company: 'Forecast Co', role: 'Forecasting Analyst' },
    reportNum: sqliteStore.nextApplicationNumber(),
    today: '2026-06-23',
    score: 4.4,
    legitimacy: 'active',
    notes: 'Synthetic job',
    reportMarkdown: '# Report',
    reportName: 'forecasting.md',
    jobDescription: 'Forecasting analyst role requiring Python forecasting and planning accuracy.'
  });
  const master = core.createMasterResume({ baseResumeId: resumeId, name: 'AI Tailor Master' }).variant;
  const applicationId = sqliteStore.loadSnapshot().applications.find((job) => job.company === 'Forecast Co').id;
  const originalFetch = global.fetch;
  const requestedModels = [];
  global.fetch = async (url, options) => {
    if (url === 'https://api.openai.com/v1/responses') {
      const body = JSON.parse(options.body);
      requestedModels.push(body.model);
      const isReview = String(body.input).includes('Do not rewrite the resume yet');
      return {
        ok: true,
        async json() {
          return {
            model: body.model,
            output_text: isReview
              ? JSON.stringify({
                summary: 'Strong baseline, but Python impact should be clearer.',
                goodParts: ['Forecasting experience is relevant.'],
                pitfalls: ['Impact is under-specified.'],
                recommendedStrategy: ['Emphasize Python forecasting impact.'],
                missingButUseful: ['Planning accuracy if true.'],
                verdict: 'Worth tailoring before applying.'
              })
              : JSON.stringify({
                resumeMarkdown: '# Resume\n\n## Experience\n\n- Built Python forecasting models that improved planning accuracy by 18%\n',
                changeSummary: ['Clarified Python forecasting impact.'],
                tradeoffs: ['Kept resume structure unchanged.']
              })
          };
        }
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    await core.saveAiSettings({ apiKey: 'test-key', coverLetterModel: 'gpt-5.4-mini' });
    const review = await core.analyzeResumeForJob({
      masterVariantId: master.id,
      applicationId,
      name: 'Forecast Co - Forecasting Analyst'
    });
    assert.match(review.review.summary, /Strong baseline/);
    const generated = await core.generateAiTailoredResume({
      masterVariantId: master.id,
      applicationId,
      name: review.suggestedName,
      review: review.review
    });
    assert.match(generated.variant.content, /improved planning accuracy by 18%/);
    assert.deepEqual([...new Set(requestedModels)], ['gpt-5.4']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('resume fit coverage is directional and does not reward repetition', () => {
  const job = 'Python Python analytics analytics forecasting forecasting SQL SQL collaboration collaboration';
  const once = core.analyzeResumeFit('Python SQL forecasting', job);
  const repeated = core.analyzeResumeFit('Python Python Python SQL SQL forecasting forecasting', job);
  assert.equal(once.coverage, repeated.coverage);
  assert.ok(once.covered.includes('python'));
  assert.ok(once.guidance.includes('Repetition does not improve'));
});

test('resume edit targets use complete bullets and skip extracted fragments', () => {
  const blocks = core.parseResumeEditableBlocks([
    'WORK EXPERIENCE',
    '• Implemented AI-driven workflows: engineered automated data',
    '  pipelines using Python to scrape leads and clean records.',
    'any client account and receive accurate performance data',
    'and insights via Slack, including drafted reports.'
  ].join('\n'));

  assert.equal(blocks.length, 1);
  assert.equal(
    blocks[0].originalText,
    '• Implemented AI-driven workflows: engineered automated data pipelines using Python to scrape leads and clean records.'
  );
  assert.equal(blocks[0].section, 'Work Experience');
});

test('DOCX resume edits preserve paragraph and run formatting', () => {
  const documentXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
    '<w:p><w:pPr><w:spacing w:after="240"/></w:pPr>',
    '<w:r><w:rPr><w:rFonts w:ascii="Aptos"/><w:b/></w:rPr><w:t>Original</w:t></w:r>',
    '<w:r><w:rPr><w:rFonts w:ascii="Aptos"/></w:rPr><w:t xml:space="preserve"> heading</w:t></w:r>',
    '</w:p>',
    '<w:p><w:pPr><w:ind w:left="720"/></w:pPr><w:r><w:t>Original bullet</w:t></w:r></w:p>',
    '<w:sectPr><w:pgMar w:top="900" w:right="720" w:bottom="900" w:left="720"/></w:sectPr>',
    '</w:body></w:document>'
  ].join('');

  const patched = core.patchResumeDocumentXml(
    documentXml,
    '# Resume\n\nOriginal heading\n\nOriginal bullet\n',
    '# Resume\n\nUpdated heading\n\nUpdated bullet\n'
  );

  assert.match(patched, /w:rFonts w:ascii="Aptos"/);
  assert.match(patched, /<w:b\/>/);
  assert.match(patched, /w:spacing w:after="240"/);
  assert.match(patched, /w:ind w:left="720"/);
  assert.match(patched, /w:pgMar w:top="900"/);
  assert.match(patched, /Updated/);
  assert.match(patched, /bullet/);
  assert.doesNotMatch(patched, /Original heading|Original bullet/);
});
