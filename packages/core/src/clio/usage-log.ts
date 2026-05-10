/**
 * Clio usage log (item 6.9 — Cerefox parity).
 *
 * Two-table design — `clio_audit_log` already exists for mutation
 * history; this module is the operational lens (reads AND writes,
 * with `access_path` + `requestor` + `query_text` + `result_count`).
 * Schema migration: `0003_usage_log.sql`.
 *
 * Exposes:
 * - `UsageLogEvent` type (the row shape)
 * - `AccessPath` enum (`'cli' | 'agent-cli' | 'web' | 'internal'`)
 * - Read-side query types + filters
 * - Write-side helper (`logUsage`) — fire-and-forget; errors swallowed
 *
 * The actual instrumentation (calls to `logUsage` from each LocalClio
 * public method) lives in `local-clio.ts`. This module is the data
 * layer.
 */

import type { Database } from "bun:sqlite";

// --- Types ---

/**
 * Where the call came from. Stored as `clio_usage_log.access_path`.
 *
 * `'cli'` — direct user invocation from a shell (`cfcf clio …`).
 * `'agent-cli'` — `cfcf clio …` invoked from inside an agent's spawn.
 * `'web'` — `/api/clio/*` HTTP call from the web UI.
 * `'internal'` — programmatic call (auto-ingest hooks, tests, etc.)
 *                with no user/agent attribution.
 *
 * Detection strategy (server-side at HTTP route handler):
 * - Read the `X-CFCF-Access-Path` request header. CLI clients set
 *   `cli` (user) or `agent-cli` (agent stamp on `--author`).
 * - Missing header → `web` (the UI never sets it).
 *
 * Detection strategy (when `LocalClio` is called directly without
 * going through HTTP):
 * - Caller passes `accessPath: 'internal'` explicitly (auto-ingest
 *   hooks do this).
 * - Otherwise NULL → record as `internal`.
 */
export type AccessPath = "cli" | "agent-cli" | "web" | "internal";

/**
 * Operations recorded in `clio_usage_log`. Matches the union of cf²'s
 * existing audit-log event types (writes) PLUS read operations the
 * audit log doesn't capture.
 *
 * Writes overlap with `clio_audit_log` — the same `ingest` event will
 * record one row in each table, deliberately. The lenses are
 * different (audit log = doc evolution; usage log = call origin).
 */
export type UsageOperation =
  // Reads
  | "search"
  | "search-documents"
  | "get-document"
  | "get-document-content"
  | "list-documents"
  | "list-versions"
  | "list-projects"
  | "get-project"
  | "metadata-search"
  | "list-metadata-keys"
  | "get-audit-log"
  | "get-usage-log"
  | "list-embedders"
  | "preview-embedder-switch"
  | "stats"
  // Writes
  | "ingest"
  | "update-content"
  | "update-metadata"
  | "edit-document"
  | "delete"
  | "restore"
  | "purge"
  | "migrate-project"
  | "create-project"
  | "edit-project"
  | "delete-project"
  | "install-embedder"
  | "set-embedder"
  | "reindex";

/**
 * Row shape for `clio_usage_log` writes.
 */
export interface UsageLogEntry {
  operation: UsageOperation;
  accessPath: AccessPath;
  /**
   * Free-form actor stamp. Examples:
   *   - `'dev|claude-code|sonnet'` (agent role-stamp)
   *   - `'user'` (direct user invocation)
   *   - `null` for programmatic / unstamped callers
   */
  requestor?: string | null;
  documentId?: string | null;
  projectId?: string | null;
  /** Search / metadata-search query string. NULL for non-search ops. */
  queryText?: string | null;
  /** For reads: hit count. For writes: typically null. */
  resultCount?: number | null;
  /** Open extension point (latency_ms, zero_hits, project_filter, …). */
  extra?: Record<string, unknown> | null;
}

/**
 * Filters for `getUsageLog` / `cfcf clio usage` listing.
 */
export interface UsageLogQuery {
  /** ISO 8601 — return entries logged at or after this time. */
  since?: string;
  /** ISO 8601 — return entries logged at or before this time. */
  until?: string;
  /** Match a specific operation. */
  operation?: UsageOperation;
  /** Match a specific access path. */
  accessPath?: AccessPath;
  /** Match a specific requestor (exact match; agent stamps OR `'user'`). */
  requestor?: string;
  /** Filter to read events only. */
  readsOnly?: boolean;
  /** Filter to write events only. */
  writesOnly?: boolean;
  /** Filter to entries where `result_count = 0` (search misses). */
  zeroHitsOnly?: boolean;
  documentId?: string;
  projectId?: string;
  /** Default 100. */
  limit?: number;
}

/**
 * Read-side row returned to callers.
 */
export interface UsageLogRow {
  id: number;
  loggedAt: string;
  operation: UsageOperation;
  accessPath: AccessPath;
  requestor: string | null;
  documentId: string | null;
  projectId: string | null;
  queryText: string | null;
  resultCount: number | null;
  extra: Record<string, unknown> | null;
}

/**
 * Aggregate response for `cfcf clio usage summary` / `GET /api/clio/usage/summary`.
 * Mirrors Cerefox's `cerefox_usage_summary` JSON shape.
 */
export interface UsageLogSummary {
  totalCount: number;
  opsByDay: Array<{ day: string; count: number }>;
  opsByOperation: Array<{ operation: string; count: number }>;
  opsByAccessPath: Array<{ accessPath: string; count: number }>;
  opsByRequestor: Array<{ requestor: string; count: number }>;
  topDocuments: Array<{ documentId: string; docTitle: string | null; count: number }>;
}

// --- Read-side categorisation ---

/**
 * The set of operations classified as READS for the `--reads` filter.
 * Everything else in `UsageOperation` is treated as a write.
 */
export const READ_OPERATIONS: ReadonlySet<UsageOperation> = new Set<UsageOperation>([
  "search",
  "search-documents",
  "get-document",
  "get-document-content",
  "list-documents",
  "list-versions",
  "list-projects",
  "get-project",
  "metadata-search",
  "list-metadata-keys",
  "get-audit-log",
  "get-usage-log",
  "list-embedders",
  "preview-embedder-switch",
  "stats",
]);

export function isReadOperation(op: UsageOperation): boolean {
  return READ_OPERATIONS.has(op);
}

// --- Writers ---

/**
 * Write a row to `clio_usage_log`. **Fire-and-forget**: any error is
 * swallowed and logged to console.warn — usage logging must NEVER
 * block the actual operation.
 *
 * The wrapping `try/catch` is the safety net; LocalClio callers don't
 * need their own.
 */
export function logUsage(db: Database, entry: UsageLogEntry): void {
  try {
    const stmt = db.prepare(
      `INSERT INTO clio_usage_log (
         operation, access_path, requestor, document_id, project_id,
         query_text, result_count, extra
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      entry.operation,
      entry.accessPath,
      entry.requestor ?? null,
      entry.documentId ?? null,
      entry.projectId ?? null,
      entry.queryText ?? null,
      entry.resultCount ?? null,
      entry.extra ? JSON.stringify(entry.extra) : null,
    );
  } catch (err) {
    // Swallow — usage logging must never break the actual operation.
    console.warn(
      `[clio-usage-log] failed to record ${entry.operation}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// --- Reader ---

/**
 * Return raw rows matching the filter, ordered by `logged_at DESC`.
 */
export function getUsageLog(db: Database, query: UsageLogQuery = {}): UsageLogRow[] {
  const conditions: string[] = [];
  const params: (string | number | null)[] = [];

  if (query.since) {
    conditions.push("logged_at >= ?");
    params.push(query.since);
  }
  if (query.until) {
    conditions.push("logged_at <= ?");
    params.push(query.until);
  }
  if (query.operation) {
    conditions.push("operation = ?");
    params.push(query.operation);
  }
  if (query.accessPath) {
    conditions.push("access_path = ?");
    params.push(query.accessPath);
  }
  if (query.requestor) {
    conditions.push("requestor = ?");
    params.push(query.requestor);
  }
  if (query.documentId) {
    conditions.push("document_id = ?");
    params.push(query.documentId);
  }
  if (query.projectId) {
    conditions.push("project_id = ?");
    params.push(query.projectId);
  }
  if (query.zeroHitsOnly) {
    conditions.push("result_count = 0");
  }
  if (query.readsOnly) {
    const placeholders = [...READ_OPERATIONS].map(() => "?").join(", ");
    conditions.push(`operation IN (${placeholders})`);
    params.push(...READ_OPERATIONS);
  }
  if (query.writesOnly) {
    const placeholders = [...READ_OPERATIONS].map(() => "?").join(", ");
    conditions.push(`operation NOT IN (${placeholders})`);
    params.push(...READ_OPERATIONS);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = query.limit ?? 100;

  type Row = {
    id: number;
    logged_at: string;
    operation: string;
    access_path: string;
    requestor: string | null;
    document_id: string | null;
    project_id: string | null;
    query_text: string | null;
    result_count: number | null;
    extra: string | null;
  };

  const stmt = db.prepare<Row, (string | number | null)[]>(
    `SELECT id, logged_at, operation, access_path, requestor,
            document_id, project_id, query_text, result_count, extra
     FROM clio_usage_log
     ${where}
     ORDER BY logged_at DESC
     LIMIT ?`,
  );
  const rows = stmt.all(...params, limit);
  return rows.map((r) => ({
    id: r.id,
    loggedAt: r.logged_at,
    operation: r.operation as UsageOperation,
    accessPath: r.access_path as AccessPath,
    requestor: r.requestor,
    documentId: r.document_id,
    projectId: r.project_id,
    queryText: r.query_text,
    resultCount: r.result_count,
    extra: r.extra ? (JSON.parse(r.extra) as Record<string, unknown>) : null,
  }));
}

/**
 * Aggregate summary mirroring Cerefox's `cerefox_usage_summary`.
 * Filters share the read-time window with `getUsageLog`.
 */
export function getUsageSummary(
  db: Database,
  filter: { since?: string; until?: string; projectId?: string } = {},
): UsageLogSummary {
  const conditions: string[] = [];
  const params: (string | number | null)[] = [];
  if (filter.since) {
    conditions.push("logged_at >= ?");
    params.push(filter.since);
  }
  if (filter.until) {
    conditions.push("logged_at <= ?");
    params.push(filter.until);
  }
  if (filter.projectId) {
    conditions.push("project_id = ?");
    params.push(filter.projectId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const totalRow = db
    .prepare<{ count: number }, (string | number | null)[]>(`SELECT COUNT(*) AS count FROM clio_usage_log ${where}`)
    .get(...params);
  const totalCount = totalRow?.count ?? 0;

  const opsByDay = db
    .prepare<{ day: string; count: number }, (string | number | null)[]>(
      `SELECT substr(logged_at, 1, 10) AS day, COUNT(*) AS count
       FROM clio_usage_log
       ${where}
       GROUP BY substr(logged_at, 1, 10)
       ORDER BY day ASC`,
    )
    .all(...params);

  const opsByOperation = db
    .prepare<{ operation: string; count: number }, (string | number | null)[]>(
      `SELECT operation, COUNT(*) AS count
       FROM clio_usage_log
       ${where}
       GROUP BY operation
       ORDER BY count DESC`,
    )
    .all(...params);

  const opsByAccessPath = db
    .prepare<{ access_path: string; count: number }, (string | number | null)[]>(
      `SELECT access_path, COUNT(*) AS count
       FROM clio_usage_log
       ${where}
       GROUP BY access_path
       ORDER BY count DESC`,
    )
    .all(...params);

  const opsByRequestor = db
    .prepare<{ requestor: string; count: number }, (string | number | null)[]>(
      `SELECT requestor, COUNT(*) AS count
       FROM clio_usage_log
       ${where ? `${where} AND requestor IS NOT NULL` : "WHERE requestor IS NOT NULL"}
       GROUP BY requestor
       ORDER BY count DESC
       LIMIT 10`,
    )
    .all(...params);

  // Top documents — JOIN to clio_documents to surface titles.
  // Build a JOIN-safe WHERE clause: column refs need to be qualified
  // with the `u.` alias since `clio_documents.logged_at` doesn't exist
  // (would error with "ambiguous column name" if Postgres-y, "no such
  // column" in SQLite).
  const joinConditions: string[] = [];
  const joinParams: (string | number | null)[] = [];
  if (filter.since) {
    joinConditions.push("u.logged_at >= ?");
    joinParams.push(filter.since);
  }
  if (filter.until) {
    joinConditions.push("u.logged_at <= ?");
    joinParams.push(filter.until);
  }
  if (filter.projectId) {
    joinConditions.push("u.project_id = ?");
    joinParams.push(filter.projectId);
  }
  joinConditions.push("u.document_id IS NOT NULL");
  const joinWhere = `WHERE ${joinConditions.join(" AND ")}`;

  const topDocs = db
    .prepare<{ document_id: string; doc_title: string | null; count: number }, (string | number | null)[]>(
      `SELECT u.document_id, d.title AS doc_title, COUNT(*) AS count
       FROM clio_usage_log u
       LEFT JOIN clio_documents d ON u.document_id = d.id
       ${joinWhere}
       GROUP BY u.document_id, d.title
       ORDER BY count DESC
       LIMIT 10`,
    )
    .all(...joinParams);

  return {
    totalCount,
    opsByDay,
    opsByOperation: opsByOperation.map((r) => ({ operation: r.operation, count: r.count })),
    opsByAccessPath: opsByAccessPath.map((r) => ({ accessPath: r.access_path, count: r.count })),
    opsByRequestor: opsByRequestor.map((r) => ({ requestor: r.requestor, count: r.count })),
    topDocuments: topDocs.map((r) => ({
      documentId: r.document_id,
      docTitle: r.doc_title,
      count: r.count,
    })),
  };
}
