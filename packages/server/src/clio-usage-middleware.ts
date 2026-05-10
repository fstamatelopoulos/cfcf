/**
 * Clio usage-log middleware (item 6.9 phase 3).
 *
 * Wraps every `/api/clio/*` route. After the handler runs, it derives a
 * Cerefox-style usage event from the request + response and writes it to
 * `clio_usage_log` via the backend. Fire-and-forget: logging failures
 * never break the user-facing call (we only `console.warn` for visibility).
 *
 * Two surfaces feed the row:
 *   1. **The middleware itself** picks up universal fields: HTTP method,
 *      path-derived operation name, access_path header, document_id from
 *      the URL, query_text from `?q=`.
 *   2. **Route handlers** can attach operation-specific extras via
 *      `c.set("clioUsageExtras", { resultCount, projectId, ... })` --
 *      useful for search (result_count), ingest (document_id of the
 *      doc that just got created/updated), and anywhere else where the
 *      handler knows something the URL alone doesn't.
 *
 * This keeps the route file readable: the middleware does 80% of the work
 * and the handlers only annotate when they have something extra to say.
 */

import type { Context, Next } from "hono";
import { getClioBackend } from "./clio-backend.js";
import type { AccessPath, UsageOperation } from "@cfcf/core";

interface ClioUsageExtras {
  resultCount?: number;
  documentId?: string | null;
  projectId?: string | null;
  queryText?: string | null;
  extra?: Record<string, unknown>;
}

/**
 * Hono context augmentation. Routes set this via `c.set('clioUsageExtras', …)`.
 */
declare module "hono" {
  interface ContextVariableMap {
    clioUsageExtras: ClioUsageExtras;
  }
}

/**
 * Map (HTTP method, route shape) → operation name. Route shapes are
 * matched on the prefix-stripped path (`/search`, `/documents/:id`, …).
 *
 * Returns `null` for paths we don't want to log (none today, but the hook
 * is here in case we want to suppress noisy GETs later).
 */
function pathToOperation(method: string, pathTail: string): UsageOperation | null {
  // Normalise dynamic segments. We only care about the URL *shape* for
  // the operation name; the actual id goes to `document_id` separately.
  const shape = pathTail.replace(/\/[a-f0-9-]{8,}/gi, "/:id");

  const m = method.toUpperCase();
  const key = `${m} ${shape}`;
  const map: Record<string, UsageOperation> = {
    // Search / discovery
    "GET /search":              "search",
    "POST /metadata-search":    "metadata-search",
    "GET /metadata-keys":       "list-metadata-keys",

    // Ingest + content lifecycle
    "POST /ingest":             "ingest",
    "PATCH /documents/:id":     "edit-document",
    "DELETE /documents/:id":    "delete",
    "POST /documents/:id/restore": "restore",
    "POST /documents/:id/purge":   "purge",

    // Reads
    "GET /documents":           "list-documents",
    "GET /documents/:id":       "get-document",
    "GET /documents/:id/content":  "get-document-content",
    "GET /documents/:id/versions": "list-versions",
    "GET /audit-log":           "get-audit-log",

    // Projects
    "GET /projects":            "list-projects",
    "POST /projects":           "create-project",
    "GET /projects/:idOrName":  "get-project",
    "PATCH /projects/:idOrName":  "edit-project",
    "DELETE /projects/:idOrName": "delete-project",

    // Embedders + reindex
    "GET /embedders":               "list-embedders",
    "POST /embedders/install":      "install-embedder",
    "POST /embedders/set":          "set-embedder",
    "GET /embedders/:name/switch-impact": "preview-embedder-switch",
    "POST /reindex":                "reindex",

    // Stats
    "GET /stats":               "stats",
  };

  // Try the exact match; if the dynamic-segment regex didn't replace
  // (e.g. project names without UUID-shaped ids), retry with a more
  // permissive segment replacement.
  if (map[key]) return map[key];
  const shape2 = pathTail
    .replace(/\/projects\/[^/]+$/, "/projects/:idOrName")
    .replace(/\/embedders\/[^/]+\/switch-impact$/, "/embedders/:name/switch-impact")
    .replace(/\/documents\/[^/]+\/(content|versions|restore|purge)$/, "/documents/:id/$1")
    .replace(/\/documents\/[^/]+$/, "/documents/:id");
  return map[`${m} ${shape2}`] ?? null;
}

/**
 * Pull a sensible document_id out of the request URL. Returns null when
 * the URL doesn't contain one.
 */
function extractDocumentIdFromPath(pathTail: string): string | null {
  // /documents/<id>(/...)?
  const m = pathTail.match(/^\/documents\/([^/]+)(?:\/.*)?$/);
  return m ? m[1] : null;
}

/**
 * Resolve the access-path header. Trusts `cli` / `agent-cli` / `web`;
 * defaults to `web` (browser → server doesn't set the header).
 */
function readAccessPath(c: Context): AccessPath {
  const raw = c.req.header("X-CFCF-Access-Path") ?? c.req.header("x-cfcf-access-path");
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "cli" || v === "agent-cli" || v === "web") return v;
  return "web";
}

/**
 * Resolve a requestor stamp. Today we look at the `X-CFCF-Actor` header
 * (CLI doesn't set this yet; CLI clients can opt in later when we wire
 * actor-aware verbs). When absent, leave null.
 */
function readRequestor(c: Context): string | null {
  const raw = c.req.header("X-CFCF-Actor") ?? c.req.header("x-cfcf-actor");
  return raw && raw.trim() ? raw.trim() : null;
}

/**
 * Hono middleware to attach Clio usage logging to /api/clio/* routes.
 * Mount with `app.use("/api/clio/*", clioUsageMiddleware())`.
 */
export function clioUsageMiddleware() {
  return async (c: Context, next: Next): Promise<void> => {
    // Initialise the extras slot so handlers can write into it.
    c.set("clioUsageExtras", {});

    // Resolve everything we can up front so a handler crash doesn't lose
    // the call entirely -- we still log the attempt with the response
    // status from the catch block.
    const fullPath = c.req.path;
    const pathTail = fullPath.replace(/^\/api\/clio/, "");
    const op = pathToOperation(c.req.method, pathTail);
    const accessPath = readAccessPath(c);
    const requestor = readRequestor(c);
    const queryFromUrl = c.req.query("q") ?? null;
    const docIdFromUrl = extractDocumentIdFromPath(pathTail);

    let handlerError: unknown = null;
    try {
      await next();
    } catch (err) {
      handlerError = err;
    }

    // After the handler runs, drain the extras slot it may have populated.
    const extras = (c.get("clioUsageExtras") ?? {}) as ClioUsageExtras;

    if (op) {
      try {
        const backend = getClioBackend();
        backend.logUsage({
          operation: op,
          accessPath,
          requestor,
          documentId: extras.documentId ?? docIdFromUrl,
          projectId: extras.projectId ?? null,
          queryText: extras.queryText ?? queryFromUrl,
          resultCount:
            extras.resultCount === undefined ? null : extras.resultCount,
          extra: extras.extra ?? null,
        });
      } catch (err) {
        // Never let a logging failure break the API surface.
        console.warn(`[clio-usage-log] write failed for ${op}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (handlerError) throw handlerError;
  };
}
