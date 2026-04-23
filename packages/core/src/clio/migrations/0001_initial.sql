-- Clio initial schema (plan item 5.7, design doc §5).
--
-- Ported from cerefox/src/cerefox/db/schema.sql @(2026-04) -- Postgres +
-- pgvector + tsvector -> SQLite + sqlite-vec + FTS5. Maintained
-- independently in cf².
--
-- Scope note: PR1 of Clio ships FTS5-only search. Vector columns and
-- sqlite-vec integration land in PR2. We still declare the `embedding`,
-- `embedder`, and `embedding_dim` columns now so PR2 doesn't need a
-- schema migration -- PR2 just starts populating them and adds a
-- sqlite-vec virtual table + hybrid search query.
--
-- Divergences from Cerefox:
--   - One-to-many docs->projects (project_id FK on documents) instead
--     of the M2M junction table. Clio workspaces map 1:1 to a Project;
--     user ingests pick one. Simpler queries, no junction.
--   - `source_path` merged into `source` (free-text).
--   - TEXT timestamps (SQLite) instead of TIMESTAMPTZ.
--   - metadata/heading_path are TEXT (JSON) instead of JSONB / TEXT[].
--   - No generated FTS column: the FTS5 virtual table + triggers keep
--     the index in sync with clio_chunks.content.
--   - Versioning / audit-log tables land in schema now but their full
--     write paths + RPCs are v2. Having the tables present means v1
--     ingests don't need a later schema migration.

-- ── Projects ────────────────────────────────────────────────────────────
-- Domain grouping. Matches Cerefox's `Project` concept. A workspace is
-- assigned to exactly one Project; user-ingested docs are tagged to one
-- Project. Cross-Project queries are explicit.

CREATE TABLE IF NOT EXISTS clio_projects (
  id          TEXT PRIMARY KEY,           -- UUID v4
  name        TEXT NOT NULL UNIQUE,        -- user-facing slug / display name
  description TEXT,
  metadata    TEXT NOT NULL DEFAULT '{}',  -- JSON
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ── Documents ───────────────────────────────────────────────────────────
-- One row per ingested artifact: iteration-log, iteration-handoff,
-- judge-assessment, reflection-analysis, decision-log entry,
-- architect-review, iteration-summary, or any user-ingested Markdown.

CREATE TABLE IF NOT EXISTS clio_documents (
  id            TEXT PRIMARY KEY,          -- UUID v4
  project_id    TEXT NOT NULL REFERENCES clio_projects(id) ON DELETE RESTRICT,
  title         TEXT NOT NULL,
  source        TEXT NOT NULL,             -- free-text origin hint
                                           --   e.g. "cfcf-docs/iteration-logs/iteration-3.md"
                                           --   or "user-ingest: /path/to/note.md"
                                           --   or "stdin" for piped ingests
  content_hash  TEXT NOT NULL UNIQUE,      -- sha256 of the full Markdown body; dedup guard
  metadata      TEXT NOT NULL DEFAULT '{}', -- JSON blob; filterable via json_extract
  review_status TEXT NOT NULL DEFAULT 'approved'
                CHECK (review_status IN ('approved', 'pending_review')),
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  total_chars   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    TEXT DEFAULT NULL          -- soft delete (v2); NULL = active
);

CREATE INDEX IF NOT EXISTS clio_documents_project_idx ON clio_documents(project_id);
CREATE INDEX IF NOT EXISTS clio_documents_deleted_idx
  ON clio_documents(deleted_at) WHERE deleted_at IS NOT NULL;

-- ── Document versions (v2 feature; table shape here so v1 ingests don't
-- ── need a later schema migration) ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS clio_document_versions (
  id              TEXT PRIMARY KEY,
  document_id     TEXT NOT NULL REFERENCES clio_documents(id) ON DELETE CASCADE,
  version_number  INTEGER NOT NULL,
  source          TEXT,
  metadata        TEXT NOT NULL DEFAULT '{}',
  chunk_count     INTEGER NOT NULL DEFAULT 0,
  total_chars     INTEGER NOT NULL DEFAULT 0,
  archived        INTEGER NOT NULL DEFAULT 0,  -- protect specific versions from retention cleanup
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (document_id, version_number)
);

-- ── Chunks ──────────────────────────────────────────────────────────────
-- Search corpus. One row per chunk.
-- version_id IS NULL = current chunk (indexed + searchable).
-- version_id NOT NULL = archived under that document version; still
-- retrievable, not FTS-indexed.

CREATE TABLE IF NOT EXISTS clio_chunks (
  id             TEXT PRIMARY KEY,         -- UUID v4
  document_id    TEXT NOT NULL REFERENCES clio_documents(id) ON DELETE CASCADE,
  version_id     TEXT REFERENCES clio_document_versions(id) ON DELETE CASCADE,
  chunk_index    INTEGER NOT NULL,
  heading_path   TEXT NOT NULL DEFAULT '[]',  -- JSON array of heading titles
  heading_level  INTEGER,                     -- 0 = preamble/merged; 1-3 = H1-H3
  title          TEXT,                        -- deepest heading for this chunk
  content        TEXT NOT NULL,
  char_count     INTEGER NOT NULL,
  -- PR2 fields: declared now, populated when embedder lands.
  embedding      BLOB,                        -- sqlite-vec FLOAT[dim]
  embedder       TEXT,                        -- e.g. "bge-small-en-v1.5"
  embedding_dim  INTEGER,                     -- e.g. 384
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Only one current chunk per (document_id, chunk_index); archived
-- chunks may share chunk_index across versions.
CREATE UNIQUE INDEX IF NOT EXISTS clio_chunks_current_idx
  ON clio_chunks(document_id, chunk_index) WHERE version_id IS NULL;

CREATE INDEX IF NOT EXISTS clio_chunks_doc_idx ON clio_chunks(document_id);
CREATE INDEX IF NOT EXISTS clio_chunks_version_idx
  ON clio_chunks(version_id, chunk_index) WHERE version_id IS NOT NULL;

-- ── FTS5 virtual table (keyword search side of hybrid) ──────────────────
-- Contentless FTS5 that we sync via triggers. content='clio_chunks'
-- means FTS5 reads the `content` column from `clio_chunks` via rowid.

CREATE VIRTUAL TABLE IF NOT EXISTS clio_chunks_fts USING fts5(
  content,
  title,
  content='clio_chunks',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Sync triggers: only index current chunks (version_id IS NULL).
-- Archived chunks are excluded.

CREATE TRIGGER IF NOT EXISTS clio_chunks_fts_ai AFTER INSERT ON clio_chunks
WHEN new.version_id IS NULL
BEGIN
  INSERT INTO clio_chunks_fts(rowid, content, title)
    VALUES (new.rowid, new.content, COALESCE(new.title, ''));
END;

CREATE TRIGGER IF NOT EXISTS clio_chunks_fts_ad AFTER DELETE ON clio_chunks
WHEN old.version_id IS NULL
BEGIN
  INSERT INTO clio_chunks_fts(clio_chunks_fts, rowid, content, title)
    VALUES ('delete', old.rowid, old.content, COALESCE(old.title, ''));
END;

CREATE TRIGGER IF NOT EXISTS clio_chunks_fts_au AFTER UPDATE ON clio_chunks
WHEN old.version_id IS NULL OR new.version_id IS NULL
BEGIN
  -- Remove old row from FTS (if it was current)
  INSERT INTO clio_chunks_fts(clio_chunks_fts, rowid, content, title)
    SELECT 'delete', old.rowid, old.content, COALESCE(old.title, '')
    WHERE old.version_id IS NULL;
  -- Add new row to FTS (if it is current)
  INSERT INTO clio_chunks_fts(rowid, content, title)
    SELECT new.rowid, new.content, COALESCE(new.title, '')
    WHERE new.version_id IS NULL;
END;

-- Document metadata JSON-extracted columns for common filters.
-- These are queried as `json_extract(metadata, '$.workspace_id') = ?`
-- at search time. Indexing is done on the extracted expressions
-- (SQLite 3.38+ supports this).

CREATE INDEX IF NOT EXISTS clio_documents_workspace_idx
  ON clio_documents(json_extract(metadata, '$.workspace_id'))
  WHERE json_extract(metadata, '$.workspace_id') IS NOT NULL;

CREATE INDEX IF NOT EXISTS clio_documents_role_idx
  ON clio_documents(json_extract(metadata, '$.role'))
  WHERE json_extract(metadata, '$.role') IS NOT NULL;

CREATE INDEX IF NOT EXISTS clio_documents_artifact_type_idx
  ON clio_documents(json_extract(metadata, '$.artifact_type'))
  WHERE json_extract(metadata, '$.artifact_type') IS NOT NULL;

CREATE INDEX IF NOT EXISTS clio_documents_tier_idx
  ON clio_documents(json_extract(metadata, '$.tier'))
  WHERE json_extract(metadata, '$.tier') IS NOT NULL;

-- ── Audit log (v2; table shape in place so v1 operations can still
-- ── write skeleton entries if useful) ───────────────────────────────────

CREATE TABLE IF NOT EXISTS clio_audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  event_type  TEXT NOT NULL,              -- 'ingest' | 'search' | 'get' | 'delete' | 'restore' | 'purge' | 'set-project' | 'migrate-project'
  actor       TEXT,                       -- e.g. "user", "cfcf-harness", "dev:claude-code:sonnet"
  project_id  TEXT,
  document_id TEXT,
  query       TEXT,                       -- for search events
  metadata    TEXT                         -- JSON details
);

CREATE INDEX IF NOT EXISTS clio_audit_log_ts_idx ON clio_audit_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS clio_audit_log_event_idx ON clio_audit_log(event_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS clio_audit_log_document_idx
  ON clio_audit_log(document_id, timestamp DESC) WHERE document_id IS NOT NULL;
