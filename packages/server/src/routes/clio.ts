/**
 * Clio HTTP routes (item 5.7 PR1).
 *
 * Mounted onto the main Hono app via `registerClioRoutes(app)`. All
 * endpoints under `/api/clio/*` plus the `PUT /api/workspaces/:id/clio-project`
 * wire for `cfcf workspace set --project`.
 *
 * Response shapes match the CLI's `LocalClio`-returned types 1:1.
 */

import type { Hono } from "hono";
import { getClioBackend } from "../clio-backend.js";
import {
  getWorkspace,
  findWorkspaceByName,
  updateWorkspace,
  readConfig,
  type IngestRequest,
  type SearchRequest,
  EMBEDDER_CATALOGUE,
  findEmbedderEntry,
  LocalClio,
} from "@cfcf/core";

export function registerClioRoutes(app: Hono): void {
  // ── Projects ─────────────────────────────────────────────────────────

  app.get("/api/clio/projects", async (c) => {
    const backend = getClioBackend();
    const projects = await backend.listProjects();
    return c.json({ projects });
  });

  app.post("/api/clio/projects", async (c) => {
    const body = await c.req.json<{ name?: string; description?: string }>()
      .catch(() => ({} as { name?: string; description?: string }));
    if (!body.name || !body.name.trim()) {
      return c.json({ error: "name is required" }, 400);
    }
    try {
      const backend = getClioBackend();
      const project = await backend.createProject({
        name: body.name.trim(),
        description: body.description?.trim() || undefined,
      });
      return c.json(project, 201);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes("already exists")) {
        return c.json({ error: message }, 409);
      }
      return c.json({ error: message }, 500);
    }
  });

  app.get("/api/clio/projects/:idOrName", async (c) => {
    const idOrName = c.req.param("idOrName");
    const backend = getClioBackend();
    const project = await backend.getProject(idOrName);
    if (!project) return c.json({ error: "Clio Project not found" }, 404);
    return c.json(project);
  });

  // ── Ingest ───────────────────────────────────────────────────────────

  app.post("/api/clio/ingest", async (c) => {
    let body: Partial<IngestRequest>;
    try {
      body = await c.req.json<Partial<IngestRequest>>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!body.project || !body.content) {
      return c.json({ error: "project and content are required" }, 400);
    }
    // `title` is optional on `--document-id` updates (server preserves
    // the existing doc's title) but required for create + update-by-
    // title paths. The backend enforces the rule with clear errors;
    // here we only short-circuit the obviously-malformed case.
    if (!body.documentId && (!body.title || !body.title.trim())) {
      return c.json({ error: "title is required (omit only when --document-id is set)" }, 400);
    }
    try {
      const backend = getClioBackend();
      // Forward chunker knobs from global config (Cerefox parity for
      // MAX/MIN_CHUNK_CHARS). Per-call overrides on the body still
      // win; embedder-recommended max wins inside LocalClio when an
      // embedder is active.
      let cfgChunkMaxChars: number | undefined;
      let cfgChunkMinChars: number | undefined;
      try {
        const cfg = await readConfig();
        cfgChunkMaxChars = cfg?.clio?.maxChunkChars;
        cfgChunkMinChars = cfg?.clio?.minChunkChars;
      } catch { /* fall through */ }
      const result = await backend.ingest({
        project: body.project,
        title: body.title,
        content: body.content,
        source: body.source,
        metadata: body.metadata,
        reviewStatus: body.reviewStatus,
        documentId: body.documentId,
        updateIfExists: body.updateIfExists,
        author: body.author,
        chunkMaxChars: body.chunkMaxChars ?? cfgChunkMaxChars,
        chunkMinChars: body.chunkMinChars ?? cfgChunkMinChars,
      });
      // 201 for new docs; 200 for updates and skips. Mirrors Cerefox's
      // status-code split (created → 201, updated/no-op → 200).
      const status = result.action === "created" ? 201 : 200;
      return c.json(result, status);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // ingest("document_id ... not found") → 404 instead of 400 so the
      // CLI / agents can distinguish "your input was malformed" from
      // "the doc you named doesn't exist".
      if (message.includes("not found")) {
        return c.json({ error: message }, 404);
      }
      return c.json({ error: message }, 400);
    }
  });

  // ── Search ───────────────────────────────────────────────────────────

  app.get("/api/clio/search", async (c) => {
    const q = c.req.query("q") ?? "";
    if (!q.trim()) {
      return c.json({ error: "q is required" }, 400);
    }
    const project = c.req.query("project") || undefined;
    // Resolve the search mode in this order (most specific wins):
    //   1. Explicit ?mode= query param  (per-call override; CLI's --mode)
    //   2. clio.defaultSearchMode in the global config
    //      - "auto" (the default) checks the active-embedder row:
    //          present → "hybrid", absent → "fts"
    //      - concrete values (fts/semantic/hybrid) bypass the auto check
    //   3. Hard fallback "fts" if config can't be read for any reason.
    let mode: SearchRequest["mode"] = (c.req.query("mode") as SearchRequest["mode"]) || undefined;
    if (!mode) {
      try {
        const config = await readConfig();
        const configured = config?.clio?.defaultSearchMode ?? "auto";
        if (configured === "auto") {
          const backend = getClioBackend();
          const active = backend instanceof LocalClio ? backend.getActiveEmbedderRecord() : null;
          mode = active ? "hybrid" : "fts";
        } else {
          mode = configured;
        }
      } catch {
        mode = "fts";
      }
    }
    const matchCountStr = c.req.query("match_count");
    const matchCount = matchCountStr ? parseInt(matchCountStr, 10) : undefined;
    if (matchCountStr && (isNaN(matchCount as number) || (matchCount as number) < 1)) {
      return c.json({ error: "match_count must be a positive integer" }, 400);
    }

    // Metadata filter: JSON-encoded in the `metadata` query param for
    // simplicity. e.g. ?metadata={"role":"reflection"}
    let metadata: SearchRequest["metadata"];
    const metaRaw = c.req.query("metadata");
    if (metaRaw) {
      try {
        metadata = JSON.parse(metaRaw) as SearchRequest["metadata"];
      } catch {
        return c.json({ error: "metadata must be valid JSON" }, 400);
      }
    }

    // Minimum cosine similarity for the vector-only branch (hybrid) /
    // every result (semantic). Resolution order, like search mode:
    //   1. ?min_score= query param (per-call)
    //   2. clio.minSearchScore in the global config
    //   3. built-in default 0.5 (Cerefox parity)
    // Pure FTS is unaffected -- LocalClio's searchFts ignores minScore.
    let minScore: number | undefined;
    const minScoreStr = c.req.query("min_score");
    if (minScoreStr !== undefined) {
      const n = parseFloat(minScoreStr);
      if (isNaN(n) || n < 0 || n > 1) {
        return c.json({ error: "min_score must be a number in [0, 1]" }, 400);
      }
      minScore = n;
    }
    if (minScore === undefined) {
      try {
        const config = await readConfig();
        minScore = config?.clio?.minSearchScore;
      } catch { /* fall through */ }
    }
    if (minScore === undefined) minScore = 0.5;

    // Doc-level vs chunk-level dedup. Cerefox's primary `cerefox_search`
    // returns one row per matching document; cfcf matches that as the
    // default (`?by=doc`). `?by=chunk` returns the raw chunk-level
    // result (one row per matching chunk -- useful for debugging or
    // for callers that want to see the chunk-level ranking explicitly).
    // Default is `doc` for Cerefox parity. 5.12 follow-up.
    const byRaw = c.req.query("by");
    const by: "doc" | "chunk" = byRaw === "chunk" ? "chunk" : "doc";
    if (byRaw && byRaw !== "doc" && byRaw !== "chunk") {
      return c.json({ error: "by must be 'doc' or 'chunk'" }, 400);
    }

    // Hybrid blend weight (alpha). Resolution order, like minScore:
    //   1. ?alpha= query param (per-call)
    //   2. clio.hybridAlpha in global config
    //   3. built-in default 0.7 (Cerefox parity)
    // Ignored for fts/semantic modes.
    let alpha: number | undefined;
    const alphaStr = c.req.query("alpha");
    if (alphaStr !== undefined) {
      const n = parseFloat(alphaStr);
      if (isNaN(n) || n < 0 || n > 1) {
        return c.json({ error: "alpha must be a number in [0, 1]" }, 400);
      }
      alpha = n;
    }
    if (alpha === undefined) {
      try {
        const cfg = await readConfig();
        alpha = cfg?.clio?.hybridAlpha;
      } catch { /* fall through */ }
    }
    if (alpha === undefined) alpha = 0.7;

    // Doc-level small-to-big knobs (Cerefox parity). Resolution:
    //   per-call query param → global config → Cerefox-equivalent default.
    let smallDocThreshold: number | undefined;
    const sdtStr = c.req.query("small_doc_threshold");
    if (sdtStr !== undefined) {
      const n = parseInt(sdtStr, 10);
      if (isNaN(n) || n < 0) {
        return c.json({ error: "small_doc_threshold must be a non-negative integer" }, 400);
      }
      smallDocThreshold = n;
    }
    let contextWindow: number | undefined;
    const cwStr = c.req.query("context_window");
    if (cwStr !== undefined) {
      const n = parseInt(cwStr, 10);
      if (isNaN(n) || n < 0) {
        return c.json({ error: "context_window must be a non-negative integer" }, 400);
      }
      contextWindow = n;
    }
    if (smallDocThreshold === undefined || contextWindow === undefined) {
      try {
        const cfg = await readConfig();
        smallDocThreshold = smallDocThreshold ?? cfg?.clio?.smallDocThreshold;
        contextWindow = contextWindow ?? cfg?.clio?.contextWindow;
      } catch { /* fall through */ }
    }
    if (smallDocThreshold === undefined) smallDocThreshold = 20000;
    if (contextWindow === undefined) contextWindow = 1;

    try {
      const backend = getClioBackend();
      const reqShape: SearchRequest = {
        query: q, project, matchCount, mode, metadata, minScore,
        alpha, smallDocThreshold, contextWindow,
      };
      const res = by === "doc"
        ? await backend.searchDocuments(reqShape)
        : await backend.search(reqShape);
      return c.json(res);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // ── Documents ────────────────────────────────────────────────────────

  app.get("/api/clio/documents/:id", async (c) => {
    const id = c.req.param("id");
    const backend = getClioBackend();
    const doc = await backend.getDocument(id);
    if (!doc) return c.json({ error: "Document not found" }, 404);
    return c.json(doc);
  });

  // Audit log (5.13). Read-only (writes happen automatically on every
  // mutation). Mirrors Cerefox `cerefox_get_audit_log`. Filters all
  // optional; combine with AND. Newest-first.
  app.get("/api/clio/audit-log", async (c) => {
    const eventType = c.req.query("event_type") || undefined;
    const actor = c.req.query("actor") || undefined;
    const project = c.req.query("project") || undefined;
    const documentId = c.req.query("document_id") || undefined;
    const since = c.req.query("since") || undefined;
    const limitStr = c.req.query("limit");
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    if (limitStr && (isNaN(limit as number) || (limit as number) < 1)) {
      return c.json({ error: "limit must be a positive integer" }, 400);
    }
    const allowedTypes = ["create", "update-content", "edit-metadata", "delete", "restore", "migrate-project"];
    if (eventType && !allowedTypes.includes(eventType)) {
      return c.json({ error: `event_type must be one of: ${allowedTypes.join(", ")}` }, 400);
    }
    const backend = getClioBackend();
    try {
      const entries = await backend.getAuditLog({
        eventType: eventType as "create" | "update-content" | "edit-metadata" | "delete" | "restore" | "migrate-project" | undefined,
        actor,
        project,
        documentId,
        since,
        limit,
      });
      return c.json({ entries });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // Metadata-only search (5.12). Required body: { metadataFilter:{...} };
  // optional: project, updatedSince (ISO timestamp), includeDeleted,
  // matchCount. Mirrors Cerefox `cerefox_metadata_search`.
  app.post("/api/clio/metadata-search", async (c) => {
    let body: Partial<{
      metadataFilter: Record<string, string | number | boolean>;
      project: string;
      updatedSince: string;
      includeDeleted: boolean;
      matchCount: number;
    }> = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!body.metadataFilter || typeof body.metadataFilter !== "object") {
      return c.json({ error: "metadataFilter is required (object)" }, 400);
    }
    try {
      const backend = getClioBackend();
      const result = await backend.metadataSearch({
        metadataFilter: body.metadataFilter,
        project: body.project,
        updatedSince: body.updatedSince,
        includeDeleted: body.includeDeleted,
        matchCount: body.matchCount,
      });
      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // Discovery: list metadata keys + sample values (5.12). Mirrors
  // Cerefox `cerefox_list_metadata_keys`. Optional ?project=<name|id>.
  app.get("/api/clio/metadata-keys", async (c) => {
    const project = c.req.query("project") || undefined;
    const backend = getClioBackend();
    try {
      const keys = await backend.listMetadataKeys({ project });
      return c.json({ keys });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // Soft-delete (5.11). Sets deleted_at; the row + chunks + versions
  // remain so a subsequent restore is possible. Returns 200 (with
  // deleted=true) on first delete; idempotent thereafter. 404 when the
  // doc doesn't exist. Audit log integration lands in 5.13.
  // Metadata-only edit (5.13 follow-up). Updates any combination of
  // title / author / projectId / metadata without re-ingesting content.
  // **No version snapshot is taken** -- versions exist to protect
  // chunks/content; metadata edits don't touch chunks. Writes one
  // `edit-metadata` audit entry with a before/after diff.
  //
  // Body shape:
  //   {
  //     "title":         "...",          // optional
  //     "author":        "...",          // optional ("" clears to default 'agent')
  //     "projectId":     "uuid",         // optional, OR
  //     "projectName":   "cfcf",         // optional (one of the two)
  //     "metadataSet":   { k: v, ... },  // optional (incremental)
  //     "metadataUnset": ["k", ...],     // optional (incremental)
  //     "author":        "claude-code"   // RESERVED for actor attribution;
  //                                      //   override via x-cfcf-actor header
  //                                      //   if you want a separate channel
  //   }
  // 200 → { updated: boolean, document }
  // 400 → bad input (e.g. project not found, empty title)
  // 404 → doc not found
  app.patch("/api/clio/documents/:id", async (c) => {
    const id = c.req.param("id");
    let body: {
      title?: string;
      author?: string;
      projectId?: string;
      projectName?: string;
      metadataSet?: Record<string, unknown>;
      metadataUnset?: string[];
      actor?: string;
    } = {};
    try { body = await c.req.json(); } catch { /* empty body OK -- treated as no-op */ }
    const backend = getClioBackend();
    try {
      const before = await backend.getDocument(id);
      // 'actor' field on body is the audit-log attribution (who's making
      // the edit). 'author' is the document's author column. They CAN
      // diverge -- a CLI user editing on behalf of an agent.
      const updated = await backend.editDocument(
        id,
        {
          title:         body.title,
          author:        body.author,
          projectId:     body.projectId,
          projectName:   body.projectName,
          metadataSet:   body.metadataSet,
          metadataUnset: body.metadataUnset,
        },
        { author: body.actor },
      );
      const changed =
        !before ||
        before.title !== updated.title ||
        before.author !== updated.author ||
        before.projectId !== updated.projectId ||
        JSON.stringify(before.metadata) !== JSON.stringify(updated.metadata);
      return c.json({ updated: changed, document: updated }, 200);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Distinguish "doc not found" (404) from secondary lookups like
      // "project not found" (400 -- it's a bad input on an existing doc).
      const status = /document "[^"]+" not found/.test(message) ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.delete("/api/clio/documents/:id", async (c) => {
    const id = c.req.param("id");
    let body: { author?: string } = {};
    try { body = await c.req.json<{ author?: string }>(); } catch { /* empty body OK */ }
    const backend = getClioBackend();
    try {
      await backend.deleteDocument(id, body);
      const doc = await backend.getDocument(id);
      return c.json({ deleted: true, document: doc }, 200);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes("not found") ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  // Undo a soft-delete (5.11). Idempotent: restoring an already-live
  // doc returns 200 with restored=false (no change). 404 when the doc
  // doesn't exist.
  app.post("/api/clio/documents/:id/restore", async (c) => {
    const id = c.req.param("id");
    let body: { author?: string } = {};
    try { body = await c.req.json<{ author?: string }>(); } catch { /* empty body OK */ }
    const backend = getClioBackend();
    try {
      const before = await backend.getDocument(id);
      await backend.restoreDocument(id, body);
      const after = await backend.getDocument(id);
      const restored = !!(before?.deletedAt && !after?.deletedAt);
      return c.json({ restored, document: after }, 200);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes("not found") ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  // Reconstructed full content for a document. Returns the live version
  // by default; pass ?version_id=<uuid> to retrieve an archived state
  // (UUIDs come from `GET /api/clio/documents/:id/versions`).
  // Mirrors Cerefox's `cerefox_get_document(p_document_id, p_version_id)`.
  app.get("/api/clio/documents/:id/content", async (c) => {
    const id = c.req.param("id");
    const versionId = c.req.query("version_id") || undefined;
    const backend = getClioBackend();
    const result = await backend.getDocumentContent(id, versionId ? { versionId } : undefined);
    if (!result) {
      return c.json(
        { error: versionId ? `Document or version ${versionId} not found` : "Document not found" },
        404,
      );
    }
    return c.json(result);
  });

  // List archived versions for a document, newest-first. Empty array
  // when the doc has never been updated. Mirrors Cerefox's
  // `cerefox_list_document_versions`.
  app.get("/api/clio/documents/:id/versions", async (c) => {
    const id = c.req.param("id");
    const backend = getClioBackend();
    const doc = await backend.getDocument(id);
    if (!doc) return c.json({ error: "Document not found" }, 404);
    const versions = await backend.listDocumentVersions(id);
    return c.json({ versions });
  });

  // List documents (newest-first, optional ?project=, ?limit=, ?offset=).
  // Powers `cfcf clio docs list`. Soft-deleted docs are excluded.
  app.get("/api/clio/documents", async (c) => {
    const project = c.req.query("project") || undefined;
    const limitStr = c.req.query("limit");
    const offsetStr = c.req.query("offset");
    // Two boolean query params resolve to the three-state deletedFilter:
    //   include_deleted=true → "include" (live + tombstones)
    //   deleted_only=true    → "only"    (trash-bin view)
    //   neither              → "exclude" (default; live only)
    // `deleted_only=true` wins if both are passed.
    const includeDeleted = c.req.query("include_deleted") === "true";
    const deletedOnly = c.req.query("deleted_only") === "true";
    const deletedFilter: "exclude" | "include" | "only" = deletedOnly
      ? "only"
      : includeDeleted ? "include" : "exclude";
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    const offset = offsetStr ? parseInt(offsetStr, 10) : undefined;
    if (limitStr && (isNaN(limit as number) || (limit as number) < 1)) {
      return c.json({ error: "limit must be a positive integer" }, 400);
    }
    if (offsetStr && (isNaN(offset as number) || (offset as number) < 0)) {
      return c.json({ error: "offset must be a non-negative integer" }, 400);
    }
    const backend = getClioBackend();
    try {
      const docs = await backend.listDocuments({ project, limit, offset, deletedFilter });
      return c.json({ documents: docs });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // ── Embedder catalogue + install + set (PR2) ─────────────────────────

  app.get("/api/clio/embedders", async (c) => {
    const backend = getClioBackend();
    const active = backend instanceof LocalClio ? backend.getActiveEmbedderRecord() : null;
    const catalogue = EMBEDDER_CATALOGUE.map((e) => ({
      name: e.name,
      dim: e.dim,
      approxSizeMb: e.approxSizeMb,
      description: e.description,
      recommendedChunkMaxChars: e.recommendedChunkMaxChars,
      recommendedExpansionRadius: e.recommendedExpansionRadius,
      active: active?.name === e.name,
    }));
    return c.json({ catalogue });
  });

  app.post("/api/clio/embedders/install", async (c) => {
    const body = await c.req.json<{ name?: string; force?: boolean }>().catch(() => ({}) as { name?: string; force?: boolean });
    if (!body.name) return c.json({ error: "name is required" }, 400);
    const entry = findEmbedderEntry(body.name);
    if (!entry) return c.json({ error: `Unknown embedder "${body.name}". Run 'cfcf clio embedder list' to see supported embedders.` }, 400);

    const backend = getClioBackend();
    if (!(backend instanceof LocalClio)) {
      return c.json({ error: "Active Clio backend doesn't support local embedders" }, 400);
    }

    try {
      const record = await backend.installActiveEmbedder(entry, { force: !!body.force, loadNow: true });
      return c.json({ active: record, downloaded: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // Pre-flight: what would change if I switched to <name>? Surfaces
  // the impact (existing-embedded count, chunks-over-new-ceiling,
  // config-max-over-ceiling) so the CLI + Web UI can warn before
  // confirming the switch. Read-only; no DB writes.
  app.get("/api/clio/embedders/:name/switch-impact", async (c) => {
    const name = c.req.param("name");
    const backend = getClioBackend();
    if (!(backend instanceof LocalClio)) {
      return c.json({ error: "Active Clio backend doesn't support embedders" }, 400);
    }
    let configMaxChunkChars: number | null | undefined;
    try {
      const cfg = await readConfig();
      configMaxChunkChars = cfg?.clio?.maxChunkChars ?? null;
    } catch { configMaxChunkChars = null; }
    try {
      const impact = backend.previewEmbedderSwitch(name, { configMaxChunkChars });
      return c.json(impact);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  app.post("/api/clio/embedders/set", async (c) => {
    const body = await c.req.json<{ name?: string; force?: boolean; reindex?: boolean }>()
      .catch(() => ({}) as { name?: string; force?: boolean; reindex?: boolean });
    if (!body.name) return c.json({ error: "name is required" }, 400);
    const entry = findEmbedderEntry(body.name);
    if (!entry) return c.json({ error: `Unknown embedder "${body.name}"` }, 400);

    const backend = getClioBackend();
    if (!(backend instanceof LocalClio)) {
      return c.json({ error: "Active Clio backend doesn't support embedders" }, 400);
    }
    try {
      // `--reindex` implies force: we're about to re-embed everything
      // anyway, so allow the switch past the guardrail.
      const record = await backend.installActiveEmbedder(entry, {
        force: !!body.force || !!body.reindex,
        loadNow: !!body.reindex, // pre-warm the model if we're about to use it
      });
      let reindexResult = null;
      if (body.reindex) {
        reindexResult = await backend.reindex();
      }
      return c.json({ active: record, reindex: reindexResult });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  app.post("/api/clio/reindex", async (c) => {
    const body = await c.req.json<{ project?: string; force?: boolean; batchSize?: number }>()
      .catch(() => ({}) as { project?: string; force?: boolean; batchSize?: number });
    const backend = getClioBackend();
    if (!(backend instanceof LocalClio)) {
      return c.json({ error: "Active Clio backend doesn't support reindex" }, 400);
    }
    try {
      const result = await backend.reindex({
        project: body.project,
        force: !!body.force,
        batchSize: body.batchSize,
      });
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // ── Stats ────────────────────────────────────────────────────────────

  app.get("/api/clio/stats", async (c) => {
    const backend = getClioBackend();
    const stats = await backend.stats();
    return c.json(stats);
  });

  // ── Workspace Clio Project binding (backs `cfcf workspace set --project`) ─

  app.put("/api/workspaces/:id/clio-project", async (c) => {
    const id = c.req.param("id");
    const workspace =
      (await getWorkspace(id)) ?? (await findWorkspaceByName(id));
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);

    let body: { project?: string; migrateHistory?: boolean; allInProject?: boolean };
    try {
      body = await c.req.json<typeof body>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!body.project || !body.project.trim()) {
      return c.json({ error: "project is required" }, 400);
    }

    const newName = body.project.trim();
    const oldName = workspace.clioProject;

    // Resolve (auto-create) the new Clio Project. Refuses to auto-create
    // from a raw UUID, so callers pass a human name.
    const backend = getClioBackend();
    let newProject;
    try {
      newProject = await backend.resolveProject(newName, { createIfMissing: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }

    // Migrate historical docs if requested. Scope: by default, only this
    // workspace's own docs move (filtered by metadata.workspace_id); with
    // `allInProject=true` every doc in the old Clio Project is rekeyed.
    let migrated = 0;
    if (body.migrateHistory && oldName) {
      const oldProject = await backend.getProject(oldName);
      if (oldProject) {
        migrated = await backend.migrateDocumentsBetweenProjects(
          oldProject.id,
          newProject.id,
          body.allInProject ? { allInProject: true } : { workspaceId: workspace.id },
        );
      }
    }

    // Persist the new assignment on the workspace config.
    const updated = await updateWorkspace(workspace.id, { clioProject: newProject.name });
    if (!updated) return c.json({ error: "Failed to update workspace" }, 500);

    return c.json({ workspace: updated, migrated });
  });
}
