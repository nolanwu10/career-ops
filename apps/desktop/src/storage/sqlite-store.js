const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const yaml = require('js-yaml');

const appRoot = path.resolve(__dirname, '..', '..');
const dataRoot = path.resolve(process.env.CAREER_OPS_APP_DATA || path.join(appRoot, 'local-data'));
const databasePath = path.join(dataRoot, 'career-ops.sqlite');
const userId = 'local-user';

function available() {
  if (!fs.existsSync(databasePath)) return false;
  ensureSchema();
  return true;
}

function ensureSchema() {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS knowledge_sources (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        label TEXT NOT NULL,
        reference_id TEXT,
        storage_path TEXT,
        sha256 TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS knowledge_sources_user_type_idx
        ON knowledge_sources(user_id, source_type);
      CREATE TABLE IF NOT EXISTS knowledge_facts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category TEXT NOT NULL,
        fact_type TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        confidence REAL NOT NULL,
        source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE RESTRICT,
        source_excerpt TEXT,
        dedupe_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        approved_at TEXT,
        UNIQUE(user_id, dedupe_hash)
      );
      CREATE INDEX IF NOT EXISTS knowledge_facts_user_status_category_idx
        ON knowledge_facts(user_id, status, category);
      CREATE TABLE IF NOT EXISTS resume_variants (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        base_resume_id TEXT REFERENCES resumes(id) ON DELETE SET NULL,
        application_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK(kind IN ('master', 'tailored')),
        name TEXT NOT NULL,
        content_markdown TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        job_context_json TEXT NOT NULL DEFAULT '{}',
        keyword_report_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS resume_variants_user_kind_idx
        ON resume_variants(user_id, kind, updated_at);
      CREATE TABLE IF NOT EXISTS resume_versions (
        id TEXT PRIMARY KEY,
        variant_id TEXT NOT NULL REFERENCES resume_variants(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL,
        content_markdown TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE(variant_id, version_number)
      );
      CREATE TABLE IF NOT EXISTS resume_suggestions (
        id TEXT PRIMARY KEY,
        variant_id TEXT NOT NULL REFERENCES resume_variants(id) ON DELETE CASCADE,
        original_text TEXT NOT NULL DEFAULT '',
        proposed_text TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      UPDATE knowledge_facts
      SET status = 'trusted',
          approved_at = COALESCE(approved_at, updated_at)
      WHERE status = 'pending';
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (2, datetime('now'));
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (3, datetime('now'));
      CREATE TABLE IF NOT EXISTS cloud_recommendations (
        recommendation_id TEXT PRIMARY KEY,
        job_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cloud_sync_outbox (
        idempotency_key TEXT PRIMARY KEY,
        recommendation_id TEXT NOT NULL,
        job_key TEXT NOT NULL,
        action TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sent_at TEXT
      );
      CREATE TABLE IF NOT EXISTS cloud_sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (4, datetime('now'));
      CREATE TABLE IF NOT EXISTS discovery_sources (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        label TEXT NOT NULL,
        source_type TEXT NOT NULL,
        last_refreshed_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, url)
      );
      CREATE TABLE IF NOT EXISTS jd_cache (
        url TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );
    `);
    const discoveryColumns = new Set(
      database.prepare('PRAGMA table_info(discoveries)').all().map((column) => column.name)
    );
    if (!discoveryColumns.has('date_posted')) {
      database.exec('ALTER TABLE discoveries ADD COLUMN date_posted TEXT');
    }
    if (!discoveryColumns.has('location')) {
      database.exec('ALTER TABLE discoveries ADD COLUMN location TEXT');
    }
    if (!discoveryColumns.has('source_label')) {
      database.exec('ALTER TABLE discoveries ADD COLUMN source_label TEXT');
    }
    database.prepare(`
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (6, datetime('now'))
    `).run();
  } finally {
    database.close();
  }
}

function withDatabase(callback, readOnly = false) {
  const database = new DatabaseSync(databasePath, { readOnly });
  try {
    database.exec('PRAGMA foreign_keys = ON');
    return callback(database);
  } finally {
    database.close();
  }
}

function absolutePath(storagePath) {
  return storagePath ? path.join(dataRoot, ...storagePath.split('/')) : '';
}

function loadSnapshot() {
  return withDatabase((database) => {
    const profile = database.prepare('SELECT profile_json FROM profiles WHERE user_id = ?').get(userId);
    const targeting = database.prepare('SELECT config_json FROM targeting_configs WHERE user_id = ?').get(userId);
    const resume = database.prepare(`
      SELECT content_markdown, storage_path FROM resumes
      WHERE user_id = ? AND is_primary = 1 LIMIT 1
    `).get(userId);
    const reports = new Map(database.prepare(`
      SELECT application_id, storage_path, title, job_url, content_markdown FROM reports
      WHERE user_id = ? AND application_id IS NOT NULL
    `).all(userId).map((row) => [row.application_id, row]));
    const docs = new Map();
    for (const row of database.prepare(`
      SELECT application_id, kind, storage_path FROM documents
      WHERE user_id = ? AND application_id IS NOT NULL
    `).all(userId)) {
      if (!docs.has(row.application_id)) docs.set(row.application_id, {});
      docs.get(row.application_id)[row.kind] = absolutePath(row.storage_path);
    }
    const applications = database.prepare(`
      SELECT applications.*,
        (
          SELECT event_at
          FROM application_events
          WHERE application_id = applications.id
            AND event_type = 'status_changed'
            AND LOWER(to_status) IN ('rejected', 'discarded', 'skip')
          ORDER BY event_at DESC
          LIMIT 1
        ) AS archived_at
      FROM applications WHERE user_id = ?
      ORDER BY legacy_number DESC, created_at DESC
    `).all(userId).map((row) => {
      const report = reports.get(row.id);
      const materials = docs.get(row.id) || {};
      return {
        id: row.id,
        number: row.legacy_number,
        date: row.applied_on || '',
        company: row.company,
        role: row.role,
        score: row.score,
        scoreRaw: row.score_raw || (row.score == null ? 'N/A' : `${row.score}/5`),
        isScored: row.score != null,
        status: row.status,
        pdf: row.pdf_available ? '✅' : '❌',
        hasPdf: Boolean(row.pdf_available),
        notes: row.notes || '',
        jobUrl: row.job_url || report?.job_url || '',
        reportPath: report ? absolutePath(report.storage_path) : '',
        reportLabel: report?.title || '',
        reportContent: report?.content_markdown || '',
        coverLetterPath: materials['cover-letter'] || '',
        coverLetterPdfPath: '',
        applyPromptPath: materials['apply-prompt'] || '',
        jobDescriptionPath: materials['job-description'] || '',
        location: '',
        workMode: '',
        payRange: '',
        lastContact: '',
        archivedAt: row.archived_at || ''
      };
    });
    const discoveries = database.prepare(`
      SELECT * FROM discoveries WHERE user_id = ?
      ORDER BY COALESCE(date_posted, '') DESC, created_at DESC
    `).all(userId);
    return {
      applications,
      pendingJobs: discoveries.filter((row) => row.pipeline_status === 'pending').map(toPendingJob),
      discoveryDecisions: discoveries
        .filter((row) => row.pipeline_status === 'processed')
        .map((row) => ({
          role: row.role || '',
          decision: /discard/i.test(row.pipeline_note || '') ? 'discarded' : 'processed'
        })),
      discoverySources: database.prepare(`
        SELECT url, label, source_type, last_refreshed_at, last_error
        FROM discovery_sources WHERE user_id = ? ORDER BY created_at ASC
      `).all(userId).map((row) => ({
        url: row.url,
        label: row.label,
        sourceType: row.source_type,
        lastRefreshedAt: row.last_refreshed_at || '',
        lastError: row.last_error || ''
      })),
      scanHistory: discoveries.map((row) => ({
        url: row.url,
        firstSeen: row.first_seen || '',
        portal: row.portal || '',
        title: row.role || '',
        company: row.company || '',
        status: row.scan_status || ''
      })),
      resume: resume?.content_markdown || '',
      resumePath: resume ? absolutePath(resume.storage_path) : '',
      profile: profile ? JSON.parse(profile.profile_json) : {},
      targeting: targeting ? JSON.parse(targeting.config_json) : {}
    };
  }, true);
}

function toPendingJob(row) {
  return {
    url: row.url,
    company: row.company || '',
    role: row.role || '',
    portal: row.portal || '',
    sourceLabel: row.source_label || '',
    firstSeen: row.first_seen || '',
    datePosted: row.date_posted || '',
    location: row.location || '',
    alreadyTracked: false
  };
}

function updateStatus(number, status) {
  withDatabase((database) => {
    const row = database.prepare(`
      SELECT id, status FROM applications WHERE user_id = ? AND legacy_number = ?
    `).get(userId, Number(number));
    if (!row) throw new Error('Application not found.');
    const now = new Date().toISOString();
    database.prepare('UPDATE applications SET status = ?, updated_at = ? WHERE id = ?').run(status, now, row.id);
    database.prepare(`
      INSERT INTO application_events(id, application_id, event_type, from_status, to_status, event_at, details_json)
      VALUES (?, ?, 'status_changed', ?, ?, ?, '{}')
    `).run(crypto.randomUUID(), row.id, row.status, status, now);
  });
}

function purgeExpiredArchivedApplications(now = new Date(), retentionDays = 21) {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const cutoffIso = cutoff.toISOString();
  const filesToDelete = withDatabase((database) => {
    const expired = database.prepare(`
      SELECT a.id
      FROM applications a
      WHERE a.user_id = ?
        AND LOWER(a.status) IN ('rejected', 'discarded', 'skip')
        AND COALESCE(
          (
            SELECT event_at
            FROM application_events e
            WHERE e.application_id = a.id
              AND e.event_type = 'status_changed'
              AND LOWER(e.to_status) IN ('rejected', 'discarded', 'skip')
            ORDER BY e.event_at DESC
            LIMIT 1
          ),
          a.updated_at
        ) < ?
    `).all(userId, cutoffIso);
    if (expired.length === 0) return [];

    const applicationIds = expired.map((row) => row.id);
    const placeholders = applicationIds.map(() => '?').join(', ');
    const storagePaths = [
      ...database.prepare(`SELECT storage_path FROM reports WHERE application_id IN (${placeholders})`).all(...applicationIds),
      ...database.prepare(`SELECT storage_path FROM documents WHERE application_id IN (${placeholders})`).all(...applicationIds)
    ].map((row) => row.storage_path).filter(Boolean);

    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare(`DELETE FROM reports WHERE application_id IN (${placeholders})`).run(...applicationIds);
      database.prepare(`DELETE FROM documents WHERE application_id IN (${placeholders})`).run(...applicationIds);
      database.prepare(`DELETE FROM applications WHERE id IN (${placeholders})`).run(...applicationIds);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return storagePaths;
  });

  for (const storagePath of filesToDelete) {
    try {
      const filePath = absolutePath(storagePath);
      if (filePath && fs.existsSync(filePath)) fs.rmSync(filePath);
    } catch {}
  }
  return filesToDelete.length;
}

function updateApplicationNotes(number, notes) {
  withDatabase((database) => {
    const result = database.prepare(`
      UPDATE applications SET notes = ?, updated_at = ?
      WHERE user_id = ? AND legacy_number = ?
    `).run(notes || null, new Date().toISOString(), userId, Number(number));
    if (result.changes === 0) throw new Error('Application not found.');
  });
}

function linkApplicationDocument(number, kind, filePath, mediaType) {
  withDatabase((database) => {
    const application = database.prepare(`
      SELECT id FROM applications WHERE user_id = ? AND legacy_number = ?
    `).get(userId, Number(number));
    if (!application) throw new Error('Application not found.');
    const resolved = path.resolve(filePath);
    const relativePath = path.relative(dataRoot, resolved).split(path.sep).join('/');
    if (relativePath.startsWith('..')) throw new Error('Document must be stored inside application data.');
    const content = fs.readFileSync(resolved);
    const now = new Date().toISOString();
    database.prepare(`
      DELETE FROM documents WHERE user_id = ? AND application_id = ? AND kind = ?
    `).run(userId, application.id, kind);
    database.prepare(`
      INSERT INTO documents(
        id, user_id, application_id, kind, original_name, media_type,
        storage_path, sha256, size_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `document-${crypto.randomUUID()}`, userId, application.id, kind,
      path.basename(resolved), mediaType || 'application/octet-stream', relativePath,
      crypto.createHash('sha256').update(content).digest('hex'), content.length, now
    );
  });
}

function saveApplicationReport({ number, today, score, legitimacy, reportMarkdown, reportName }) {
  return withDatabase((database) => {
    const application = database.prepare(`
      SELECT id, company, role, job_url FROM applications
      WHERE user_id = ? AND legacy_number = ?
    `).get(userId, Number(number));
    if (!application) throw new Error('Application not found.');
    const relativePath = path.posix.join('files', 'generated', 'reports', reportName);
    const reportPath = absolutePath(relativePath);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, reportMarkdown, 'utf8');
    const now = new Date().toISOString();
    const hash = crypto.createHash('sha256').update(reportMarkdown).digest('hex');
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare('DELETE FROM reports WHERE user_id = ? AND application_id = ?')
        .run(userId, application.id);
      database.prepare(`
        INSERT INTO reports(
          id, user_id, application_id, legacy_number, title, score, legitimacy,
          job_url, content_markdown, storage_path, sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `report-${crypto.randomUUID()}`, userId, application.id, Number(number),
        `${String(number).padStart(3, '0')} - ${application.company} - ${application.role}`,
        score, legitimacy || null, application.job_url || '', reportMarkdown,
        relativePath, hash, `${today}T00:00:00.000Z`
      );
      database.prepare(`
        UPDATE applications SET score = ?, score_raw = ?, updated_at = ? WHERE id = ?
      `).run(score, `${score.toFixed(1)}/5`, now, application.id);
      database.exec('COMMIT');
      return { reportPath };
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  });
}

function saveResume(markdown) {
  withDatabase((database) => {
    const row = database.prepare(`
      SELECT id, storage_path FROM resumes WHERE user_id = ? AND is_primary = 1 LIMIT 1
    `).get(userId);
    if (!row) throw new Error('Primary resume not found.');
    const filePath = absolutePath(row.storage_path);
    if (['.md', '.txt'].includes(path.extname(filePath).toLowerCase())) {
      fs.writeFileSync(filePath, markdown, 'utf8');
    }
    database.prepare('UPDATE resumes SET content_markdown = ?, sha256 = ? WHERE id = ?')
      .run(markdown, crypto.createHash('sha256').update(markdown).digest('hex'), row.id);
  });
}

function listResumes() {
  return withDatabase((database) => database.prepare(`
    SELECT id, name, storage_path, is_primary, created_at,
      length(COALESCE(content_markdown, '')) AS content_length
    FROM resumes WHERE user_id = ?
    ORDER BY is_primary DESC, created_at DESC
  `).all(userId).map((row) => ({
    id: row.id,
    name: row.name,
    path: absolutePath(row.storage_path),
    isPrimary: Boolean(row.is_primary),
    createdAt: row.created_at,
    contentLength: row.content_length || 0
  })), true);
}

function addResume({ name, content, storagePath }) {
  return withDatabase((database) => {
    const id = `resume-${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    const hasPrimary = Boolean(database.prepare(`
      SELECT 1 FROM resumes WHERE user_id = ? AND is_primary = 1 LIMIT 1
    `).get(userId));
    database.prepare(`
      INSERT INTO resumes(id, user_id, name, content_markdown, storage_path, sha256, is_primary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      userId,
      name,
      content,
      storagePath,
      crypto.createHash('sha256').update(content).digest('hex'),
      hasPrimary ? 0 : 1,
      createdAt
    );
    return id;
  });
}

function addKnowledgeSource({
  sourceType,
  label,
  referenceId = null,
  storagePath = null,
  sha256 = null,
  metadata = {}
}) {
  return withDatabase((database) => {
    const id = `knowledge-source-${crypto.randomUUID()}`;
    database.prepare(`
      INSERT INTO knowledge_sources(
        id, user_id, source_type, label, reference_id, storage_path, sha256, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, userId, sourceType, label, referenceId, storagePath, sha256,
      JSON.stringify(metadata || {}), new Date().toISOString()
    );
    return id;
  });
}

function addKnowledgeFacts(facts, sourceId, status = 'pending') {
  return withDatabase((database) => {
    const now = new Date().toISOString();
    const insert = database.prepare(`
      INSERT INTO knowledge_facts(
        id, user_id, category, fact_type, title, summary, details_json, status,
        confidence, source_id, source_excerpt, dedupe_hash, created_at, updated_at, approved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, dedupe_hash) DO UPDATE SET
        confidence = MAX(knowledge_facts.confidence, excluded.confidence),
        source_excerpt = COALESCE(knowledge_facts.source_excerpt, excluded.source_excerpt),
        updated_at = excluded.updated_at
    `);
    let added = 0;
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const fact of facts || []) {
        const category = String(fact.category || 'attributes').trim().toLowerCase();
        const factType = String(fact.factType || fact.fact_type || 'general').trim().toLowerCase();
        const title = String(fact.title || '').trim().slice(0, 180);
        const summary = String(fact.summary || '').trim().slice(0, 4000);
        if (!title || !summary) continue;
        const dedupeHash = crypto.createHash('sha256')
          .update([category, factType, title, summary].join('|').toLowerCase().replace(/\s+/g, ' '))
          .digest('hex');
        const result = insert.run(
          `knowledge-fact-${crypto.randomUUID()}`,
          userId,
          category,
          factType,
          title,
          summary,
          JSON.stringify(fact.details || {}),
          status,
          Math.max(0, Math.min(1, Number(fact.confidence) || 0)),
          sourceId,
          String(fact.sourceExcerpt || fact.source_excerpt || '').trim().slice(0, 2000) || null,
          dedupeHash,
          now,
          now,
          status === 'trusted' ? now : null
        );
        if (result.changes > 0) added += 1;
      }
      database.exec('COMMIT');
      return added;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  });
}

function updateKnowledgeFact(id, fact) {
  withDatabase((database) => {
    const category = String(fact.category || '').trim().toLowerCase();
    const factType = String(fact.factType || 'general').trim().toLowerCase();
    const title = String(fact.title || '').trim().slice(0, 180);
    const summary = String(fact.summary || '').trim().slice(0, 4000);
    if (!category || !title || !summary) throw new Error('Category, title, and fact are required.');
    const dedupeHash = crypto.createHash('sha256')
      .update([category, factType, title, summary].join('|').toLowerCase().replace(/\s+/g, ' '))
      .digest('hex');
    const result = database.prepare(`
      UPDATE knowledge_facts SET
        category = ?, fact_type = ?, title = ?, summary = ?, details_json = ?,
        dedupe_hash = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(
      category, factType, title, summary, JSON.stringify(fact.details || {}),
      dedupeHash, new Date().toISOString(), id, userId
    );
    if (!result.changes) throw new Error('Knowledge fact not found.');
  });
}

function updateKnowledgeRecord(factIds, {
  category,
  name,
  metadata = {}
}) {
  const ids = [...new Set((factIds || []).map(String).filter(Boolean))];
  if (!ids.length) throw new Error('Knowledge record has no editable facts.');
  const cleanCategory = String(category || '').trim().toLowerCase();
  const cleanName = String(name || '').trim().slice(0, 180);
  if (!cleanCategory || !cleanName) throw new Error('Category and record name are required.');
  withDatabase((database) => {
    const select = database.prepare(`
      SELECT id, details_json FROM knowledge_facts WHERE id = ? AND user_id = ?
    `);
    const update = database.prepare(`
      UPDATE knowledge_facts SET category = ?, details_json = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `);
    const now = new Date().toISOString();
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids) {
        const row = select.get(id, userId);
        if (!row) continue;
        const details = {
          ...JSON.parse(row.details_json || '{}'),
          ...metadata,
          entity: cleanName
        };
        update.run(cleanCategory, JSON.stringify(details), now, id, userId);
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  });
}

function clearKnowledge() {
  withDatabase((database) => {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare('DELETE FROM knowledge_facts WHERE user_id = ?').run(userId);
      database.prepare('DELETE FROM knowledge_sources WHERE user_id = ?').run(userId);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  });
}

function clearKnowledgeSource(sourceId) {
  withDatabase((database) => {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare('DELETE FROM knowledge_facts WHERE source_id = ? AND user_id = ?').run(sourceId, userId);
      database.prepare('DELETE FROM knowledge_sources WHERE id = ? AND user_id = ?').run(sourceId, userId);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  });
}

function replaceKnowledgeFactsForSourceType(sourceType, facts, {
  label,
  metadata = {}
}) {
  withDatabase((database) => {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare(`
        DELETE FROM knowledge_facts
        WHERE user_id = ? AND source_id IN (
          SELECT id FROM knowledge_sources WHERE user_id = ? AND source_type = ?
        )
      `).run(userId, userId, sourceType);
      database.prepare('DELETE FROM knowledge_sources WHERE user_id = ? AND source_type = ?')
        .run(userId, sourceType);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  });
  const sourceId = addKnowledgeSource({ sourceType, label, metadata });
  return addKnowledgeFacts(facts, sourceId, 'trusted');
}

function listKnowledgeFacts({ status = '', category = '' } = {}) {
  return withDatabase((database) => {
    const clauses = ['f.user_id = ?'];
    const params = [userId];
    if (status) {
      clauses.push('f.status = ?');
      params.push(status);
    }
    if (category) {
      clauses.push('f.category = ?');
      params.push(category);
    }
    return database.prepare(`
      SELECT f.*, s.source_type, s.label AS source_label, s.reference_id, s.storage_path,
        u.display_name AS candidate_name
      FROM knowledge_facts f
      JOIN knowledge_sources s ON s.id = f.source_id
      JOIN users u ON u.id = f.user_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY
        CASE f.status WHEN 'pending' THEN 0 WHEN 'trusted' THEN 1 ELSE 2 END,
        f.updated_at DESC
    `).all(...params).map(normalizeKnowledgeFactRow);
  }, true);
}

function normalizeKnowledgeFactRow(row) {
  const details = JSON.parse(row.details_json || '{}');
  const combined = `${row.title || ''} ${row.summary || ''} ${row.source_excerpt || ''}`;
  if (!details.entity && row.category === 'education') {
    const institution = combined.match(/\b([A-Z][A-Za-z&'.-]*(?:\s+[A-Z][A-Za-z&'.-]*)*\s+(?:University|College|Institute|School))\b/);
    if (institution) details.entity = institution[1];
  }
  const gpa = combined.match(/\bGPA(?:\s+(?:of|is|was))?\s*[:\-]?\s*(\d(?:\.\d{1,3})?)\b/i)
    || combined.match(/\b(\d(?:\.\d{1,3})?)\s*GPA\b/i);
  const normalized = normalizeBareKnowledgeFact({
    factType: row.fact_type,
    title: row.title,
    summary: row.summary,
    candidateName: row.candidate_name
  });
  return {
    id: row.id,
    category: row.category,
    factType: gpa ? 'gpa' : normalized.factType,
    title: gpa ? 'GPA' : normalized.title,
    summary: gpa ? `GPA: ${gpa[1]}` : normalized.summary,
    details,
    status: row.status,
    confidence: row.confidence,
    source: {
      id: row.source_id,
      type: row.source_type,
      label: row.source_label,
      referenceId: row.reference_id,
      path: absolutePath(row.storage_path)
    },
    sourceExcerpt: row.source_excerpt || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at
  };
}

function normalizeBareKnowledgeFact(fact) {
  let title = cleanFactText(fact.title);
  let summary = cleanFactText(fact.summary);
  const exactName = String(fact.candidateName || '').trim();
  if (exactName) {
    const escapedName = exactName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const namePrefix = new RegExp(`^${escapedName}\\s+`, 'i');
    summary = summary.replace(namePrefix, '');
    title = title.replace(namePrefix, '');
  }
  const candidatePrefix = /^(?:[A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+){1,3})\s+(?=(?:has|is|was|worked|built|created|developed|led|managed|earned|received|studied|graduated|improved|increased|reduced|launched|designed|implemented|analyzed|conducted|supported|delivered)\b)/i;
  summary = summary.replace(candidatePrefix, '');
  title = title.replace(candidatePrefix, '');
  summary = summary
    .replace(/^(?:he|she|they)\s+(?:has|have|is|was)\s+/i, '')
    .replace(/^has\s+(?:an?\s+)?/i, '')
    .replace(/^is\s+(?:an?\s+)?/i, '')
    .replace(/^was\s+(?:an?\s+)?/i, '')
    .replace(/^worked\s+as\s+(?:an?\s+)?/i, '')
    .replace(/^studied\s+(?:at|in)\s+/i, '')
    .replace(/^earned\s+(?:an?\s+)?/i, '')
    .replace(/^received\s+(?:an?\s+)?/i, '');
  title = title
    .replace(/^(?:he|she|they)\s+(?:has|have|is|was)\s+/i, '')
    .replace(/^has\s+(?:an?\s+)?/i, '')
    .replace(/^is\s+(?:an?\s+)?/i, '')
    .replace(/^was\s+(?:an?\s+)?/i, '');
  if (/^(?:fact|detail|statement|resume statement)$/i.test(title)) title = '';
  if (!title) title = factLabelFromType(fact.factType);
  return {
    factType: String(fact.factType || 'general').trim().toLowerCase(),
    title,
    summary
  };
}

function cleanFactText(value) {
  return String(value || '')
    .replace(/^[-*•]\s*/, '')
    .replace(/\s+/g, ' ')
    .replace(/[.;]+$/, '')
    .trim();
}

function factLabelFromType(value) {
  return String(value || 'fact')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function updateKnowledgeFactStatus(id, status) {
  if (!['pending', 'trusted', 'rejected'].includes(status)) throw new Error('Invalid knowledge fact status.');
  withDatabase((database) => {
    const now = new Date().toISOString();
    const result = database.prepare(`
      UPDATE knowledge_facts
      SET status = ?, updated_at = ?, approved_at = ?
      WHERE id = ? AND user_id = ?
    `).run(status, now, status === 'trusted' ? now : null, id, userId);
    if (!result.changes) throw new Error('Knowledge fact not found.');
  });
}

function deleteKnowledgeFact(id) {
  withDatabase((database) => {
    const result = database.prepare('DELETE FROM knowledge_facts WHERE id = ? AND user_id = ?').run(id, userId);
    if (!result.changes) throw new Error('Knowledge fact not found.');
  });
}

function renameResume(id, name) {
  withDatabase((database) => {
    const cleanName = String(name || '').trim().slice(0, 160);
    if (!cleanName) throw new Error('Resume name is required.');
    const result = database.prepare('UPDATE resumes SET name = ? WHERE id = ? AND user_id = ?')
      .run(cleanName, id, userId);
    if (!result.changes) throw new Error('Resume not found.');
    database.prepare(`
      UPDATE knowledge_sources SET label = ?
      WHERE user_id = ? AND source_type = 'resume' AND reference_id = ?
    `).run(cleanName, userId, id);
  });
}

function deleteResume(id) {
  return withDatabase((database) => {
    const row = database.prepare(`
      SELECT id, storage_path, is_primary FROM resumes WHERE id = ? AND user_id = ?
    `).get(id, userId);
    if (!row) throw new Error('Resume not found.');
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare(`
        DELETE FROM knowledge_facts WHERE source_id IN (
          SELECT id FROM knowledge_sources
          WHERE user_id = ? AND source_type = 'resume' AND reference_id = ?
        )
      `).run(userId, id);
      database.prepare(`
        DELETE FROM knowledge_sources
        WHERE user_id = ? AND source_type = 'resume' AND reference_id = ?
      `).run(userId, id);
      database.prepare('DELETE FROM resumes WHERE id = ? AND user_id = ?').run(id, userId);
      if (row.is_primary) {
        const next = database.prepare(`
          SELECT id FROM resumes WHERE user_id = ? ORDER BY created_at DESC LIMIT 1
        `).get(userId);
        if (next) database.prepare('UPDATE resumes SET is_primary = 1 WHERE id = ?').run(next.id);
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    const filePath = absolutePath(row.storage_path);
    try {
      if (filePath && fs.existsSync(filePath)) fs.rmSync(filePath);
    } catch {}
    return { deletedPrimary: Boolean(row.is_primary) };
  });
}

function deleteResumeVariant(id) {
  return withDatabase((database) => {
    const row = database.prepare(`
      SELECT id FROM resume_variants WHERE id = ? AND user_id = ?
    `).get(id, userId);
    if (!row) throw new Error('Resume builder variant not found.');
    database.prepare('DELETE FROM resume_variants WHERE id = ? AND user_id = ?').run(id, userId);
  });
}

function knowledgeSummary() {
  const facts = listKnowledgeFacts();
  const counts = { total: facts.length, pending: 0, trusted: 0, rejected: 0 };
  const categories = {};
  for (const fact of facts) {
    counts[fact.status] = (counts[fact.status] || 0) + 1;
    categories[fact.category] = (categories[fact.category] || 0) + 1;
  }
  return { facts, counts, categories };
}

function setPrimaryResume(id) {
  withDatabase((database) => {
    const resume = database.prepare('SELECT id FROM resumes WHERE user_id = ? AND id = ?').get(userId, id);
    if (!resume) throw new Error('Resume not found.');
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare('UPDATE resumes SET is_primary = 0 WHERE user_id = ?').run(userId);
      database.prepare('UPDATE resumes SET is_primary = 1 WHERE user_id = ? AND id = ?').run(userId, id);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  });
}

function getResume(id) {
  return withDatabase((database) => {
    const row = database.prepare(`
      SELECT id, name, content_markdown, storage_path, is_primary, created_at
      FROM resumes WHERE user_id = ? AND id = ?
    `).get(userId, id);
    if (!row) throw new Error('Resume not found.');
    return {
      id: row.id,
      name: row.name,
      content: row.content_markdown || '',
      path: absolutePath(row.storage_path),
      isPrimary: Boolean(row.is_primary),
      createdAt: row.created_at
    };
  }, true);
}

function listResumeVariants() {
  return withDatabase((database) => database.prepare(`
    SELECT rv.*, a.company, a.role,
      (SELECT COUNT(*) FROM resume_versions v WHERE v.variant_id = rv.id) AS version_count
    FROM resume_variants rv
    LEFT JOIN applications a ON a.id = rv.application_id
    WHERE rv.user_id = ?
    ORDER BY rv.kind ASC, rv.updated_at DESC
  `).all(userId).map(mapResumeVariant), true);
}

function getResumeVariant(id) {
  return withDatabase((database) => {
    const row = database.prepare(`
      SELECT rv.*, a.company, a.role
      FROM resume_variants rv
      LEFT JOIN applications a ON a.id = rv.application_id
      WHERE rv.user_id = ? AND rv.id = ?
    `).get(userId, id);
    if (!row) throw new Error('Resume variant not found.');
    const suggestions = database.prepare(`
      SELECT * FROM resume_suggestions WHERE variant_id = ? ORDER BY created_at ASC
    `).all(id).map((item) => ({
      id: item.id,
      originalText: item.original_text,
      proposedText: item.proposed_text,
      reason: item.reason,
      evidence: JSON.parse(item.evidence_json || '[]'),
      status: item.status,
      createdAt: item.created_at,
      decidedAt: item.decided_at
    }));
    const versions = database.prepare(`
      SELECT id, version_number, metadata_json, created_at
      FROM resume_versions WHERE variant_id = ? ORDER BY version_number DESC
    `).all(id).map((item) => ({
      id: item.id,
      number: item.version_number,
      metadata: JSON.parse(item.metadata_json || '{}'),
      createdAt: item.created_at
    }));
    return { ...mapResumeVariant(row), suggestions, versions };
  }, true);
}

function createResumeVariant({
  baseResumeId,
  applicationId = null,
  kind,
  name,
  content,
  jobContext = {},
  keywordReport = {},
  suggestions = []
}) {
  return withDatabase((database) => {
    const id = `resume-variant-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare(`
        INSERT INTO resume_variants(
          id, user_id, base_resume_id, application_id, kind, name, content_markdown,
          status, job_context_json, keyword_report_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)
      `).run(
        id, userId, baseResumeId || null, applicationId || null, kind, name, content,
        JSON.stringify(jobContext), JSON.stringify(keywordReport), now, now
      );
      database.prepare(`
        INSERT INTO resume_versions(id, variant_id, version_number, content_markdown, metadata_json, created_at)
        VALUES (?, ?, 1, ?, ?, ?)
      `).run(`resume-version-${crypto.randomUUID()}`, id, content, JSON.stringify({ action: 'created' }), now);
      const insertSuggestion = database.prepare(`
        INSERT INTO resume_suggestions(
          id, variant_id, original_text, proposed_text, reason, evidence_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
      `);
      for (const suggestion of suggestions) {
        insertSuggestion.run(
          `resume-suggestion-${crypto.randomUUID()}`, id, suggestion.originalText || '', suggestion.proposedText,
          suggestion.reason, JSON.stringify(suggestion.evidence || []), now
        );
      }
      database.exec('COMMIT');
      return id;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  });
}

function saveResumeVariant(id, content, metadata = {}) {
  withDatabase((database) => {
    const variant = database.prepare(`
      SELECT id, job_context_json FROM resume_variants WHERE id = ? AND user_id = ?
    `).get(id, userId);
    if (!variant) throw new Error('Resume variant not found.');
    const nextVersion = database.prepare(`
      SELECT COALESCE(MAX(version_number), 0) + 1 AS number FROM resume_versions WHERE variant_id = ?
    `).get(id).number;
    const now = new Date().toISOString();
    database.exec('BEGIN IMMEDIATE');
    try {
      const jobContext = JSON.parse(variant.job_context_json || '{}');
      if (metadata.pdfEdits && typeof metadata.pdfEdits === 'object') {
        jobContext.pdfEdits = metadata.pdfEdits;
      }
      database.prepare(`
        UPDATE resume_variants
        SET content_markdown = ?, job_context_json = ?, updated_at = ?
        WHERE id = ?
      `).run(content, JSON.stringify(jobContext), now, id);
      database.prepare(`
        INSERT INTO resume_versions(id, variant_id, version_number, content_markdown, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        `resume-version-${crypto.randomUUID()}`, id, nextVersion, content,
        JSON.stringify(metadata), now
      );
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  });
}

function decideResumeSuggestion(variantId, suggestionId, decision) {
  return withDatabase((database) => {
    const suggestion = database.prepare(`
      SELECT rs.* FROM resume_suggestions rs
      JOIN resume_variants rv ON rv.id = rs.variant_id
      WHERE rs.id = ? AND rs.variant_id = ? AND rv.user_id = ?
    `).get(suggestionId, variantId, userId);
    if (!suggestion) throw new Error('Resume suggestion not found.');
    if (suggestion.status !== 'pending') return getResumeVariant(variantId);
    const variant = database.prepare('SELECT content_markdown FROM resume_variants WHERE id = ?').get(variantId);
    let content = variant.content_markdown;
    if (decision === 'accepted') {
      content = applyTargetedResumeSuggestion(content, suggestion);
    }
    const now = new Date().toISOString();
    const nextVersion = database.prepare(`
      SELECT COALESCE(MAX(version_number), 0) + 1 AS number FROM resume_versions WHERE variant_id = ?
    `).get(variantId).number;
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare(`
        UPDATE resume_suggestions SET status = ?, decided_at = ? WHERE id = ?
      `).run(decision, now, suggestionId);
      database.prepare(`
        UPDATE resume_variants SET content_markdown = ?, updated_at = ? WHERE id = ?
      `).run(content, now, variantId);
      database.prepare(`
        INSERT INTO resume_versions(id, variant_id, version_number, content_markdown, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        `resume-version-${crypto.randomUUID()}`, variantId, nextVersion, content,
        JSON.stringify({ action: decision, suggestionId }), now
      );
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return getResumeVariant(variantId);
  });
}

function applyTargetedResumeSuggestion(content, suggestion) {
  const originalText = String(suggestion.original_text || '');
  const proposedText = String(suggestion.proposed_text || '');
  if (!originalText.trim()) return content;
  const source = String(content || '');
  const index = source.indexOf(originalText);
  if (index === -1) {
    throw new Error('Suggested resume line no longer matches this draft. Refresh the tailored resume and try again.');
  }
  return `${source.slice(0, index)}${proposedText}${source.slice(index + originalText.length)}`;
}

function mapResumeVariant(row) {
  return {
    id: row.id,
    baseResumeId: row.base_resume_id,
    applicationId: row.application_id,
    kind: row.kind,
    name: row.name,
    content: row.content_markdown,
    status: row.status,
    jobContext: JSON.parse(row.job_context_json || '{}'),
    keywordReport: JSON.parse(row.keyword_report_json || '{}'),
    company: row.company || '',
    role: row.role || '',
    versionCount: row.version_count || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function saveTargetKeywords(keywords) {
  withDatabase((database) => {
    const row = database.prepare('SELECT config_json FROM targeting_configs WHERE user_id = ?').get(userId);
    const config = row ? JSON.parse(row.config_json) : {};
    config.title_filter ||= {};
    config.title_filter.positive = keywords;
    database.prepare(`
      INSERT INTO targeting_configs(user_id, config_json, config_yaml, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        config_json = excluded.config_json,
        config_yaml = excluded.config_yaml,
        updated_at = excluded.updated_at
    `).run(userId, JSON.stringify(config), yaml.dump(config), new Date().toISOString());
  });
}

function addPendingJob(job) {
  withDatabase((database) => {
    const now = new Date().toISOString();
    const id = `discovery-${crypto.createHash('sha256').update(job.url).digest('hex').slice(0, 24)}`;
    database.prepare(`
      INSERT INTO discoveries(
        id, user_id, url, company, role, portal, first_seen, date_posted, location, scan_status,
        pipeline_status, pipeline_note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'pending', NULL, ?, ?)
      ON CONFLICT(user_id, url) DO UPDATE SET
        company = excluded.company, role = excluded.role,
        date_posted = COALESCE(excluded.date_posted, date_posted),
        location = COALESCE(excluded.location, location),
        pipeline_status = 'pending', updated_at = excluded.updated_at
    `).run(
      id, userId, job.url, job.company, job.role, job.portal || 'manual',
      now.slice(0, 10), job.datePosted || null, job.location || null, now, now
    );
  });
}

function importScanDiscoveries(discoveries) {
  return withDatabase((database) => {
    const now = new Date().toISOString();
    const existing = database.prepare(`
      SELECT pipeline_status FROM discoveries WHERE user_id = ? AND url = ?
    `);
    const insert = database.prepare(`
      INSERT INTO discoveries(
        id, user_id, url, company, role, portal, source_label, first_seen, date_posted, location, scan_status,
        pipeline_status, pipeline_note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `);
    const update = database.prepare(`
      UPDATE discoveries SET
        company = COALESCE(NULLIF(?, ''), company),
        role = COALESCE(NULLIF(?, ''), role),
        portal = COALESCE(NULLIF(?, ''), portal),
        source_label = COALESCE(NULLIF(?, ''), source_label),
        first_seen = COALESCE(NULLIF(?, ''), first_seen),
        date_posted = COALESCE(NULLIF(?, ''), date_posted),
        location = COALESCE(NULLIF(?, ''), location),
        scan_status = COALESCE(NULLIF(?, ''), scan_status),
        updated_at = ?
      WHERE user_id = ? AND url = ?
    `);
    let added = 0;
    let recorded = 0;
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const row of discoveries) {
        if (!row?.url) continue;
        const current = existing.get(userId, row.url);
        if (current) {
          update.run(
            row.company || '', row.title || row.role || '', row.portal || '',
            row.sourceLabel || '',
            row.firstSeen || '', row.datePosted || '', row.location || '',
            row.status || '', now, userId, row.url
          );
          continue;
        }
        const isPending = String(row.status || '').toLowerCase() === 'added';
        insert.run(
          `discovery-${crypto.createHash('sha256').update(row.url).digest('hex').slice(0, 24)}`,
          userId, row.url, row.company || null, row.title || row.role || null,
          row.portal || null, row.sourceLabel || null, row.firstSeen || null, row.datePosted || null,
          row.location || null, row.status || null,
          isPending ? 'pending' : 'not-in-pipeline', now, now
        );
        recorded += 1;
        if (isPending) added += 1;
      }
      database.exec('COMMIT');
      return { added, recorded };
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  });
}

function discardPending(urls) {
  withDatabase((database) => {
    const statement = database.prepare(`
      UPDATE discoveries SET pipeline_status = 'processed',
        pipeline_note = 'Discarded from dashboard', updated_at = ?
      WHERE user_id = ? AND url = ?
    `);
    const now = new Date().toISOString();
    for (const url of urls) statement.run(now, userId, url);
  });
}

function saveDiscoverySource({ url, label, sourceType, error = '' }) {
  withDatabase((database) => {
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO discovery_sources(
        id, user_id, url, label, source_type, last_refreshed_at,
        last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, url) DO UPDATE SET
        label = excluded.label,
        source_type = excluded.source_type,
        last_refreshed_at = excluded.last_refreshed_at,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(
      `source-${crypto.createHash('sha256').update(url).digest('hex').slice(0, 24)}`,
      userId, url, label || new URL(url).hostname, sourceType || 'html',
      error ? null : now, error || null, now, now
    );
  });
}

function listDiscoverySources() {
  return withDatabase((database) => database.prepare(`
    SELECT url, label, source_type, last_refreshed_at, last_error
    FROM discovery_sources WHERE user_id = ? ORDER BY created_at ASC
  `).all(userId).map((row) => ({
    url: row.url,
    label: row.label,
    sourceType: row.source_type,
    lastRefreshedAt: row.last_refreshed_at || '',
    lastError: row.last_error || ''
  })), true);
}

function deleteDiscoverySource(url) {
  withDatabase((database) => {
    database.prepare(
      'DELETE FROM discovery_sources WHERE user_id = ? AND url = ?'
    ).run(userId, url);
  });
}

function updateDiscoverySourceLabel(url, label) {
  withDatabase((database) => {
    database.prepare(`
      UPDATE discovery_sources SET label = ?, updated_at = ?
      WHERE user_id = ? AND url = ?
    `).run(label, new Date().toISOString(), userId, url);
  });
}

function processPending(url, note) {
  withDatabase((database) => {
    database.prepare(`
      UPDATE discoveries SET pipeline_status = 'processed',
        pipeline_note = ?, updated_at = ?
      WHERE user_id = ? AND url = ?
    `).run(note || null, new Date().toISOString(), userId, url);
  });
}

function saveEvaluation({ job, reportNum, today, score, legitimacy, notes, reportMarkdown, reportName, jobDescription = '' }) {
  const relativePath = path.posix.join('files', 'generated', 'reports', reportName);
  const reportPath = absolutePath(relativePath);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, reportMarkdown, 'utf8');
  const hash = crypto.createHash('sha256').update(reportMarkdown).digest('hex');
  const shouldStoreJobDescription = score >= 3 && String(jobDescription || '').trim();
  const jobDescriptionName = `${String(reportNum).padStart(3, '0')}-${slug(job.company)}-${slug(job.role)}.md`;
  const jobDescriptionRelativePath = shouldStoreJobDescription
    ? path.posix.join('files', 'generated', 'job-descriptions', jobDescriptionName)
    : '';
  const jobDescriptionPath = absolutePath(jobDescriptionRelativePath);
  const jobDescriptionContent = shouldStoreJobDescription
    ? formatJobDescription(job, jobDescription)
    : '';
  if (jobDescriptionContent) {
    fs.mkdirSync(path.dirname(jobDescriptionPath), { recursive: true });
    fs.writeFileSync(jobDescriptionPath, jobDescriptionContent, 'utf8');
  }

  try {
    return withDatabase((database) => {
      const now = new Date().toISOString();
      const applicationId = `application-${crypto.randomUUID()}`;
      const reportId = `report-${crypto.randomUUID()}`;
      database.exec('BEGIN IMMEDIATE');
      try {
        const existing = database.prepare(`
          SELECT id, legacy_number FROM applications
          WHERE user_id = ? AND lower(rtrim(COALESCE(job_url, ''), '/')) = lower(rtrim(?, '/'))
          LIMIT 1
        `).get(userId, job.url);
        if (existing) {
          database.prepare(`
            UPDATE discoveries SET pipeline_status = 'processed',
              pipeline_note = ?, updated_at = ?
            WHERE user_id = ? AND url = ?
          `).run(`#${String(existing.legacy_number).padStart(3, '0')} | already evaluated`, now, userId, job.url);
          database.exec('COMMIT');
          try { if (jobDescriptionPath) fs.rmSync(jobDescriptionPath); } catch {}
          return {
            duplicate: true,
            reportNum: existing.legacy_number,
            reportPath: ''
          };
        }

        database.prepare(`
          INSERT INTO applications(
            id, user_id, legacy_number, company, role, status, score, score_raw,
            applied_on, job_url, notes, pdf_available, source, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, 'desktop-evaluation', ?, ?)
        `).run(
          applicationId, userId, reportNum, job.company || 'Unknown', job.role || 'Unknown',
          score < 3 ? 'SKIP' : 'Evaluated', score, `${score.toFixed(1)}/5`,
          job.url, notes || null, now, now
        );
        database.prepare(`
          INSERT INTO application_events(
            id, application_id, event_type, from_status, to_status, event_at, details_json
          ) VALUES (?, ?, 'evaluated', NULL, ?, ?, ?)
        `).run(
          crypto.randomUUID(), applicationId, score < 3 ? 'SKIP' : 'Evaluated',
          now, JSON.stringify({ score, legitimacy, source: 'desktop' })
        );
        database.prepare(`
          INSERT INTO reports(
            id, user_id, application_id, legacy_number, title, score, legitimacy,
            job_url, content_markdown, storage_path, sha256, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          reportId, userId, applicationId, reportNum,
          `${String(reportNum).padStart(3, '0')} - ${job.company} - ${job.role}`,
          score, legitimacy || null, job.url, reportMarkdown, relativePath, hash,
          `${today}T00:00:00.000Z`
        );
        if (jobDescriptionContent) {
          database.prepare(`
            INSERT INTO documents(
              id, user_id, application_id, kind, original_name, media_type,
              storage_path, sha256, size_bytes, created_at
            ) VALUES (?, ?, ?, 'job-description', ?, 'text/markdown', ?, ?, ?, ?)
          `).run(
            `document-${crypto.randomUUID()}`, userId, applicationId, jobDescriptionName,
            jobDescriptionRelativePath,
            crypto.createHash('sha256').update(jobDescriptionContent).digest('hex'),
            Buffer.byteLength(jobDescriptionContent),
            now
          );
        }
        database.prepare(`
          UPDATE discoveries SET pipeline_status = 'processed',
            pipeline_note = ?, updated_at = ?
          WHERE user_id = ? AND url = ?
        `).run(
          `#${String(reportNum).padStart(3, '0')} | ${score.toFixed(1)}/5 | ${legitimacy}`,
          now, userId, job.url
        );
        database.exec('COMMIT');
        return { duplicate: false, reportNum, reportPath, jobDescriptionPath };
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    });
  } catch (error) {
    try { fs.rmSync(reportPath); } catch {}
    try { if (jobDescriptionPath) fs.rmSync(jobDescriptionPath); } catch {}
    throw error;
  }
}

function formatJobDescription(job, content) {
  return [
    `# ${job.company || 'Unknown'} - ${job.role || 'Unknown'}`,
    '',
    `**URL:** ${job.url || ''}`,
    '',
    '## Job Description',
    '',
    String(content || '').trim(),
    ''
  ].join('\n');
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'job';
}

function nextApplicationNumber() {
  return withDatabase((database) => database.prepare(`
    SELECT COALESCE(MAX(legacy_number), 0) + 1 AS number
    FROM applications WHERE user_id = ?
  `).get(userId).number, true);
}

function logExternalApplication(application) {
  return withDatabase((database) => {
    const normalizedUrl = application.url.replace(/\/$/, '').toLowerCase();
    const existing = database.prepare(`
      SELECT id, legacy_number, notes FROM applications
      WHERE user_id = ? AND (
        lower(rtrim(COALESCE(job_url, ''), '/')) = ?
        OR (lower(company) = lower(?) AND lower(role) = lower(?))
      ) LIMIT 1
    `).get(userId, normalizedUrl, application.company, application.role);
    const now = new Date().toISOString();
    if (existing) {
      const notes = existing.notes?.includes(application.url)
        ? existing.notes
        : [existing.notes, application.notes].filter(Boolean).join(' ');
      database.prepare(`
        UPDATE applications SET status = 'Applied', applied_on = ?, job_url = ?,
          notes = ?, updated_at = ? WHERE id = ?
      `).run(application.appliedAt, application.url, notes, now, existing.id);
      return { duplicate: true, number: existing.legacy_number };
    }
    const next = database.prepare(`
      SELECT COALESCE(MAX(legacy_number), 0) + 1 AS number FROM applications WHERE user_id = ?
    `).get(userId).number;
    const id = `application-${next}`;
    database.prepare(`
      INSERT INTO applications(
        id, user_id, legacy_number, company, role, status, score, score_raw,
        applied_on, job_url, notes, pdf_available, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'Applied', NULL, 'N/A', ?, ?, ?, 0, ?, ?, ?)
    `).run(id, userId, next, application.company, application.role, application.appliedAt,
      application.url, application.notes, application.source, now, now);
    database.prepare(`
      INSERT INTO application_events(id, application_id, event_type, from_status, to_status, event_at, details_json)
      VALUES (?, ?, 'created', NULL, 'Applied', ?, ?)
    `).run(crypto.randomUUID(), id, now, JSON.stringify({ source: application.source }));
    return { duplicate: false, number: next };
  });
}

function diagnostics() {
  return {
    valid: available(),
    storage: 'sqlite',
    databasePath,
    dataRoot,
    checks: { 'career-ops.sqlite': available() }
  };
}

function cacheCloudFeed(feed) {
  ensureSchema();
  withDatabase((database) => {
    database.exec('BEGIN IMMEDIATE');
    try {
      const upsert = database.prepare(`
        INSERT INTO cloud_recommendations(recommendation_id, job_key, payload_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(recommendation_id) DO UPDATE SET
          job_key = excluded.job_key,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `);
      for (const item of feed.items || []) {
        upsert.run(
          item.recommendation.recommendationId,
          item.recommendation.jobKey,
          JSON.stringify(item),
          item.recommendation.updatedAt
        );
      }
      database.prepare(`
        INSERT INTO cloud_sync_state(key, value, updated_at) VALUES ('cursor', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(feed.cursor || '', feed.syncedAt);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  });
}

function clearCloudFeed() {
  ensureSchema();
  withDatabase((database) => {
    database.prepare('DELETE FROM cloud_recommendations').run();
    database.prepare(`DELETE FROM cloud_sync_state WHERE key = 'cursor'`).run();
  });
}

function loadCloudFeed() {
  ensureSchema();
  return withDatabase((database) => ({
    items: database.prepare(`
      SELECT payload_json FROM cloud_recommendations
      ORDER BY json_extract(payload_json, '$.recommendation.fitScore') DESC,
        updated_at DESC
    `).all().map((row) => JSON.parse(row.payload_json)),
    cursor: database.prepare(`SELECT value FROM cloud_sync_state WHERE key = 'cursor'`).get()?.value || '',
    syncedAt: database.prepare(`SELECT updated_at FROM cloud_sync_state WHERE key = 'cursor'`).get()?.updated_at || '',
  }), true);
}

function queueCloudAction({ recommendationId, jobKey, action }) {
  ensureSchema();
  const idempotencyKey = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  withDatabase((database) => database.prepare(`
    INSERT INTO cloud_sync_outbox(
      idempotency_key, recommendation_id, job_key, action, created_at, sent_at
    ) VALUES (?, ?, ?, ?, ?, NULL)
  `).run(idempotencyKey, recommendationId, jobKey, action, createdAt));
  return { idempotencyKey, recommendationId, jobKey, action, createdAt };
}

function pendingCloudActions() {
  ensureSchema();
  return withDatabase((database) => database.prepare(`
    SELECT idempotency_key, recommendation_id, job_key, action, created_at
    FROM cloud_sync_outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT 100
  `).all().map((row) => ({
    idempotencyKey: row.idempotency_key,
    recommendationId: row.recommendation_id,
    jobKey: row.job_key,
    action: row.action,
    createdAt: row.created_at
  })), true);
}

function markCloudActionsSent(ids) {
  if (!ids.length) return;
  withDatabase((database) => {
    const statement = database.prepare(`
      UPDATE cloud_sync_outbox SET sent_at = ? WHERE idempotency_key = ?
    `);
    const now = new Date().toISOString();
    for (const id of ids) statement.run(now, id);
  });
}

function getCachedJobDescription(url) {
  return withDatabase((database) => {
    const row = database.prepare('SELECT content FROM jd_cache WHERE url = ?').get(url);
    return row ? row.content : null;
  }, true);
}

function setCachedJobDescription(url, content) {
  withDatabase((database) => {
    database.prepare(
      "INSERT OR REPLACE INTO jd_cache(url, content, fetched_at) VALUES(?, ?, datetime('now'))"
    ).run(url, content);
  });
}

module.exports = {
  available,
  ensureSchema,
  dataRoot,
  loadSnapshot,
  updateStatus,
  purgeExpiredArchivedApplications,
  updateApplicationNotes,
  linkApplicationDocument,
  saveApplicationReport,
  saveResume,
  listResumes,
  addResume,
  setPrimaryResume,
  getResume,
  listResumeVariants,
  getResumeVariant,
  createResumeVariant,
  saveResumeVariant,
  decideResumeSuggestion,
  deleteResumeVariant,
  renameResume,
  deleteResume,
  addKnowledgeSource,
  addKnowledgeFacts,
  updateKnowledgeFact,
  updateKnowledgeRecord,
  clearKnowledge,
  clearKnowledgeSource,
  replaceKnowledgeFactsForSourceType,
  listKnowledgeFacts,
  updateKnowledgeFactStatus,
  deleteKnowledgeFact,
  knowledgeSummary,
  saveTargetKeywords,
  addPendingJob,
  importScanDiscoveries,
  saveDiscoverySource,
  listDiscoverySources,
  deleteDiscoverySource,
  updateDiscoverySourceLabel,
  discardPending,
  processPending,
  saveEvaluation,
  nextApplicationNumber,
  logExternalApplication,
  cacheCloudFeed,
  clearCloudFeed,
  loadCloudFeed,
  queueCloudAction,
  pendingCloudActions,
  markCloudActionsSent,
  diagnostics,
  getCachedJobDescription,
  setCachedJobDescription
};
