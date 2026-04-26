/**
 * Clio type definitions.
 *
 * Kept in a Clio-local file (rather than the shared `packages/core/src/types.ts`)
 * so Clio-specific concerns don't leak into the public core type surface.
 */

// ── Domain types (one-to-one with the SQL tables) ─────────────────────────

export interface ClioProject {
  id: string;
  name: string;
  description?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /** Convenience: number of documents in this project (optional; returned on some endpoints). */
  documentCount?: number;
}

export interface ClioDocument {
  id: string;
  projectId: string;
  title: string;
  source: string;
  /**
   * Who or what created/last-updated this document. Mirrors Cerefox's
   * `author` parameter on `cerefox_ingest`. Defaults to 'agent' for
   * pre-5.12 records that didn't set it. 5.12 / Clio v2.
   */
  author: string;
  /** sha256 of the full Markdown body. Migration 0003 dropped UNIQUE. */
  contentHash: string;
  metadata: Record<string, unknown>;
  reviewStatus: "approved" | "pending_review";
  chunkCount: number;
  totalChars: number;
  createdAt: string;
  updatedAt: string;
  /** Set by `deleteDocument`; cleared by `restoreDocument`. 5.11. */
  deletedAt?: string | null;
}

export interface ClioChunk {
  id: string;
  documentId: string;
  /** null for current chunks; document version UUID for archived. */
  versionId: string | null;
  chunkIndex: number;
  headingPath: string[];
  /** 0 = preamble/merged; 1-3 = H1-H3. */
  headingLevel: number | null;
  title: string | null;
  content: string;
  charCount: number;
  /** PR2+: populated when an embedder is active. */
  embedder: string | null;
  embeddingDim: number | null;
  createdAt: string;
}

// ── Ingest / search request-response types ────────────────────────────────

export interface IngestRequest {
  /** Clio Project to ingest into (by name or id; resolved server-side). */
  project: string;
  title: string;
  content: string;
  /** Free-text origin hint (file path, "stdin", "cfcf-auto:iteration-log", etc.). */
  source?: string;
  /** Structured metadata merged into the document's metadata JSON. */
  metadata?: Record<string, unknown>;
  reviewStatus?: "approved" | "pending_review";
  /**
   * Deterministic update by document UUID. Mirrors Cerefox `cerefox_ingest`'s
   * `document_id` parameter. When provided, looks up the document, snapshots
   * its current chunks into a new version row, replaces the live content with
   * the new chunks, and bumps `updated_at`. Errors if the document doesn't
   * exist (or is soft-deleted). Wins over `updateIfExists` if both are set
   * (a runtime warning is surfaced via `IngestResult.note`). 5.11 / Clio v2.
   */
  documentId?: string;
  /**
   * Title-based update fallback. Mirrors Cerefox `cerefox_ingest`'s
   * `update_if_exists` parameter. When true, looks for an existing live
   * (non-deleted) document with the same title in the same Clio Project; if
   * found, updates it in place. Otherwise falls through to a normal create.
   * Ignored when `documentId` is provided. 5.11 / Clio v2.
   */
  updateIfExists?: boolean;
  /**
   * Optional attribution: who or what triggered this write. Stored on the
   * version row's `source` column when an update happens, so `cfcf clio
   * versions <doc-id>` shows who made each version. Full audit-log
   * integration (5.13) will index this for filtering. Defaults to "agent"
   * for compatibility with Cerefox `cerefox_ingest`'s default.
   */
  author?: string;
}

export interface IngestResult {
  /** The document's row id. */
  id: string;
  /**
   * What this ingest call did:
   *   - "created": new document inserted
   *   - "updated": existing document had its content replaced; a snapshot
   *                of the prior content lives in `clio_document_versions`
   *                (returned `versionId` + `versionNumber` below)
   *   - "skipped": `content_hash` matched an existing live document; nothing
   *                changed (the old behaviour from PR1)
   * Source of truth going forward; mirrors Cerefox `IngestResult.action`.
   */
  action: "created" | "updated" | "skipped";
  /**
   * Legacy field. `true` iff `action === "created"`. Kept for backwards
   * compatibility with PR1 callers; new code should prefer `action`.
   * @deprecated Use `action` instead.
   */
  created: boolean;
  /** The current document record (post-update if action === "updated"). */
  document: ClioDocument;
  /** Number of chunks in the live (post-update) version. 0 when skipped. */
  chunksInserted: number;
  /**
   * When `action === "updated"`: UUID of the snapshot row in
   * `clio_document_versions` holding the prior content. Pass to
   * `getDocumentContent({ versionId })` to retrieve the archived state.
   */
  versionId?: string;
  /**
   * When `action === "updated"`: the sequential version number assigned to
   * the new snapshot. Starts at 1 for the first update; mirrors
   * `cerefox_document_versions.version_number`.
   */
  versionNumber?: number;
  /**
   * Optional human-readable warning. Set when caller behaviour is non-fatal
   * but worth surfacing -- e.g. `documentId` was provided so `updateIfExists`
   * was overridden. Mirrors Cerefox's `IngestResult.note`.
   */
  note?: string;
}

/**
 * One row in `clio_audit_log`. Written automatically on every Clio
 * mutation (ingest create/update, delete, restore, migrate-project)
 * since 5.13. Reads (search, get, list) are NOT logged -- the volume
 * would be noisy and the trust story is about writes.
 *
 * `eventType` vocabulary mirrors Cerefox's `cerefox_audit_log.operation`:
 *   - "create"        : new document inserted
 *   - "update-content": existing document's content replaced (snapshot taken)
 *   - "delete"        : soft-delete (deleted_at set)
 *   - "restore"       : soft-delete cleared
 *   - "migrate-project": doc(s) re-keyed from one Clio Project to another
 */
export interface ClioAuditEntry {
  id: number;
  timestamp: string;
  eventType:
    | "create"
    | "update-content"
    | "delete"
    | "restore"
    | "migrate-project";
  /**
   * Who/what triggered this event. Defaults to "agent" for ingest paths
   * that don't pass `author`. Free-text otherwise.
   */
  actor: string | null;
  projectId: string | null;
  documentId: string | null;
  /** Engine query text. Null for non-search events (always null in v1). */
  query: string | null;
  /** JSON details: version_id, prior_title, sizes, etc. */
  metadata: Record<string, unknown>;
}

/**
 * One archived version of a document. Returned by
 * `MemoryBackend.listDocumentVersions(docId)` newest-first.
 *
 * `versionNumber` is sequential per document, starting at 1. The "live"
 * (current) chunks are NOT a version row -- they live in `clio_chunks`
 * with `version_id IS NULL`. Each time a document is updated, the
 * outgoing chunks are archived under a new version row before the new
 * chunks are written; that's why `versionNumber` only starts existing
 * after the first update.
 *
 * 5.11 / Clio v2.
 */
export interface ClioDocumentVersion {
  id: string;
  documentId: string;
  versionNumber: number;
  /**
   * Free-text label. Today this carries the `author` value from the
   * triggering ingest (e.g. "agent", "claude-code", "cfcf-harness").
   * Cerefox's analogous column is `cerefox_document_versions.source`
   * with values like "file", "paste", "agent", "manual".
   */
  source: string | null;
  metadata: Record<string, unknown>;
  chunkCount: number;
  totalChars: number;
  /**
   * If true, this version is protected from retention cleanup (when 5.13
   * lands). Currently always false; the field is present for forward
   * compatibility with Cerefox's `archived` flag.
   */
  archived: boolean;
  createdAt: string;
}

export interface SearchRequest {
  query: string;
  /** Optional: limit results to this Project (by name or id; resolved server-side). */
  project?: string;
  /** Max number of hits to return. */
  matchCount?: number;
  /** v1 supports "fts" only. PR2 adds "hybrid" and "semantic". */
  mode?: "fts" | "hybrid" | "semantic";
  /**
   * Exact-match filter against JSON fields of `clio_documents.metadata`.
   * e.g. `{ workspace_id: "calc-abc", role: "reflection" }`.
   */
  metadata?: Record<string, string | number | boolean>;
  /**
   * Minimum cosine similarity (raw, before RRF fusion) for the
   * **vector-only** branch. Ported from Cerefox's `CEREFOX_MIN_SEARCH_SCORE`
   * (see decisions-log.md 2026-04-25 entry "Hybrid search threshold").
   * Semantics:
   *   - "hybrid": chunks that matched the FTS keyword operator pass
   *     through regardless. Vector-only candidates whose raw cosine is
   *     below `minScore` are dropped before RRF fusion.
   *   - "semantic": every result is filtered.
   *   - "fts": ignored.
   * Per-call value (CLI `--min-score` / query param `min_score`) wins
   * over `clio.minSearchScore` in the global config; absent both, the
   * default 0.5 is used at the server route.
   */
  minScore?: number;
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  chunkIndex: number;
  title: string | null;
  content: string;
  headingPath: string[];
  headingLevel: number | null;
  /** Raw engine score (BM25 for FTS; RRF-combined in PR2). */
  score: number;
  /** Document-level context for display. */
  docTitle: string;
  docSource: string;
  /** Who/what last wrote this document. 5.12. */
  docAuthor: string;
  docProjectId: string;
  docProjectName: string;
  docMetadata: Record<string, unknown>;
}

export interface SearchResponse {
  hits: SearchHit[];
  mode: "fts" | "hybrid" | "semantic";
  /** Total matched chunks before match_count truncation (useful for UI pagination). */
  totalMatches: number;
}

// ── Stats ─────────────────────────────────────────────────────────────────

export interface ClioStats {
  dbPath: string;
  dbSizeBytes: number;
  projectCount: number;
  documentCount: number;
  chunkCount: number;
  /** Applied migration filenames, newest-first. */
  migrations: string[];
  /** v1: always null (no embedder). PR2: currently-active embedder record. */
  activeEmbedder?: {
    name: string;
    dim: number;
    recommendedChunkMaxChars: number;
  } | null;
}
