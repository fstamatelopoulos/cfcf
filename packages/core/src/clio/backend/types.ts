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

  // ── Search ────────────────────────────────────────────────────────────
  search(req: SearchRequest): Promise<SearchResponse>;

  // ── Introspection ─────────────────────────────────────────────────────
  stats(): Promise<ClioStats>;

  // ── Workspace project migration (see §12.1 Q1) ────────────────────────
  /**
   * Re-key all documents currently in `fromProjectId` to `toProjectId`.
   * Used by `cfcf workspace set --project <new> --migrate-history`.
   * Returns the number of documents re-keyed.
   */
  migrateDocumentsBetweenProjects(fromProjectId: string, toProjectId: string): Promise<number>;

  // ── Lifecycle ─────────────────────────────────────────────────────────
  close(): Promise<void>;
}
