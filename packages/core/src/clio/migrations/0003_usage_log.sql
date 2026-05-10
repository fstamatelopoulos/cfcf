-- Migration 0003: clio_usage_log table (item 6.9 — Cerefox parity)
--
-- Two-table design. Existing `clio_audit_log` keeps its scope: per-document
-- mutation history with version-id linkage + size deltas + free-form
-- description (lens: "how has this doc evolved?"). New `clio_usage_log`
-- adds the operational lens — reads AND writes through a different shape:
-- request origin (access_path), requestor identity, query text, result
-- count. Same write event (e.g. `ingest`) appears in BOTH tables;
-- different filters in the UI, different consumers.
--
-- Schema mirrors Cerefox's `cerefox_usage_log` (2026-05-09 audit of
-- `~/src/cerefox/src/cerefox/db/migrations/0006_usage_log.sql`) so a
-- future CerefoxRemote backend swap-in stays clean. Differences from
-- Cerefox: cf² has no `usage_tracking_enabled` config gate (always on,
-- single-user space); SQLite types instead of Postgres; INTEGER PK +
-- AUTOINCREMENT instead of UUID gen_random_uuid().

CREATE TABLE IF NOT EXISTS clio_usage_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  logged_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Operations include reads + writes.
  --   reads : 'search' | 'get-document' | 'list-versions' | 'list-projects' |
  --           'metadata-search' | 'list-metadata-keys' | 'get-audit-log' | 'get-usage-log' | 'stats'
  --   writes: 'ingest' | 'update-content' | 'update-metadata' | 'delete' | 'restore' | 'migrate-project'
  operation    TEXT NOT NULL,
  -- Where the call came from. cf² values today:
  --   'cli'        — direct user invocation of `cfcf clio …` from a shell
  --   'agent-cli'  — `cfcf clio …` invoked from inside an agent's spawn
  --                  (CLI client sets X-CFCF-Access-Path: agent-cli when
  --                   the actor stamp matches the role-pattern)
  --   'web'        — `/api/clio/*` HTTP call from the web UI
  -- Future: 'mcp' if a Model Context Protocol bridge ever ships.
  access_path  TEXT NOT NULL,
  -- Free-form actor stamp. For agents: '<role>|<adapter>|<model>'
  -- (e.g. 'dev|claude-code|sonnet'). For users: 'user'. For unstamped
  -- programmatic callers: NULL.
  requestor    TEXT,
  -- document_id / project_id are intentionally **TEXT WITHOUT FK**.
  -- The usage log is a record of *what was attempted* — including
  -- attempts to read docs that have since been purged or never existed
  -- (a 404 GET /api/clio/documents/<typo> still belongs in the log).
  -- Keeping the FK would force the writer to verify existence first
  -- (extra round-trip per call) or pre-NULL the field on every miss.
  -- Mirrors Cerefox's `cerefox_usage_log` which similarly stores ids
  -- as plain TEXT/UUID without enforced relations on this table.
  document_id  TEXT,
  project_id   TEXT,
  -- For 'search' / 'metadata-search': the query string. NULL for
  -- non-search operations.
  query_text   TEXT,
  -- For reads: number of hits returned. For writes: NULL (size deltas
  -- live in the audit-log row instead).
  result_count INTEGER,
  -- JSON — open extension point for things that don't deserve their
  -- own column. Examples cf² will write: { "latency_ms": 42 },
  -- { "zero_hits": true }, { "project_filter": ["a","b"] }, etc.
  extra        TEXT
);

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
