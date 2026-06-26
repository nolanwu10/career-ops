const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-ops-scan-bridge-'));
const runtimeRoot = path.join(root, 'classic');
const dataRoot = path.join(root, 'app-data');
fs.mkdirSync(runtimeRoot, { recursive: true });
fs.mkdirSync(dataRoot, { recursive: true });
fs.writeFileSync(path.join(runtimeRoot, 'portals.yml'), 'title_filter:\n  positive: []\n');
fs.writeFileSync(path.join(runtimeRoot, 'scan.mjs'), `
  import { appendFileSync } from 'node:fs';
  appendFileSync('data/scan-history.tsv',
    'https://example.com/jobs/new\\t2026-06-18\\tfake-provider\\tData Science Intern\\tExample Co\\tadded\\tRemote\\n');
  console.log('New jobs found: 1');
`);

process.env.CAREER_OPS_ROOT = runtimeRoot;
process.env.CAREER_OPS_APP_DATA = dataRoot;
process.env.CAREER_OPS_USER_DATA = path.join(root, 'settings');

const database = new DatabaseSync(path.join(dataRoot, 'career-ops.sqlite'));
database.exec(fs.readFileSync(path.join(__dirname, 'storage', 'schema.sql'), 'utf8'));
const now = new Date().toISOString();
database.prepare(`
  INSERT INTO users(id, display_name, created_at, updated_at)
  VALUES ('local-user', 'Test User', ?, ?)
`).run(now, now);
database.prepare(`
  INSERT INTO profiles(user_id, profile_json, profile_yaml, updated_at)
  VALUES ('local-user', '{}', '{}', ?)
`).run(now);
database.prepare(`
  INSERT INTO targeting_configs(user_id, config_json, config_yaml, updated_at)
  VALUES ('local-user', '{"title_filter":{"positive":["Data Science Intern"]}}',
    'title_filter:\\n  positive:\\n    - Data Science Intern\\n', ?)
`).run(now);
database.close();

const core = require('./app-core');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('runScan bridges classic scanner output into SQLite', async () => {
  const diagnostics = core.rootDiagnostics();
  assert.equal(diagnostics.scannerAvailable, true);

  const result = await core.runScan();
  assert.equal(result.ok, true);
  assert.equal(result.imported.added, 1);
  assert.match(result.output, /SQLite import: 1 new pending/);

  const dashboard = await core.loadDashboard();
  assert.equal(dashboard.pendingJobs.length, 1);
  assert.equal(dashboard.pendingJobs[0].role, 'Data Science Intern');
  assert.equal(fs.existsSync(path.join(dataRoot, 'temp')), true);
  assert.deepEqual(fs.readdirSync(path.join(dataRoot, 'temp')), []);
});
