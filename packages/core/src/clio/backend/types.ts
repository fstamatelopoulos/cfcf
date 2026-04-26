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
   * List documents, newest-first, optionally scoped to one Clio Project.
   * Soft-deleted documents are excluded. `limit` defaults to 50 to keep
   * the response compact for the CLI; pagination via `offset`. Used by
   * `cfcf clio docs list`.
   */
  listDocuments(opts?: { project?: string; limit?: number; offset?: number }): Promise<ClioDocument[]>;

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
