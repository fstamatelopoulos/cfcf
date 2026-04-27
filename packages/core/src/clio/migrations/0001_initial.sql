-- Clio initial schema (plan items 5.7 + 5.11 + 5.12 + 5.13).
--
-- Consolidated 2026-04-27 from the prior 0001 + 0002 + 0003 + 0004 chain
-- so a fresh install applies a single self-contained schema instead of
-- replaying historical migrations. The cascade-bug post-mortem
-- (decisions-log.md 2026-04-27) records WHY the rebuild migration
-- existed; the lesson lives there now, no longer in a migration file.
-- Note for future maintainers: future schema changes get their own
-- new migration file (0002_*.sql, 0003_*.sql, ...). Don't edit this
-- one in place once it's shipped to users.
--
-- Ported (structure + SQL shape) from cerefox/src/cerefox/db/schema.sql
-- @2026-04 -- Postgres + pgvector + tsvector → SQLite + sqlite-vec +
-- FTS5. Maintained independently in cf².
--
-- Divergences from Cerefox:
--   - One-to-many docs→projects (project_id FK on documents) instead of
--     the M2M junction. Clio workspaces map 1:1 to a Project; user
--     ingests pick one.
--   - `source_path` merged into `source` (free-text).
--   - TEXT timestamps (SQLite) instead of TIMESTAMPTZ.
--   - metadata / heading_path are TEXT (JSON) instead of JSONB / TEXT[].
--   - No generated FTS column; FTS5 contentless virtual table + triggers
--     keep the index in sync with clio_chunks.content.
--   - `author` is a typed first-class column on clio_documents (5.12)
--     so search hits + audit queries can filter without joining the
--     audit log. Cerefox keeps author only on the audit log.

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
--
-- `content_hash` is indexed (non-unique) for the dedup-on-create
-- lookup. The original UNIQUE constraint was relaxed to support the
-- update-doc API (5.11): a legitimate update of doc A whose new
-- content matches doc B's current hash must not deadlock.
--
-- `author` is the typed first-class write-attribution column (5.12).
-- Defaults to 'agent' for ingest paths that don't set it. Mirrors
-- Cerefox's `cerefox_ingest(p_author=...)` parameter.

CREATE TABLE IF NOT EXISTS clio_documents (
  id            TEXT PRIMARY KEY,          -- UUID v4
  project_id    TEXT NOT NULL REFERENCES clio_projects(id) ON DELETE RESTRICT,
  title         TEXT NOT NULL,
  source        TEXT NOT NULL,             -- free-text origin hint
                                           --   e.g. "cfcf-docs/iteration-logs/iteration-3.md"
                                           --   or "user-ingest: /path/to/note.md"
                                           --   or "stdin" for piped ingests
  author        TEXT NOT NULL DEFAULT 'agent', -- write-attribution (5.12)
  content_hash  TEXT NOT NULL,             -- sha256 of the full Markdown body
  metadata      TEXT NOT NULL DEFAULT '{}', -- JSON blob; filterable via json_extract
  review_status TEXT NOT NULL DEFAULT 'approved'
                CHECK (review_status IN ('approved', 'pending_review')),
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  total_chars   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    TEXT DEFAULT NULL          -- soft-delete (5.11); NULL = active
);

CREATE INDEX IF NOT EXISTS clio_documents_project_idx ON clio_documents(project_id);
CREATE INDEX IF NOT EXISTS clio_documents_deleted_idx
  ON clio_documents(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS clio_documents_content_hash_idx
  ON clio_documents(content_hash);
CREATE INDEX IF NOT EXISTS clio_documents_author_idx ON clio_documents(author);

-- ── Document versions (5.11) ────────────────────────────────────────────
-- Every update path snapshots the outgoing chunks into one of these
-- rows + bumps the per-document `version_number`. Live (current)
-- chunks live in `clio_chunks` with `version_id IS NULL`.

CREATE TABLE IF NOT EXISTS clio_document_versions (
  id              TEXT PRIMARY KEY,
  document_id     TEXT NOT NULL REFERENCES clio_documents(id) ON DELETE CASCADE,
  version_number  INTEGER NOT NULL,
  source          TEXT,                       -- author of the OUTGOING content (5.12)
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
  embedding      BLOB,                        -- sqlite-vec FLOAT[dim]
  embedder       TEXT,                        -- e.g. "nomic-embed-text-v1.5"
  embedding_dim  INTEGER,                     -- e.g. 768
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Only one current chunk per (document_id, chunk_index); archived chunks
-- may share chunk_index across versions.
CREATE UNIQUE INDEX IF NOT EXISTS clio_chunks_current_idx
  ON clio_chunks(document_id, chunk_index) WHERE version_id IS NULL;

CREATE INDEX IF NOT EXISTS clio_chunks_doc_idx ON clio_chunks(document_id);
CREATE INDEX IF NOT EXISTS clio_chunks_version_idx
  ON clio_chunks(version_id, chunk_index) WHERE version_id IS NOT NULL;

-- ── FTS5 virtual table (keyword search side of hybrid) ──────────────────
-- Contentless FTS5 synced via triggers. content='clio_chunks' means
-- FTS5 reads the `content` column from `clio_chunks` via rowid. Only
-- current chunks (version_id IS NULL) are indexed; archived chunks are
-- excluded from the index but remain retrievable through
-- `cfcf clio docs get <id> --version-id <uuid>`.

CREATE VIRTUAL TABLE IF NOT EXISTS clio_chunks_fts USING fts5(
  content,
  title,
  content='clio_chunks',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

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

-- ── Document metadata indexes for common JSON filters ───────────────────
-- These are queried as `json_extract(metadata, '$.workspace_id') = ?`
-- at search time. SQLite 3.38+ supports indexes on extracted expressions.

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

-- ── Audit log (5.13) ────────────────────────────────────────────────────
-- One row per Clio mutation: 'create', 'update-content', 'delete',
-- 'restore', 'migrate-project'. Reads (search, get, list) are NOT
-- recorded -- the volume would be noisy and the trust story is about
-- writes.

CREATE TABLE IF NOT EXISTS clio_audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  event_type  TEXT NOT NULL,              -- 'create' | 'update-content' | 'delete' | 'restore' | 'migrate-project'
  actor       TEXT,                       -- e.g. "user", "claude-code", "cfcf-harness"
  project_id  TEXT,
  document_id TEXT,
  query       TEXT,                       -- reserved (currently always null; see decisions-log.md 2026-04-26)
  metadata    TEXT                         -- JSON details (version_id, sizes, ...)
);

CREATE INDEX IF NOT EXISTS clio_audit_log_ts_idx ON clio_audit_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS clio_audit_log_event_idx ON clio_audit_log(event_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS clio_audit_log_document_idx
  ON clio_audit_log(document_id, timestamp DESC) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS clio_audit_log_actor_idx
  ON clio_audit_log(actor, timestamp DESC) WHERE actor IS NOT NULL;

-- ── Active embedder (single-row state) ──────────────────────────────────
-- Clio pins one embedder per DB. The row records the name + dim + install
-- timestamp so `cfcf clio embedder active` can report it and the ingest
-- path knows which model to load. Switching embedders is gated by
-- `cfcf clio embedder set [--reindex]`.

CREATE TABLE IF NOT EXISTS clio_active_embedder (
  -- Single-row table: enforced via a CHECK on id=1.
  id                            INTEGER PRIMARY KEY CHECK (id = 1),
  name                          TEXT NOT NULL,
  dim                           INTEGER NOT NULL,
  hf_model_id                   TEXT NOT NULL,
  recommended_chunk_max_chars   INTEGER NOT NULL,
  recommended_expansion_radius  INTEGER NOT NULL,
  installed_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
