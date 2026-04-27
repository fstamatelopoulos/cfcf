-- @migration-flags: disable-foreign-keys
-- 0003_relax_content_hash.sql -- plan item 5.11.
--
-- Drop the UNIQUE constraint on clio_documents.content_hash.
--
-- The content-hash UNIQUE was added in 0001 as a hard dedup guard for
-- the create-only ingest path. With the update-doc API (5.11) it
-- becomes incorrect: a legitimate update of doc A whose new content
-- happens to match doc B's current content would fire the UNIQUE
-- constraint and reject the update. The hash collision is a real
-- possibility when multiple agents converge on the same final state
-- of related documents.
--
-- Replacement: a non-unique index. The dedup-on-create lookup
-- (`SELECT ... WHERE content_hash = ?`) still benefits from the index
-- but no longer rejects parallel docs with the same hash.
--
-- SQLite has no DROP CONSTRAINT, so we use the canonical 12-step
-- table rebuild (https://www.sqlite.org/lang_altertable.html, "Making
-- Other Kinds Of Table Schema Changes").
--
-- ⚠️ The `-- @migration-flags: disable-foreign-keys` marker on line 1
-- tells the migration runner to set `PRAGMA foreign_keys = OFF`
-- BEFORE the wrapping transaction. This is REQUIRED for safety:
-- `DROP TABLE clio_documents` would otherwise fire `ON DELETE CASCADE`
-- on every row in clio_chunks (the FK action runs immediately, even
-- when `defer_foreign_keys = ON` is set inside the transaction --
-- defer only postpones CHECKS, not CASCADE actions). Found by
-- experiment 2026-04-27: a clio.db with chunks ingested under 0001-
-- 0002 had every chunk silently destroyed when this migration ran.
-- See decisions-log.md 2026-04-27.

CREATE TABLE clio_documents_new (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES clio_projects(id) ON DELETE RESTRICT,
  title         TEXT NOT NULL,
  source        TEXT NOT NULL,
  content_hash  TEXT NOT NULL,            -- no longer UNIQUE; see header
  metadata      TEXT NOT NULL DEFAULT '{}',
  review_status TEXT NOT NULL DEFAULT 'approved'
                CHECK (review_status IN ('approved', 'pending_review')),
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  total_chars   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    TEXT DEFAULT NULL
);

INSERT INTO clio_documents_new (
  id, project_id, title, source, content_hash, metadata, review_status,
  chunk_count, total_chars, created_at, updated_at, deleted_at
)
SELECT
  id, project_id, title, source, content_hash, metadata, review_status,
  chunk_count, total_chars, created_at, updated_at, deleted_at
FROM clio_documents;

DROP TABLE clio_documents;
ALTER TABLE clio_documents_new RENAME TO clio_documents;

-- Re-create indexes from 0001 plus a new (non-unique) content_hash index.
CREATE INDEX IF NOT EXISTS clio_documents_project_idx ON clio_documents(project_id);
CREATE INDEX IF NOT EXISTS clio_documents_deleted_idx
  ON clio_documents(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS clio_documents_content_hash_idx
  ON clio_documents(content_hash);

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

-- The migration runner re-enables foreign_keys after COMMIT (it's
-- responsible for the bracketing pragmas; this file just declares the
-- need via the @migration-flags marker on line 1).
