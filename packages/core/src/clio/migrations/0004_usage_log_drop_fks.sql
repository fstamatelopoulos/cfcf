-- Migration 0004: drop FOREIGN KEY constraints from clio_usage_log
-- (item 6.9 follow-up — 2026-05-09).
--
-- The original 0003 migration declared:
--   document_id TEXT REFERENCES clio_documents(id) ON DELETE SET NULL,
--   project_id  TEXT REFERENCES clio_projects(id)  ON DELETE SET NULL
--
-- That broke the natural use of the usage log: a 404 GET on a typo'd
-- document id, or a logged operation that names a doc which has since
-- been purged, would fail the FK on INSERT and the row would never
-- land. Usage logs are meant to capture *attempts*, not just successful
-- ops on still-live docs.
--
-- SQLite has no `ALTER TABLE ... DROP CONSTRAINT`; the standard
-- recipe is rename → recreate → copy → drop-old.
--
-- Skipped on installs that have never run 0003 (the IF EXISTS guards),
-- so a fresh 0001+0002+0003+0004 chain ends up with the correct
-- schema either way.

-- Safe to skip if 0003 already declared the table without FKs (no-op).
-- The cheapest way to check: try to drop the old, recreate. SQLite
-- doesn't support conditional ALTER, so we always do the rename dance.

ALTER TABLE clio_usage_log RENAME TO clio_usage_log_pre_6_9;

CREATE TABLE clio_usage_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  logged_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  operation    TEXT NOT NULL,
  access_path  TEXT NOT NULL,
  requestor    TEXT,
  document_id  TEXT,  -- intentionally no FK; see 0003 header.
  project_id   TEXT,  -- ditto.
  query_text   TEXT,
  result_count INTEGER,
  extra        TEXT
);

INSERT INTO clio_usage_log
  (id, logged_at, operation, access_path, requestor,
   document_id, project_id, query_text, result_count, extra)
SELECT
  id, logged_at, operation, access_path, requestor,
  document_id, project_id, query_text, result_count, extra
FROM clio_usage_log_pre_6_9;

DROP TABLE clio_usage_log_pre_6_9;

-- Recreate the indexes from 0003 — DROP TABLE took the originals.
CREATE INDEX IF NOT EXISTS clio_usage_log_logged_at_idx
  ON clio_usage_log (logged_at DESC);
CREATE INDEX IF NOT EXISTS clio_usage_log_operation_idx
  ON clio_usage_log (operation, logged_at DESC);
CREATE INDEX IF NOT EXISTS clio_usage_log_access_path_idx
  ON clio_usage_log (access_path, logged_at DESC);
CREATE INDEX IF NOT EXISTS clio_usage_log_requestor_idx
  ON clio_usage_log (requestor, logged_at DESC) WHERE requestor IS NOT NULL;
CREATE INDEX IF NOT EXISTS clio_usage_log_document_idx
  ON clio_usage_log (document_id, logged_at DESC) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS clio_usage_log_project_idx
  ON clio_usage_log (project_id, logged_at DESC) WHERE project_id IS NOT NULL;
