const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'career-ops-sqlite-'));
process.env.CAREER_OPS_APP_DATA = dataRoot;

const databasePath = path.join(dataRoot, 'career-ops.sqlite');
const database = new DatabaseSync(databasePath);
database.exec(fs.readFileSync(path.join(__dirname, 'storage', 'schema.sql'), 'utf8'));
const now = new Date().toISOString();
database.prepare(`
  INSERT INTO users(id, display_name, created_at, updated_at) VALUES ('local-user', 'Test User', ?, ?)
`).run(now, now);
database.prepare(`
  INSERT INTO profiles(user_id, profile_json, profile_yaml, updated_at)
  VALUES ('local-user', '{}', '{}', ?)
`).run(now);
database.prepare(`
  INSERT INTO targeting_configs(user_id, config_json, config_yaml, updated_at)
  VALUES ('local-user', '{}', '{}', ?)
`).run(now);
database.prepare(`
  INSERT INTO discoveries(
    id, user_id, url, company, role, portal, first_seen, scan_status,
    pipeline_status, created_at, updated_at
  ) VALUES ('discovery-1', 'local-user', 'https://example.com/jobs/1', 'Example', 'Data Intern',
    'manual', '2026-06-18', 'manual', 'pending', ?, ?)
`).run(now, now);
database.close();

const store = require('./storage/sqlite-store');

test.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

test('saveTargetKeywords creates the nested SQLite targeting config', () => {
  store.saveTargetKeywords(['Data Science Intern', 'ML Intern']);
  assert.deepEqual(
    store.loadSnapshot().targeting.title_filter.positive,
    ['Data Science Intern', 'ML Intern']
  );
});

test('cloud feed cache and outbox support offline synchronization', () => {
  const recommendation = {
    recommendationId: 'rec-1',
    jobKey: 'greenhouse#1',
    fitScore: 82,
    updatedAt: now
  };
  store.cacheCloudFeed({
    items: [{ recommendation, job: { title: 'AI Product Manager' } }],
    cursor: 'cursor-1',
    syncedAt: now
  });
  assert.equal(store.loadCloudFeed().items[0].recommendation.fitScore, 82);
  const action = store.queueCloudAction({
    recommendationId: 'rec-1',
    jobKey: 'greenhouse#1',
    action: 'saved'
  });
  assert.equal(store.pendingCloudActions().length, 1);
  store.markCloudActionsSent([action.idempotencyKey]);
  assert.equal(store.pendingCloudActions().length, 0);
  store.clearCloudFeed();
  assert.equal(store.loadCloudFeed().items.length, 0);
  assert.equal(store.loadCloudFeed().cursor, '');
});

test('saveEvaluation atomically creates the application, report, and processed discovery', () => {
  const reportNum = store.nextApplicationNumber();
  const result = store.saveEvaluation({
    job: {
      url: 'https://example.com/jobs/1',
      company: 'Example',
      role: 'Data Intern'
    },
    reportNum,
    today: '2026-06-18',
    score: 4.4,
    legitimacy: 'active',
    notes: 'Strong fit',
    reportMarkdown: '# Evaluation\n\n**TL;DR:** Strong fit\n',
    reportName: '001-example-2026-06-18.md',
    jobDescription: 'Build forecasting models with Python and SQL.'
  });

  assert.equal(result.reportNum, 1);
  assert.equal(fs.existsSync(result.reportPath), true);

  const snapshot = store.loadSnapshot();
  assert.equal(snapshot.pendingJobs.length, 0);
  assert.equal(snapshot.applications.length, 1);
  assert.equal(snapshot.applications[0].company, 'Example');
  assert.equal(snapshot.applications[0].score, 4.4);
  assert.match(snapshot.applications[0].reportContent, /Strong fit/);
  assert.equal(fs.existsSync(snapshot.applications[0].jobDescriptionPath), true);
  assert.match(fs.readFileSync(snapshot.applications[0].jobDescriptionPath, 'utf8'), /forecasting models/);
});

test('cover letter documents are linked to their application', () => {
  const application = store.logExternalApplication({
    url: 'https://example.com/jobs/cover-letter-link',
    company: 'Linked Example',
    role: 'Operations Intern',
    appliedAt: '2026-06-22',
    notes: '',
    source: 'test'
  });
  const letterPath = path.join(dataRoot, 'files', 'generated', 'cover-letters', `${String(application.number).padStart(3, '0')}-linked-example.docx`);
  fs.mkdirSync(path.dirname(letterPath), { recursive: true });
  fs.writeFileSync(letterPath, 'test docx bytes');
  store.linkApplicationDocument(
    application.number,
    'cover-letter',
    letterPath,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
  const linked = store.loadSnapshot().applications.find((row) => row.number === application.number);
  assert.equal(linked.coverLetterPath, letterPath);
});

test('importScanDiscoveries adds new matches without reopening processed jobs', () => {
  store.importScanDiscoveries([
    {
      url: 'https://example.com/jobs/1',
      firstSeen: '2026-06-18',
      portal: 'manual',
      title: 'Updated Data Intern',
      company: 'Example',
      status: 'added'
    },
    {
      url: 'https://example.com/jobs/2',
      firstSeen: '2026-06-18',
      portal: 'greenhouse',
      title: 'ML Intern',
      company: 'Example Two',
      datePosted: '2026-06-16',
      location: 'New York, NY',
      status: 'added'
    },
    {
      url: 'https://example.com/jobs/3',
      firstSeen: '2026-06-18',
      portal: 'search',
      title: 'Closed Internship',
      company: 'Example Three',
      status: 'skipped_expired'
    }
  ]);

  const snapshot = store.loadSnapshot();
  assert.deepEqual(snapshot.pendingJobs.map((job) => job.url), ['https://example.com/jobs/2']);
  assert.equal(snapshot.pendingJobs[0].datePosted, '2026-06-16');
  assert.equal(snapshot.pendingJobs[0].location, 'New York, NY');
  assert.equal(snapshot.scanHistory.find((row) => row.url.endsWith('/1')).title, 'Updated Data Intern');
  assert.equal(snapshot.scanHistory.find((row) => row.url.endsWith('/3')).status, 'skipped_expired');
});

test('discovery sources are saved for future refreshes', () => {
  store.saveDiscoverySource({
    url: 'https://github.com/example/jobs',
    label: 'example/jobs',
    sourceType: 'markdown'
  });
  assert.deepEqual(store.listDiscoverySources().map((source) => ({
    url: source.url,
    label: source.label,
    sourceType: source.sourceType,
    lastError: source.lastError
  })), [{
    url: 'https://github.com/example/jobs',
    label: 'example/jobs',
    sourceType: 'markdown',
    lastError: ''
  }]);
});

test('resume library supports multiple resumes and primary selection', () => {
  const primaryPath = path.join(dataRoot, 'files', 'uploads', 'resumes', 'primary.md');
  fs.mkdirSync(path.dirname(primaryPath), { recursive: true });
  fs.writeFileSync(primaryPath, '# Primary resume\n', 'utf8');
  const primaryId = store.addResume({
    name: 'Primary Resume.pdf',
    content: '# Primary resume\n',
    storagePath: 'files/uploads/resumes/primary.md'
  });

  const secondPath = path.join(dataRoot, 'files', 'uploads', 'resumes', 'second.md');
  fs.mkdirSync(path.dirname(secondPath), { recursive: true });
  fs.writeFileSync(secondPath, '# Second resume\n', 'utf8');

  const id = store.addResume({
    name: 'Analytics Resume.pdf',
    content: '# Second resume\n',
    storagePath: 'files/uploads/resumes/second.md'
  });

  let resumes = store.listResumes();
  assert.equal(resumes.length, 2);
  assert.equal(resumes.find((resume) => resume.id === primaryId).isPrimary, true);
  assert.equal(resumes.find((resume) => resume.id === id).isPrimary, false);

  store.setPrimaryResume(id);
  resumes = store.listResumes();
  assert.equal(resumes.find((resume) => resume.id === id).isPrimary, true);
  assert.equal(resumes.filter((resume) => resume.isPrimary).length, 1);
  assert.equal(store.getResume(id).content, '# Second resume\n');
  assert.equal(store.loadSnapshot().resume, '# Second resume\n');
});

test('resume knowledge facts are trusted automatically and normalized to bare facts', () => {
  const sourceId = store.addKnowledgeSource({
    sourceType: 'resume',
    label: 'Primary Resume.pdf',
    referenceId: 'resume-primary',
    storagePath: 'files/uploads/resumes/primary.md'
  });
  const added = store.addKnowledgeFacts([
    {
      category: 'education',
      factType: 'academic',
      title: 'Test User has a GPA of 3.63 at Cornell University',
      summary: 'Test User has a GPA of 3.63 at Cornell University.',
      confidence: 0.86,
      sourceExcerpt: 'Test User has a GPA of 3.63 at Cornell University.'
    },
    {
      category: 'skills',
      factType: 'technical-skills',
      title: 'Test User is skilled in Python and SQL',
      summary: 'Test User is skilled in Python and SQL.',
      confidence: 0.9,
      sourceExcerpt: 'Python and SQL'
    },
    {
      category: 'employment',
      factType: 'role',
      title: 'Role',
      summary: 'Test User worked as a Data Analyst.',
      details: { entity: 'Acme' },
      confidence: 0.9,
      sourceExcerpt: 'Data Analyst at Acme'
    },
    {
      category: 'accomplishments',
      factType: 'metric',
      title: 'Conversion improvement',
      summary: 'Test User increased conversion by 22%.',
      confidence: 0.9,
      sourceExcerpt: 'Increased conversion by 22%'
    }
  ], sourceId, 'trusted');

  assert.equal(added, 4);
  const summary = store.knowledgeSummary();
  assert.equal(summary.counts.pending, 0);
  assert.equal(summary.counts.trusted, 4);
  const gpa = summary.facts.find((fact) => fact.factType === 'gpa');
  const skills = summary.facts.find((fact) => fact.factType === 'technical-skills');
  const role = summary.facts.find((fact) => fact.factType === 'role');
  const metric = summary.facts.find((fact) => fact.factType === 'metric');
  assert.equal(gpa.summary, 'GPA: 3.63');
  assert.equal(gpa.details.entity, 'Cornell University');
  assert.equal(skills.summary, 'skilled in Python and SQL');
  assert.equal(role.summary, 'Data Analyst');
  assert.equal(metric.summary, 'increased conversion by 22%');
  assert.ok(summary.facts.every((fact) => !/Test User/.test(fact.summary)));
  assert.ok(summary.facts.every((fact) => !/[.]$/.test(fact.summary)));
});

test('knowledge facts can be edited and cleared', () => {
  const sourceId = store.addKnowledgeSource({ sourceType: 'manual', label: 'Manual' });
  store.addKnowledgeFacts([{
    category: 'projects',
    factType: 'metric',
    title: 'Old title',
    summary: 'Old fact',
    details: { entity: 'Project Alpha' },
    confidence: 1
  }], sourceId, 'trusted');
  const fact = store.listKnowledgeFacts().find((item) => item.summary === 'Old fact');
  store.updateKnowledgeFact(fact.id, {
    category: 'projects',
    factType: 'metric',
    title: 'Updated title',
    summary: 'Improved accuracy by 18%',
    details: { entity: 'Project Alpha' }
  });
  assert.equal(store.listKnowledgeFacts().find((item) => item.id === fact.id).summary, 'Improved accuracy by 18%');
  store.clearKnowledge();
  assert.equal(store.knowledgeSummary().counts.total, 0);
});

test('knowledge record metadata updates every fact in the record', () => {
  const sourceId = store.addKnowledgeSource({ sourceType: 'manual', label: 'Manual record' });
  store.addKnowledgeFacts([
    {
      category: 'education',
      factType: 'gpa',
      title: 'GPA',
      summary: 'GPA: 3.63',
      details: { entity: 'Cornell University', degree: 'Undergraduate' },
      confidence: 1
    },
    {
      category: 'education',
      factType: 'honors',
      title: 'Honors',
      summary: 'Dean’s List',
      details: { entity: 'Cornell University', degree: 'Undergraduate' },
      confidence: 1
    }
  ], sourceId, 'trusted');
  const facts = store.listKnowledgeFacts().filter((fact) => fact.source.id === sourceId);
  store.updateKnowledgeRecord(facts.map((fact) => fact.id), {
    category: 'education',
    name: 'Cornell University',
    metadata: {
      degree: 'Bachelor of Science',
      field: 'Operations Research and Engineering',
      location: 'Ithaca, NY',
      dates: '2024–2026'
    }
  });
  const updated = store.listKnowledgeFacts().filter((fact) => fact.source.id === sourceId);
  assert.ok(updated.every((fact) => fact.details.degree === 'Bachelor of Science'));
  assert.ok(updated.every((fact) => fact.details.field === 'Operations Research and Engineering'));
  assert.ok(updated.every((fact) => fact.details.location === 'Ithaca, NY'));
});

test('resumes can be renamed and deleted with linked knowledge', () => {
  const filePath = path.join(dataRoot, 'files', 'uploads', 'resumes', 'deletable.md');
  fs.writeFileSync(filePath, '# Deletable\n', 'utf8');
  const id = store.addResume({
    name: 'Old Resume',
    content: '# Deletable\n',
    storagePath: 'files/uploads/resumes/deletable.md'
  });
  const sourceId = store.addKnowledgeSource({
    sourceType: 'resume',
    label: 'Old Resume',
    referenceId: id,
    storagePath: 'files/uploads/resumes/deletable.md'
  });
  store.addKnowledgeFacts([{
    category: 'skills',
    factType: 'skill',
    title: 'Skill',
    summary: 'Python',
    confidence: 1
  }], sourceId, 'trusted');

  store.renameResume(id, 'Renamed Resume');
  assert.equal(store.getResume(id).name, 'Renamed Resume');
  assert.equal(store.listKnowledgeFacts().find((fact) => fact.source.referenceId === id).source.label, 'Renamed Resume');

  store.deleteResume(id);
  assert.equal(store.listResumes().some((resume) => resume.id === id), false);
  assert.equal(store.listKnowledgeFacts().some((fact) => fact.source.referenceId === id), false);
  assert.equal(fs.existsSync(filePath), false);
});

test('resume builder keeps immutable versions and records suggestion decisions', () => {
  const basePath = path.join(dataRoot, 'files', 'uploads', 'resumes', 'builder-base.md');
  fs.writeFileSync(basePath, '# Builder Base\n\n## Experience\n\n- Built forecasting models\n', 'utf8');
  const baseResumeId = store.addResume({
    name: 'Builder Base',
    content: fs.readFileSync(basePath, 'utf8'),
    storagePath: 'files/uploads/resumes/builder-base.md'
  });
  const variantId = store.createResumeVariant({
    baseResumeId,
    kind: 'master',
    name: 'Complete Master',
    content: '# Builder Base\n\n## Experience\n\n- Built forecasting models\n',
    suggestions: [{
      originalText: '- Built forecasting models',
      proposedText: '- Built Python forecasting models that improved accuracy by 18%',
      reason: 'Supports forecasting requirements.',
      evidence: [{ factId: 'fact-1', source: 'Approved resume' }]
    }]
  });

  store.saveResumeVariant(variantId, '# Builder Base\n\n## Experience\n\n- Built forecasting models\n\nManual edit\n', {
    action: 'manual_edit',
    pdfEdits: { '1:4': 'Updated PDF text' }
  });
  let variant = store.getResumeVariant(variantId);
  assert.deepEqual(variant.versions.map((version) => version.number), [2, 1]);
  assert.deepEqual(variant.jobContext.pdfEdits, { '1:4': 'Updated PDF text' });

  variant = store.decideResumeSuggestion(variantId, variant.suggestions[0].id, 'accepted');
  assert.match(variant.content, /- Built Python forecasting models that improved accuracy by 18%/);
  assert.doesNotMatch(variant.content, /## Relevant Evidence/);
  assert.doesNotMatch(variant.content, /- Built forecasting models/);
  assert.equal(variant.suggestions[0].status, 'accepted');
  assert.deepEqual(variant.versions.map((version) => version.number), [3, 2, 1]);

  store.deleteResumeVariant(variantId);
  assert.throws(() => store.getResumeVariant(variantId), /Resume variant not found/);
});

test('purgeExpiredArchivedApplications removes jobs after 21 days in the archive', () => {
  const reportNum = store.nextApplicationNumber();
  store.saveEvaluation({
    job: {
      url: 'https://example.com/jobs/archive-expiry',
      company: 'Archive Example',
      role: 'Expired Role'
    },
    reportNum,
    today: '2026-05-01',
    score: 2.5,
    legitimacy: 'active',
    notes: 'Archive retention test',
    reportMarkdown: '# Evaluation\n',
    reportName: `${String(reportNum).padStart(3, '0')}-archive-expiry.md`,
    jobDescription: 'Test job description.'
  });
  store.updateStatus(reportNum, 'Discarded');

  const oldArchiveDate = '2026-05-20T12:00:00.000Z';
  const database = new DatabaseSync(databasePath);
  database.prepare(`
    UPDATE application_events SET event_at = ?
    WHERE application_id = (SELECT id FROM applications WHERE legacy_number = ?)
      AND to_status = 'Discarded'
  `).run(oldArchiveDate, reportNum);
  database.prepare('UPDATE applications SET updated_at = ? WHERE legacy_number = ?')
    .run(oldArchiveDate, reportNum);
  database.close();

  store.purgeExpiredArchivedApplications(new Date('2026-06-22T12:00:00.000Z'));
  assert.equal(store.loadSnapshot().applications.some((row) => row.number === reportNum), false);
});
