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
  /** sha256 of the full Markdown body. Unique across the whole DB. */
  contentHash: string;
  metadata: Record<string, unknown>;
  reviewStatus: "approved" | "pending_review";
  chunkCount: number;
  totalChars: number;
  createdAt: string;
  updatedAt: string;
  /** v2 soft-delete; null in v1. */
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
}

export interface IngestResult {
  /** The document's row id. */
  id: string;
  /** True when this was a fresh ingest; false when content_hash already existed. */
  created: boolean;
  /** The existing or new document. */
  document: ClioDocument;
  /** Number of chunks produced (0 when a duplicate was found). */
  chunksInserted: number;
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
