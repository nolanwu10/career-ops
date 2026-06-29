#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const yaml = require('js-yaml');

const appRoot = path.resolve(__dirname, '..');
const defaultClassicRoot = path.resolve(appRoot, '..', '..', 'classic');
const defaultDataRoot = path.join(appRoot, 'local-data');
const args = process.argv.slice(2);
const replaceExisting = args.includes('--replace');
const positionalArgs = args.filter((arg) => !arg.startsWith('--'));
const classicRoot = path.resolve(process.env.CLASSIC_ROOT || positionalArgs[0] || defaultClassicRoot);
const dataRoot = path.resolve(process.env.CAREER_OPS_APP_DATA || positionalArgs[1] || defaultDataRoot);
const databasePath = path.join(dataRoot, 'career-ops.sqlite');
const filesRoot = path.join(dataRoot, 'files', 'classic-import');
const schemaPath = path.join(appRoot, 'src', 'storage', 'schema.sql');
const now = new Date().toISOString();
const localUserId = 'local-user';

const sourceSpecs = [
  ['cv.md', 'resume'],
  ['article-digest.md', 'portfolio'],
  ['portals.yml', 'targeting'],
  ['config/profile.yml', 'profile'],
  ['modes/_profile.md', 'profile'],
  ['data', 'data'],
  ['reports', 'report'],
  ['output', 'output'],
  ['interview-prep', 'interview-prep'],
  ['jds', 'job-description'],
  ['writing-samples', 'writing-sample'],
  ['batch/tracker-additions', 'tracker-history'],
  ['batch/logs', 'batch-log']
];

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function listSourceFiles() {
  const files = [];
  for (const [relativeSpec, category] of sourceSpecs) {
    const full = path.join(classicRoot, relativeSpec);
    if (!fs.existsSync(full)) continue;
    const stat = fs.statSync(full);
    if (stat.isFile()) {
      files.push(fileRecord(full, relativeSpec, category));
      continue;
    }
    walk(full, (filePath) => {
      const relative = path.relative(classicRoot, filePath).replaceAll(path.sep, '/');
      files.push(fileRecord(filePath, relative, category));
    });
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function walk(directory, visit) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else if (entry.isFile()) visit(full);
  }
}

function fileRecord(fullPath, relativePath, category) {
  const stat = fs.statSync(fullPath);
  return {
    fullPath,
    relativePath: relativePath.replaceAll(path.sep, '/'),
    category,
    sha256: sha256File(fullPath),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString()
  };
}

function manifestHash(files) {
  return sha256Buffer(Buffer.from(files.map((file) => (
    `${file.relativePath}\t${file.size}\t${file.sha256}`
  )).join('\n')));
}

function read(relativePath) {
  const full = path.join(classicRoot, relativePath);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
}

function parseScore(raw) {
  const match = String(raw || '').match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function parseApplications() {
  const markdown = read('data/applications.md');
  const rows = [];
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const fields = line.slice(1, line.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((field) => field.trim());
    if (fields.length < 8) continue;
    const reportMatch = fields[7].match(/\[[^\]]*]\(([^)]+)\)/);
    rows.push({
      legacyNumber: Number(fields[0]),
      date: fields[1] || null,
      company: fields[2] || 'Unknown',
      role: fields[3] || 'Unknown',
      scoreRaw: fields[4] || '',
      score: parseScore(fields[4]),
      status: fields[5] || 'Evaluated',
      pdfAvailable: /✅|âœ…/.test(fields[6] || ''),
      reportPath: reportMatch ? normalizeLegacyLink(reportMatch[1]) : '',
      notes: fields[8] || '',
      jobUrl: extractUrl(fields[8] || '')
    });
  }
  return rows;
}

function normalizeLegacyLink(value) {
  return path.posix.normalize(path.posix.join('data', value)).replace(/^\.\.\//, '');
}

function extractUrl(value) {
  return String(value || '').match(/https?:\/\/[^\s)]+/)?.[0]?.replace(/[.,]$/, '') || '';
}

function parsePipeline() {
  const rows = new Map();
  for (const rawLine of read('data/pipeline.md').split(/\r?\n/)) {
    const match = rawLine.match(/^\s*-\s*\[([ xX])]\s+(https?:\/\/\S+)\s+\|\s+([^|]+)\s+\|\s+([^|]+?)(?:\s+\|\s+(.+))?\s*$/);
    if (!match) continue;
    rows.set(match[2], {
      url: match[2],
      pipelineStatus: match[1].trim() ? 'processed' : 'pending',
      company: match[3].trim(),
      role: match[4].trim(),
      note: (match[5] || '').trim()
    });
  }
  return rows;
}

function parseScanHistory() {
  const rows = new Map();
  const lines = read('data/scan-history.tsv').split(/\r?\n/).filter(Boolean);
  const headers = (lines.shift() || '').split('\t');
  for (const line of lines) {
    const values = line.split('\t');
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
    if (row.url) rows.set(row.url, row);
  }
  return rows;
}

function reportMetadata(markdown) {
  const header = (name) => markdown.match(new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+)$`, 'mi'))?.[1]?.trim() || '';
  return {
    title: markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || '',
    legacyNumber: Number(markdown.match(/^#\s+(\d+)/m)?.[1] || 0) || null,
    score: parseScore(header('Score')),
    legitimacy: header('Legitimacy'),
    jobUrl: header('URL'),
    date: header('Date')
  };
}

function documentKind(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  if (normalized.startsWith('reports/')) return 'report';
  if (normalized.includes('/cover-letters/')) return 'cover-letter';
  if (normalized.includes('/apply-prompts/')) return 'apply-prompt';
  if (normalized.startsWith('interview-prep/')) return 'interview-prep';
  if (normalized.startsWith('jds/')) return 'job-description';
  if (normalized.startsWith('writing-samples/')) return 'writing-sample';
  if (normalized === 'cv.md') return 'resume';
  return 'legacy-file';
}

function mediaType(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  return ({
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.yml': 'application/yaml',
    '.yaml': 'application/yaml',
    '.tsv': 'text/tab-separated-values',
    '.json': 'application/json',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  })[extension] || 'application/octet-stream';
}

function applicationNumberFromPath(relativePath) {
  return Number(path.basename(relativePath).match(/^(\d{1,3})[-_]/)?.[1] || 0) || null;
}

function safeYaml(text) {
  if (!text.trim()) return {};
  return yaml.load(text) || {};
}

function ensureCleanDestination() {
  fs.mkdirSync(dataRoot, { recursive: true });
  if ((fs.existsSync(databasePath) || fs.existsSync(filesRoot)) && !replaceExisting) {
    throw new Error(`App data already exists at ${dataRoot}. Use --replace to rebuild it from classic.`);
  }
  if (fs.existsSync(databasePath)) fs.rmSync(databasePath);
  if (fs.existsSync(filesRoot)) fs.rmSync(filesRoot, { recursive: true, force: true });
  fs.mkdirSync(filesRoot, { recursive: true });
}

function copySourceFiles(files) {
  for (const file of files) {
    const destination = path.join(filesRoot, ...file.relativePath.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file.fullPath, destination);
    if (sha256File(destination) !== file.sha256) {
      throw new Error(`Copied file failed hash verification: ${file.relativePath}`);
    }
    file.storagePath = path.relative(dataRoot, destination).replaceAll(path.sep, '/');
  }
}

function main() {
  if (!fs.existsSync(path.join(classicRoot, 'data', 'applications.md'))) {
    throw new Error(`Classic data not found at ${classicRoot}`);
  }

  const beforeFiles = listSourceFiles();
  const beforeManifest = manifestHash(beforeFiles);
  ensureCleanDestination();
  copySourceFiles(beforeFiles);

  const database = new DatabaseSync(databasePath);
  database.exec(fs.readFileSync(schemaPath, 'utf8'));
  database.exec('BEGIN IMMEDIATE');

  try {
    const profileYaml = read('config/profile.yml');
    const profile = safeYaml(profileYaml);
    const narrative = read('modes/_profile.md');
    const portalsYaml = read('portals.yml');
    const portals = safeYaml(portalsYaml);
    const displayName = profile.candidate?.full_name || 'Local User';
    const email = profile.candidate?.email || null;

    database.prepare(`
      INSERT INTO users(id, email, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(localUserId, email, displayName, now, now);

    database.prepare(`
      INSERT INTO profiles(user_id, profile_json, profile_yaml, narrative_markdown, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(localUserId, JSON.stringify(profile), profileYaml, narrative || null, now);

    database.prepare(`
      INSERT INTO targeting_configs(user_id, config_json, config_yaml, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(localUserId, JSON.stringify(portals), portalsYaml, now);

    const resumeText = read('cv.md');
    if (resumeText) {
      const resumeFile = beforeFiles.find((file) => file.relativePath === 'cv.md');
      database.prepare(`
        INSERT INTO resumes(id, user_id, name, content_markdown, storage_path, sha256, is_primary, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      `).run('resume-primary', localUserId, 'Primary resume', resumeText, resumeFile.storagePath, resumeFile.sha256, now);
    }

    const applications = parseApplications();
    const applicationByNumber = new Map();
    const insertApplication = database.prepare(`
      INSERT INTO applications(
        id, user_id, legacy_number, company, role, status, score, score_raw,
        applied_on, job_url, notes, pdf_available, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'classic-import', ?, ?)
    `);
    const insertEvent = database.prepare(`
      INSERT INTO application_events(
        id, application_id, event_type, from_status, to_status, event_at, details_json
      ) VALUES (?, ?, 'imported', NULL, ?, ?, ?)
    `);
    for (const application of applications) {
      const id = `application-${application.legacyNumber}`;
      applicationByNumber.set(application.legacyNumber, id);
      insertApplication.run(
        id, localUserId, application.legacyNumber, application.company, application.role,
        application.status, application.score, application.scoreRaw, application.date,
        application.jobUrl || null, application.notes || null, application.pdfAvailable ? 1 : 0,
        application.date ? `${application.date}T00:00:00.000Z` : now, now
      );
      insertEvent.run(
        `event-import-${application.legacyNumber}`, id, application.status,
        application.date ? `${application.date}T00:00:00.000Z` : now,
        JSON.stringify({ legacyNumber: application.legacyNumber })
      );
    }

    const pipeline = parsePipeline();
    const scanHistory = parseScanHistory();
    const discoveryUrls = new Set([...pipeline.keys(), ...scanHistory.keys()]);
    const insertDiscovery = database.prepare(`
      INSERT INTO discoveries(
        id, user_id, url, company, role, portal, first_seen, scan_status,
        pipeline_status, pipeline_note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const url of discoveryUrls) {
      const pipelineRow = pipeline.get(url) || {};
      const scanRow = scanHistory.get(url) || {};
      const id = `discovery-${sha256Buffer(Buffer.from(url)).slice(0, 24)}`;
      insertDiscovery.run(
        id, localUserId, url,
        pipelineRow.company || scanRow.company || null,
        pipelineRow.role || scanRow.title || null,
        scanRow.portal || null,
        scanRow.first_seen || null,
        scanRow.status || null,
        pipelineRow.pipelineStatus || 'not-in-pipeline',
        pipelineRow.note || null,
        scanRow.first_seen ? `${scanRow.first_seen}T00:00:00.000Z` : now,
        now
      );
    }

    const insertReport = database.prepare(`
      INSERT INTO reports(
        id, user_id, application_id, legacy_number, title, score, legitimacy,
        job_url, content_markdown, storage_path, sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertDocument = database.prepare(`
      INSERT INTO documents(
        id, user_id, application_id, kind, original_name, media_type,
        storage_path, sha256, size_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertLegacyFile = database.prepare(`
      INSERT INTO legacy_files(
        id, user_id, category, source_relative_path, storage_path, sha256,
        size_bytes, source_modified_at, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const file of beforeFiles) {
      const number = applicationNumberFromPath(file.relativePath);
      const applicationId = number ? applicationByNumber.get(number) || null : null;
      const fileId = `legacy-${sha256Buffer(Buffer.from(file.relativePath)).slice(0, 24)}`;
      insertLegacyFile.run(
        fileId, localUserId, file.category, file.relativePath, file.storagePath,
        file.sha256, file.size, file.modifiedAt, now
      );

      const kind = documentKind(file.relativePath);
      if (kind !== 'legacy-file' && !file.relativePath.endsWith('/.gitkeep') && path.basename(file.relativePath) !== '.gitkeep') {
        insertDocument.run(
          `document-${sha256Buffer(Buffer.from(file.relativePath)).slice(0, 24)}`,
          localUserId, applicationId, kind, path.basename(file.relativePath),
          mediaType(file.relativePath), file.storagePath, file.sha256, file.size, now
        );
      }

      if (file.relativePath.startsWith('reports/') && file.relativePath.endsWith('.md')) {
        const markdown = fs.readFileSync(file.fullPath, 'utf8');
        const metadata = reportMetadata(markdown);
        const reportApplicationId = metadata.legacyNumber
          ? applicationByNumber.get(metadata.legacyNumber) || applicationId
          : applicationId;
        insertReport.run(
          `report-${sha256Buffer(Buffer.from(file.relativePath)).slice(0, 24)}`,
          localUserId, reportApplicationId || null, metadata.legacyNumber,
          metadata.title || path.basename(file.relativePath), metadata.score,
          metadata.legitimacy || null, metadata.jobUrl || null, markdown,
          file.storagePath, file.sha256,
          metadata.date ? `${metadata.date}T00:00:00.000Z` : now
        );
        if (reportApplicationId && metadata.jobUrl) {
          database.prepare(`
            UPDATE applications SET job_url = COALESCE(job_url, ?), updated_at = ?
            WHERE id = ?
          `).run(metadata.jobUrl, now, reportApplicationId);
        }
      }
    }

    const summary = {
      files: beforeFiles.length,
      bytes: beforeFiles.reduce((sum, file) => sum + file.size, 0),
      applications: applications.length,
      discoveries: discoveryUrls.size,
      reports: beforeFiles.filter((file) => file.relativePath.startsWith('reports/') && file.relativePath.endsWith('.md')).length,
      documents: beforeFiles.filter((file) => documentKind(file.relativePath) !== 'legacy-file' && path.basename(file.relativePath) !== '.gitkeep').length
    };
    database.prepare(`
      INSERT INTO import_runs(id, user_id, source_path, source_manifest_sha256, imported_at, summary_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(`import-${now}`, localUserId, classicRoot, beforeManifest, now, JSON.stringify(summary));

    database.prepare(`
      INSERT INTO app_settings(user_id, key, value_json, updated_at)
      VALUES (?, 'storage', ?, ?)
    `).run(localUserId, JSON.stringify({ mode: 'sqlite', filesRoot: 'files' }), now);

    database.exec('COMMIT');
    database.close();

    const afterFiles = listSourceFiles();
    const afterManifest = manifestHash(afterFiles);
    if (afterManifest !== beforeManifest) {
      throw new Error('Classic source changed during import; refusing to accept migration.');
    }

    fs.writeFileSync(path.join(dataRoot, 'import-summary.json'), JSON.stringify({
      source: classicRoot,
      database: databasePath,
      manifestSha256: beforeManifest,
      importedAt: now,
      ...summary
    }, null, 2));

    console.log(JSON.stringify({
      ok: true,
      dataRoot,
      databasePath,
      sourceManifestSha256: beforeManifest,
      ...summary
    }, null, 2));
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    database.close();
    throw error;
  }
}

main();
