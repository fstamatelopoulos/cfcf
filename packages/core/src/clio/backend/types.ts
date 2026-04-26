/**
 * MemoryBackend interface.
 *
 * The swap point between the default `LocalClio` (SQLite + FTS5 + later
 * sqlite-vec) and any future `CerefoxRemote` adapter. All cf² roles talk
 * to a `MemoryBackend`, never directly to SQLite. This keeps the agent
 * surface stable across backends.
 */

import type {
  ClioProject,
  ClioDocument,
  ClioDocumentVersion,
  ClioAuditEntry,
  IngestRequest,
  IngestResult,
  SearchRequest,
  SearchResponse,
  ClioStats,
} from "../types.js";

export interface MemoryBackend {
  // ── Projects ──────────────────────────────────────────────────────────
  listProjects(): Promise<ClioProject[]>;
  getProject(idOrName: string): Promise<ClioProject | null>;
  createProject(opts: { name: string; description?: string }): Promise<ClioProject>;
  /**
   * Resolve a project name (case-insensitive) or UUID to a ClioProject.
   * Creates the named project if it doesn't exist and `createIfMissing` is
   * true. Used by ingest to auto-route to "default" when callers pass an
   * unknown project name.
   */
  resolveProject(nameOrId: string, opts?: { createIfMissing?: boolean; description?: string }): Promise<ClioProject>;

  // ── Documents ─────────────────────────────────────────────────────────
  ingest(req: IngestRequest): Promise<IngestResult>;
  getDocument(id: string): Promise<ClioDocument | null>;
  /**
   * Look up a live (non-deleted) document by exact title within a Clio
   * Project. Returns null if no match. Used by the `updateIfExists` ingest
   * path; exposed on the interface so future remote backends (e.g.
   * `CerefoxRemote`) can implement the same lookup with their own SQL.
   * 5.11 / Clio v2.
   */
  findDocumentByTitle(projectId: string, title: string): Promise<ClioDocument | null>;
  /**
   * Reconstruct full Markdown content for a document from its chunks.
   * Defaults to the live version (`version_id IS NULL`); pass
   * `opts.versionId` (returned by `listDocumentVersions`) to retrieve an
   * archived state. Returns null if the document or version doesn't
   * exist. 5.11 / Clio v2.
   */
  getDocumentContent(id: string, opts?: { versionId?: string }): Promise<DocumentContent | null>;
  /**
   * List archived versions for a document, newest-first. Each row is one
   * snapshot taken at the moment the document was updated. The "live"
   * (current) chunks are NOT a version row -- they live in `clio_chunks`
   * with `version_id IS NULL`. A document that has never been updated
   * returns an empty array. 5.11 / Clio v2.
   */
  listDocumentVersions(documentId: string): Promise<ClioDocumentVersion[]>;
  /**
   * List documents, newest-first, optionally scoped to one Clio Project.
   * Soft-deleted documents are excluded by default; pass
   * `includeDeleted: true` to surface them too. `limit` defaults to 50;
   * pagination via `offset`. Used by `cfcf clio docs list`.
   */
  listDocuments(opts?: { project?: string; limit?: number; offset?: number; includeDeleted?: boolean }): Promise<ClioDocument[]>;
  /**
   * Find documents by metadata-only filter (no FTS query). Mirrors
   * Cerefox `cerefox_metadata_search`. Use cases: catch-up workflows
   * (`metadata_search({type:"decision-log"}, updated_since:"…")`),
   * cross-cutting filters (find all reflection-analyses across
   * Projects), audit-style queries.
   *
   * Soft-deleted docs are excluded by default (override via
   * `includeDeleted: true`). 5.12 / Clio v2.
   */
  metadataSearch(opts: MetadataSearchRequest): Promise<MetadataSearchResponse>;
  /**
   * Discovery: list every top-level metadata key currently used by any
   * live document, with sample values. Mirrors Cerefox
   * `cerefox_list_metadata_keys`. Use case: agents inspecting
   * "what filters can I apply?" before crafting a metadata_search.
   * 5.12 / Clio v2.
   */
  listMetadataKeys(opts?: { project?: string }): Promise<MetadataKeyInfo[]>;
  /**
   * Soft-delete a document. Sets `deleted_at = now`; downstream search
   * and `getDocument` (default-args) treat it as gone, but the row +
   * its chunks + its versions remain in the DB so a `restoreDocument`
   * call can undo it. Mirrors Cerefox `cerefox_delete_document`. The
   * `author` argument is recorded in the audit log when 5.13 lands.
   * Idempotent: deleting an already-deleted doc is a no-op.
   * Throws if the document doesn't exist. 5.11.
   */
  deleteDocument(id: string, opts?: { author?: string }): Promise<void>;
  /**
   * Undo a soft-delete. Clears `deleted_at`. Idempotent: restoring an
   * already-live doc is a no-op (does not error). Throws if the doc
   * doesn't exist. Mirrors Cerefox `cerefox_restore_document`. 5.11.
   */
  restoreDocument(id: string, opts?: { author?: string }): Promise<void>;

  // ── Search ────────────────────────────────────────────────────────────
  search(req: SearchRequest): Promise<SearchResponse>;

  // ── Introspection ─────────────────────────────────────────────────────
  stats(): Promise<ClioStats>;

  // ── Workspace project migration (see §12.1 Q1) ────────────────────────
  /**
   * Re-key documents currently in `fromProjectId` to `toProjectId`.
   *
   * By default the rekey is **scoped to one workspace** via a
   * `metadata.workspace_id = ?` filter -- only documents tagged with the
   * provided `workspaceId` are moved. This is the right thing for
   * `cfcf workspace set --project <new> --migrate-history`: when
   * multiple workspaces share the old Clio Project, moving one
   * workspace's history shouldn't drag the others'.
   *
   * When `opts.allInProject` is true, every document in `fromProjectId`
   * is re-keyed regardless of workspace_id. Matches the original PR1
   * behaviour; reserved for the "I know what I'm doing" case where the
   * user genuinely wants to collapse an old Project into a new one.
   *
   * Returns the number of documents re-keyed.
   */
  migrateDocumentsBetweenProjects(
    fromProjectId: string,
    toProjectId: string,
    opts?: { workspaceId?: string; allInProject?: boolean },
  ): Promise<number>;

  // ── Audit log (5.13) ──────────────────────────────────────────────────
  /**
   * Query the audit log. All filters are optional; combining them
   * AND's the conditions. Results are newest-first.
   *
   * The audit log records every mutation: `create`, `update-content`,
   * `delete`, `restore`, `migrate-project`. Reads (search, get, list)
   * are NOT recorded.
   */
  getAuditLog(opts?: AuditLogQuery): Promise<ClioAuditEntry[]>;

  // ── Reindex ───────────────────────────────────────────────────────────
  /**
   * Re-embed chunks under the currently-active embedder. Chunks whose
   * `embedder` + `embedding_dim` already match the active embedder are
   * skipped (idempotent). Chunks that have no embedding (e.g. ingested
   * while no embedder was active, or when a previous ingest's embedder
   * call failed) get backfilled.
   *
   * When `opts.project` is set, only documents in that Clio Project are
   * reindexed. Otherwise every document is processed.
   *
   * Throws if no embedder is active.
   */
  reindex(opts?: ReindexOptions): Promise<ReindexResult>;

  // ── Lifecycle ─────────────────────────────────────────────────────────
  close(): Promise<void>;
}

export interface ReindexOptions {
  /** Restrict to a single Clio Project (by name or id). */
  project?: string;
  /**
   * When true, force re-embedding every chunk even when its
   * `embedder` + `embedding_dim` already match the active embedder.
   * Useful after a model version bump within the same slug (rare).
   */
  force?: boolean;
  /** Batch size for embedder calls. Larger = faster but more RAM. */
  batchSize?: number;
  /** Optional progress callback invoked after each batch. */
  onProgress?: (info: { processed: number; total: number }) => void;
}

/**
 * Request shape for `MemoryBackend.metadataSearch`.
 *
 * `metadataFilter` is an exact-match JSON-containment filter against
 * `clio_documents.metadata`: every key/value pair must match. Top-level
 * keys only (matches Cerefox's behaviour for v1 -- nested object
 * containment lands when callers ask for it).
 *
 * `updatedSince` is an ISO-8601 timestamp; only documents whose
 * `updated_at >= updatedSince` are returned. Drives the catch-up
 * workflow ("what's changed since last sync?").
 */
export interface MetadataSearchRequest {
  metadataFilter: Record<string, string | number | boolean>;
  /** Optional Clio Project scope (name or id). */
  project?: string;
  /** ISO-8601 timestamp; results filtered to `updated_at >= updatedSince`. */
  updatedSince?: string;
  /** Include soft-deleted docs (default false). */
  includeDeleted?: boolean;
  /** Max docs to return (default 50, cap 500). */
  matchCount?: number;
}

export interface MetadataSearchResponse {
  documents: import("../types.js").ClioDocument[];
  /** Echoed back so callers can confirm the filter was understood. */
  metadataFilter: Record<string, string | number | boolean>;
}

/**
 * One row in the response of `MemoryBackend.listMetadataKeys`.
 * `valueSamples` holds up to 5 distinct values seen for this key in
 * the corpus, useful for agents discovering the metadata vocabulary.
 */
export interface MetadataKeyInfo {
  key: string;
  documentCount: number;
  valueSamples: (string | number | boolean)[];
}

/**
 * Filter shape for `MemoryBackend.getAuditLog`. All fields optional.
 */
export interface AuditLogQuery {
  /** Restrict by event type (Cerefox-style vocabulary). */
  eventType?: ClioAuditEntry["eventType"];
  /** Restrict by actor (exact match). Useful for "what did claude-code write?" */
  actor?: string;
  /** Restrict by Clio Project (name or id). */
  project?: string;
  /** Restrict by document UUID. */
  documentId?: string;
  /** ISO-8601 timestamp; only entries with timestamp >= this. */
  since?: string;
  /** Max entries to return (default 100, cap 1000). */
  limit?: number;
}

/**
 * Returned by `MemoryBackend.getDocumentContent`. Carries the document
 * record alongside its reconstructed Markdown body. `versionId` echoes
 * which version was reconstructed (null = live/current).
 */
export interface DocumentContent {
  document: ClioDocument;
  content: string;
  chunkCount: number;
  totalChars: number;
  versionId: string | null;
}

export interface ReindexResult {
  embedder: string;
  embeddingDim: number;
  /** Total chunks considered after filter. */
  chunksScanned: number;
  /** Chunks re-embedded this pass. */
  chunksReembedded: number;
  /** Chunks skipped because they already matched the active embedder. */
  chunksSkipped: number;
  /** Documents touched. */
  documentsTouched: number;
  /** Elapsed milliseconds. */
  elapsedMs: number;
}
