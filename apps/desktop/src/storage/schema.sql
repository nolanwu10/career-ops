PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  profile_json TEXT NOT NULL,
  profile_yaml TEXT NOT NULL,
  narrative_markdown TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resumes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content_markdown TEXT,
  storage_path TEXT,
  sha256 TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  legacy_number INTEGER,
  company TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  score REAL,
  score_raw TEXT,
  applied_on TEXT,
  job_url TEXT,
  notes TEXT,
  pdf_available INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'classic-import',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, legacy_number)
);

CREATE INDEX IF NOT EXISTS applications_user_status_idx
  ON applications(user_id, status);

CREATE TABLE IF NOT EXISTS application_events (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  event_at TEXT NOT NULL,
  details_json TEXT
);

CREATE TABLE IF NOT EXISTS discoveries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  company TEXT,
  role TEXT,
  portal TEXT,
  first_seen TEXT,
  date_posted TEXT,
  location TEXT,
  scan_status TEXT,
  pipeline_status TEXT,
  pipeline_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, url)
);

CREATE INDEX IF NOT EXISTS discoveries_user_status_idx
  ON discoveries(user_id, pipeline_status, scan_status);

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

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
  legacy_number INTEGER,
  title TEXT,
  score REAL,
  legitimacy TEXT,
  job_url TEXT,
  content_markdown TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  original_name TEXT NOT NULL,
  media_type TEXT,
  storage_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS documents_application_kind_idx
  ON documents(application_id, kind);

CREATE TABLE IF NOT EXISTS targeting_configs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  config_json TEXT NOT NULL,
  config_yaml TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, key)
);

CREATE TABLE IF NOT EXISTS legacy_files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  source_relative_path TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  source_modified_at TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  UNIQUE(user_id, source_relative_path)
);

CREATE TABLE IF NOT EXISTS import_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_path TEXT NOT NULL,
  source_manifest_sha256 TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  summary_json TEXT NOT NULL
);

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

UPDATE knowledge_facts
SET status = 'trusted',
    approved_at = COALESCE(approved_at, updated_at)
WHERE status = 'pending';

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (1, datetime('now'));

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
