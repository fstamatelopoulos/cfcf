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
-- but no longer rejects parallel docs with the same hash. When two
-- documents with the same hash exist, the dedup query returns one of
-- them as the "skipped" target -- benign; either is a valid answer.
--
-- SQLite has no DROP CONSTRAINT, so we use the canonical 12-step
-- table rebuild (https://www.sqlite.org/lang_altertable.html, "Making
-- Other Kinds Of Table Schema Changes"). The migration runner wraps
-- each migration in a BEGIN IMMEDIATE / COMMIT pair, so PRAGMA
-- foreign_keys = OFF is a no-op here (SQLite ignores it inside an
-- active transaction). PRAGMA defer_foreign_keys = ON is the in-
-- transaction equivalent: it postpones all FK enforcement to COMMIT
-- time. By COMMIT time the new clio_documents table exists with the
-- same name, so clio_chunks' FK resolves cleanly even though the old
-- table was dropped mid-transaction.

PRAGMA defer_foreign_keys = ON;

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

-- defer_foreign_keys is automatically reset at COMMIT (per SQLite docs);
-- no explicit "ON" reset needed here.
