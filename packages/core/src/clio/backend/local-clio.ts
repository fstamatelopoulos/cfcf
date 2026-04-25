/**
 * LocalClio: default `MemoryBackend` implementation.
 *
 * Backs Clio with a local SQLite DB + FTS5. PR1 ships FTS5-only search;
 * PR2 will add sqlite-vec + hybrid RRF search against the same data.
 *
 * Ported (structure + SQL shape) from the Cerefox search + ingest
 * edge functions @2026-04, adapted for SQLite + one-to-many
 * documents->projects.
 */

import { randomUUID, createHash } from "crypto";
import type { Database } from "bun:sqlite";
import { openClioDb, listAppliedMigrations } from "../db.js";
import { chunkMarkdown } from "../chunking/markdown.js";
import type {
  ClioProject,
  ClioDocument,
  IngestRequest,
  IngestResult,
  SearchRequest,
  SearchResponse,
  SearchHit,
  ClioStats,
} from "../types.js";
import type { MemoryBackend, ReindexOptions, ReindexResult } from "./types.js";
import {
  getActiveEmbedder,
  embeddingToBlob,
  blobToEmbedding,
  cosineSimilarity,
  type Embedder,
  type ActiveEmbedderRecord,
} from "../embedders/index.js";
import { statSync } from "fs";

const DEFAULT_MATCH_COUNT = 10;
const FTS_CANDIDATE_MULTIPLIER = 5;

// UUID v4 pattern (loose). Used to distinguish "project id" from "project name".
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Row shape returned by the candidate-fetching queries in hybrid / semantic search. */
interface VectorCandidateRow {
  chunk_id: string;
  document_id: string;
  chunk_index: number;
  chunk_title: string | null;
  content: string;
  heading_path: string;
  heading_level: number | null;
  embedding: Uint8Array | null;
  doc_title: string;
  doc_source: string;
  doc_project_id: string;
  doc_project_name: string;
  doc_metadata: string;
  bm25_rank: number;
}

export class LocalClio implements MemoryBackend {
  private readonly db: Database;
  private readonly ownsHandle: boolean;
  /**
   * Path of the underlying DB file, captured at construction time.
   * `null` for injected handles (tests) where we never learned the
   * path. Used by `getDbPath()` so the singleton can check "is the
   * file still there?" without issuing a query on a potentially-stale
   * handle.
   */
  private readonly dbPath: string | null;
  /**
   * Lazy-loaded embedder. Set on first ingest / search that needs one.
   * Can be overridden via the `embedder` constructor option for tests
   * that want a mock.
   */
  private embedder: Embedder | null = null;
  private embedderFactory: ((record: ActiveEmbedderRecord) => Promise<Embedder>) | null = null;

  /**
   * Construct a LocalClio. By default it opens (and migrates) the DB at
   * `CFCF_CLIO_DB` or `~/.cfcf/clio.db`. Tests can pass their own
   * already-opened Database via `opts.db` to use an isolated temp DB.
   *
   * `opts.embedder` lets callers inject an Embedder directly (skipping
   * the active-embedder table lookup). `opts.embedderFactory` lets
   * callers customise how an active record is instantiated -- the
   * default is makeOnnxEmbedder(name).
   */
  constructor(opts: {
    db?: Database;
    path?: string;
    embedder?: Embedder;
    embedderFactory?: (record: ActiveEmbedderRecord) => Promise<Embedder>;
  } = {}) {
    if (opts.db) {
      this.db = opts.db;
      this.ownsHandle = false;
      this.dbPath = null;
    } else {
      // Resolve the path eagerly so we can answer getDbPath() even after
      // the underlying file is deleted by a user (testing flows).
      const { getClioDbPath } = require("../db.js") as typeof import("../db.js");
      this.dbPath = opts.path ?? getClioDbPath();
      this.db = openClioDb({ path: opts.path });
      this.ownsHandle = true;
    }
    if (opts.embedder) this.embedder = opts.embedder;
    if (opts.embedderFactory) this.embedderFactory = opts.embedderFactory;
  }

  /**
   * Resolve the active Embedder, if one is installed. Returns null when
   * no embedder is active (FTS-only mode). Caches the resolved instance
   * for the lifetime of the backend.
   */
  private async getEmbedder(): Promise<Embedder | null> {
    if (this.embedder) return this.embedder;
    const record = getActiveEmbedder(this.db);
    if (!record) return null;
    try {
      if (this.embedderFactory) {
        this.embedder = await this.embedderFactory(record);
      } else {
        // Default factory: load ONNX via transformers.js. Imported lazily
        // so tests that don't need it aren't paying the 30 MB cost.
        const { makeOnnxEmbedder } = await import("../embedders/onnx-embedder.js");
        this.embedder = makeOnnxEmbedder(record.name);
      }
      return this.embedder;
    } catch (err) {
      // Falling back to FTS-only mode on embedder init failure is better
      // than a hard error -- the user still gets useful search.
      console.warn(
        `[clio] failed to load embedder "${record.name}": ${err instanceof Error ? err.message : String(err)}. Falling back to FTS-only search.`,
      );
      this.embedder = null;
      return null;
    }
  }

  /**
   * Inject a pre-built Embedder. Used by the CLI's `embedder set` path
   * after install completes successfully so we don't pay the cold-load
   * cost twice.
   */
  setEmbedder(e: Embedder | null): void {
    this.embedder = e;
  }

  /**
   * Read the active-embedder record. Exposed on the backend so HTTP +
   * CLI can surface it without reaching into private state.
   */
  getActiveEmbedderRecord(): ActiveEmbedderRecord | null {
    return getActiveEmbedder(this.db);
  }

  /**
   * Persist an embedder as active + invalidate the cached Embedder so
   * the next search reloads. Validates corpus-compat via setActiveEmbedder.
   * Pass `force` only after a reindex (v2+).
   */
  async installActiveEmbedder(
    entry: import("../embedders/catalogue.js").EmbedderEntry,
    opts: { force?: boolean; loadNow?: boolean } = {},
  ): Promise<ActiveEmbedderRecord> {
    const { setActiveEmbedder } = await import("../embedders/store.js");
    const record = setActiveEmbedder(this.db, entry, { force: opts.force });
    // Invalidate the cached embedder so next access reloads under the
    // new identity. When `loadNow` is true the caller wants the model
    // download to happen NOW (not lazily on first search) -- that means
    // both constructing the embedder shell AND warming its pipeline.
    // Without the warmup() call the OnnxEmbedder.ensurePipeline() path
    // is skipped and no HF download is triggered, which is the bug that
    // shipped with the initial pick-equals-install change (2026-04-22).
    this.embedder = null;
    if (opts.loadNow) {
      const e = await this.getEmbedder();
      if (e?.warmup) {
        await e.warmup();
      }
    }
    return record;
  }

  // ── Projects ───────────────────────────────────────────────────────────

  async listProjects(): Promise<ClioProject[]> {
    const rows = this.db.query<
      {
        id: string;
        name: string;
        description: string | null;
        metadata: string;
        created_at: string;
        updated_at: string;
        document_count: number;
      },
      []
    >(`
      SELECT p.id, p.name, p.description, p.metadata, p.created_at, p.updated_at,
             COUNT(d.id) AS document_count
        FROM clio_projects p
        LEFT JOIN clio_documents d ON d.project_id = p.id AND d.deleted_at IS NULL
       GROUP BY p.id
       ORDER BY p.name
    `).all();
    return rows.map((r) => this.mapProject(r));
  }

  async getProject(idOrName: string): Promise<ClioProject | null> {
    const byId = this.db.query<{
      id: string;
      name: string;
      description: string | null;
      metadata: string;
      created_at: string;
      updated_at: string;
    }, [string]>(`SELECT * FROM clio_projects WHERE id = ? LIMIT 1`).get(idOrName);

    let row = byId;
    if (!row) {
      row = this.db.query<typeof byId, [string]>(
        `SELECT * FROM clio_projects WHERE LOWER(name) = LOWER(?) LIMIT 1`,
      ).get(idOrName);
    }
    if (!row) return null;

    const countRow = this.db.query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM clio_documents WHERE project_id = ? AND deleted_at IS NULL`,
    ).get(row.id);

    return this.mapProject({ ...row, document_count: countRow?.n ?? 0 });
  }

  async createProject(opts: { name: string; description?: string }): Promise<ClioProject> {
    const existing = await this.getProject(opts.name);
    if (existing) {
      throw new Error(`Clio Project "${opts.name}" already exists`);
    }
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO clio_projects (id, name, description, metadata)
      VALUES (?, ?, ?, '{}')
    `).run(id, opts.name, opts.description ?? null);
    const created = await this.getProject(id);
    if (!created) throw new Error(`Clio Project "${opts.name}" was not created (internal error)`);
    return created;
  }

  async resolveProject(
    nameOrId: string,
    opts: { createIfMissing?: boolean; description?: string } = {},
  ): Promise<ClioProject> {
    const found = await this.getProject(nameOrId);
    if (found) return found;
    if (!opts.createIfMissing) {
      throw new Error(`Clio Project "${nameOrId}" not found`);
    }
    // Only allow auto-creating by name, not by raw UUID (prevents weirdness
    // where a caller passes an unknown UUID and we invent a project with
    // that UUID as its name).
    if (UUID_RE.test(nameOrId)) {
      throw new Error(`Clio Project "${nameOrId}" not found (refusing to auto-create from a UUID)`);
    }
    return this.createProject({ name: nameOrId, description: opts.description });
  }

  // ── Documents ──────────────────────────────────────────────────────────

  async ingest(req: IngestRequest): Promise<IngestResult> {
    if (!req.content || !req.content.trim()) {
      throw new Error("ingest: content is empty");
    }
    if (!req.title || !req.title.trim()) {
      throw new Error("ingest: title is empty");
    }

    // Resolve (or auto-create) the Project. The caller is expected to
    // pass a slug; UUID inputs skip auto-create (see resolveProject).
    const project = await this.resolveProject(req.project, { createIfMissing: true });

    const contentHash = sha256Hex(req.content);

    // Dedup by content_hash across the whole DB (same as Cerefox).
    const existingRow = this.db.query<
      {
        id: string;
        project_id: string;
        title: string;
        source: string;
        content_hash: string;
        metadata: string;
        review_status: string;
        chunk_count: number;
        total_chars: number;
        created_at: string;
        updated_at: string;
        deleted_at: string | null;
      },
      [string]
    >(`SELECT * FROM clio_documents WHERE content_hash = ? LIMIT 1`).get(contentHash);
    if (existingRow) {
      return {
        id: existingRow.id,
        created: false,
        document: this.mapDocument(existingRow),
        chunksInserted: 0,
      };
    }

    // Use embedder-aware chunk size when an embedder is active; fall back
    // to the Cerefox default when not.
    const embedder = await this.getEmbedder();
    const chunkOpts = embedder
      ? { maxChunkChars: embedder.recommendedChunkMaxChars }
      : undefined;
    const chunks = chunkMarkdown(req.content, chunkOpts);
    const docId = randomUUID();
    const now = new Date().toISOString();
    const metadata = JSON.stringify(req.metadata ?? {});
    const totalChars = req.content.length;

    // Compute embeddings up front (outside the transaction). Embedding
    // is the slow part; we don't want to hold a write lock during it.
    let embeddings: Uint8Array[] | null = null;
    if (embedder && chunks.length > 0) {
      try {
        const texts = chunks.map((c) => c.content);
        const vectors = await embedder.embed(texts);
        embeddings = vectors.map((v) => embeddingToBlob(v));
      } catch (err) {
        // Embedding failure downgrades to FTS-only for this document.
        // Chunks still index in FTS5; vector search just won't match them.
        console.warn(
          `[clio] embedder failed for "${req.title}" -- ingesting without embeddings: ${err instanceof Error ? err.message : String(err)}`,
        );
        embeddings = null;
      }
    }

    // All-or-nothing: document + chunks insert in one transaction.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO clio_documents
          (id, project_id, title, source, content_hash, metadata, review_status,
           chunk_count, total_chars, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        docId,
        project.id,
        req.title,
        req.source ?? "manual",
        contentHash,
        metadata,
        req.reviewStatus ?? "approved",
        chunks.length,
        totalChars,
        now,
        now,
      );

      const insertChunk = this.db.prepare(`
        INSERT INTO clio_chunks
          (id, document_id, chunk_index, heading_path, heading_level, title,
           content, char_count, embedding, embedder, embedding_dim, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const emb = embeddings ? embeddings[i] : null;
        insertChunk.run(
          randomUUID(),
          docId,
          chunk.chunkIndex,
          JSON.stringify(chunk.headingPath),
          chunk.headingLevel,
          chunk.title || null,
          chunk.content,
          chunk.charCount,
          emb,
          embedder ? embedder.name : null,
          embedder ? embedder.dim : null,
          now,
          now,
        );
      }

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    const doc = await this.getDocument(docId);
    if (!doc) throw new Error(`Clio ingest wrote doc ${docId} but could not read it back`);
    return { id: docId, created: true, document: doc, chunksInserted: chunks.length };
  }

  async getDocument(id: string): Promise<ClioDocument | null> {
    const row = this.db.query<{
      id: string;
      project_id: string;
      title: string;
      source: string;
      content_hash: string;
      metadata: string;
      review_status: string;
      chunk_count: number;
      total_chars: number;
      created_at: string;
      updated_at: string;
      deleted_at: string | null;
    }, [string]>(`SELECT * FROM clio_documents WHERE id = ? LIMIT 1`).get(id);
    if (!row) return null;
    return this.mapDocument(row);
  }

  async listDocuments(opts: { project?: string; limit?: number; offset?: number } = {}): Promise<ClioDocument[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    let projectId: string | null = null;
    if (opts.project) {
      // Resolve name → id; if neither name nor id matches, return empty.
      const proj = await this.getProject(opts.project);
      if (!proj) return [];
      projectId = proj.id;
    }
    const sql = projectId
      ? `SELECT * FROM clio_documents WHERE deleted_at IS NULL AND project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
      : `SELECT * FROM clio_documents WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const bindings: (string | number)[] = projectId ? [projectId, limit, offset] : [limit, offset];
    const rows = this.db.query<{
      id: string;
      project_id: string;
      title: string;
      source: string;
      content_hash: string;
      metadata: string;
      review_status: string;
      chunk_count: number;
      total_chars: number;
      created_at: string;
      updated_at: string;
      deleted_at: string | null;
    }, (string | number)[]>(sql).all(...bindings);
    return rows.map((r) => this.mapDocument(r));
  }

  // ── Search ─────────────────────────────────────────────────────────────

  async search(req: SearchRequest): Promise<SearchResponse> {
    if (!req.query || !req.query.trim()) {
      throw new Error("search: query is empty");
    }
    const requestedMode = req.mode ?? "fts";
    if (requestedMode !== "fts" && requestedMode !== "hybrid" && requestedMode !== "semantic") {
      throw new Error(`search: unknown mode "${requestedMode}"`);
    }
    const matchCount = Math.max(1, Math.min(req.matchCount ?? DEFAULT_MATCH_COUNT, 100));

    // Resolve optional project filter. Don't auto-create: "search non-existent
    // project" should return zero hits, not silently create a Project.
    let projectFilterId: string | null = null;
    if (req.project) {
      const p = await this.getProject(req.project);
      if (!p) return { hits: [], mode: requestedMode === "semantic" ? "semantic" : requestedMode === "hybrid" ? "hybrid" : "fts", totalMatches: 0 };
      projectFilterId = p.id;
    }

    // Route by mode. Callers asking for hybrid/semantic get the better
    // path when an embedder is installed; otherwise fall back to FTS so
    // the user still gets useful results.
    let embedder: Embedder | null = null;
    if (requestedMode === "hybrid" || requestedMode === "semantic") {
      embedder = await this.getEmbedder();
    }

    if (requestedMode === "semantic" && embedder) {
      return await this.searchSemantic(req, embedder, matchCount, projectFilterId);
    }
    if (requestedMode === "hybrid" && embedder) {
      return await this.searchHybrid(req, embedder, matchCount, projectFilterId);
    }

    // FTS path (default, or fallback when no embedder is active).
    return await this.searchFts(req, matchCount, projectFilterId);
  }

  /**
   * FTS-only search. Same shape as the PR1 query, moved into its own
   * method so hybrid/semantic can reuse the candidate-fetching logic.
   */
  private async searchFts(req: SearchRequest, matchCount: number, projectFilterId: string | null): Promise<SearchResponse> {
    const matchExpr = buildFtsMatchExpression(req.query);
    const candidateCount = matchCount * FTS_CANDIDATE_MULTIPLIER;

    // Build metadata filter fragment: we AND json_extract checks onto the
    // JOIN-ed doc row. Bindings collect in order so we can pass them
    // positionally.
    const metaClauses: string[] = [];
    const metaBindings: (string | number | boolean)[] = [];
    if (req.metadata && typeof req.metadata === "object") {
      for (const [k, v] of Object.entries(req.metadata)) {
        // $.role, $.workspace_id, etc. JSON path uses "$.key".
        // SQLite json_extract returns NULL for missing keys; == comparison
        // naturally filters them out.
        metaClauses.push(`json_extract(d.metadata, ?) = ?`);
        metaBindings.push(`$.${k}`);
        metaBindings.push(v as string | number | boolean);
      }
    }
    const metaWhere = metaClauses.length ? ` AND ${metaClauses.join(" AND ")}` : "";

    const sql = `
      WITH fts_results AS (
        SELECT c.id AS chunk_id, bm25(clio_chunks_fts) AS bm25_rank
          FROM clio_chunks_fts f
          JOIN clio_chunks c ON c.rowid = f.rowid
          JOIN clio_documents d ON c.document_id = d.id
         WHERE clio_chunks_fts MATCH ?
           AND c.version_id IS NULL
           AND d.deleted_at IS NULL
           ${projectFilterId ? "AND d.project_id = ?" : ""}
           ${metaWhere}
         ORDER BY bm25_rank ASC
         LIMIT ?
      )
      SELECT c.id AS chunk_id,
             c.document_id,
             c.chunk_index,
             c.title AS chunk_title,
             c.content,
             c.heading_path,
             c.heading_level,
             f.bm25_rank,
             d.title AS doc_title,
             d.source AS doc_source,
             d.project_id AS doc_project_id,
             p.name AS doc_project_name,
             d.metadata AS doc_metadata
        FROM fts_results f
        JOIN clio_chunks c ON c.id = f.chunk_id
        JOIN clio_documents d ON c.document_id = d.id
        JOIN clio_projects p ON d.project_id = p.id
       ORDER BY f.bm25_rank ASC
       LIMIT ?
    `;

    const bindings: (string | number | boolean)[] = [matchExpr];
    if (projectFilterId) bindings.push(projectFilterId);
    bindings.push(...metaBindings);
    bindings.push(candidateCount);
    bindings.push(matchCount);

    const rows = this.db.query<
      {
        chunk_id: string;
        document_id: string;
        chunk_index: number;
        chunk_title: string | null;
        content: string;
        heading_path: string;
        heading_level: number | null;
        bm25_rank: number;
        doc_title: string;
        doc_source: string;
        doc_project_id: string;
        doc_project_name: string;
        doc_metadata: string;
      },
      (string | number | boolean)[]
    >(sql).all(...bindings);

    const hits: SearchHit[] = rows.map((r) => ({
      chunkId: r.chunk_id,
      documentId: r.document_id,
      chunkIndex: r.chunk_index,
      title: r.chunk_title,
      content: r.content,
      headingPath: parseJsonArray(r.heading_path),
      headingLevel: r.heading_level,
      // BM25 ranks in SQLite are negative-or-zero (lower = better). Flip to
      // a conventional "higher = better" score for downstream consumers.
      score: -r.bm25_rank,
      docTitle: r.doc_title,
      docSource: r.doc_source,
      docProjectId: r.doc_project_id,
      docProjectName: r.doc_project_name,
      docMetadata: parseJsonObject(r.doc_metadata),
    }));

    return { hits, mode: "fts", totalMatches: hits.length };
  }

  /**
   * Pure-vector (semantic) search. Computes a query embedding, then scans
   * candidate chunks (same project/metadata filters + current chunks
   * only) and ranks by cosine similarity. Brute-force KNN -- fine for
   * the design doc's expected scale (<100k chunks per DB).
   */
  private async searchSemantic(
    req: SearchRequest,
    embedder: Embedder,
    matchCount: number,
    projectFilterId: string | null,
  ): Promise<SearchResponse> {
    const queryVector = (await embedder.embed([req.query]))[0];
    const candidates = this.fetchVectorCandidates(req, projectFilterId, embedder);

    const scored: Array<{ row: VectorCandidateRow; score: number }> = [];
    for (const row of candidates) {
      const v = blobToEmbedding(new Uint8Array(row.embedding as Uint8Array), embedder.dim);
      scored.push({ row, score: cosineSimilarity(queryVector, v) });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, matchCount);

    const hits = top.map((x) => this.vectorRowToHit(x.row, x.score));
    const expandedHits = this.expandSmallToBig(hits, embedder.dim > 768 ? 1 : 2);

    return { hits: expandedHits, mode: "semantic", totalMatches: hits.length };
  }

  /**
   * Hybrid search: Reciprocal Rank Fusion (RRF) of FTS top-N + vector
   * top-N. Matches the design doc's §4.3 formula:
   *   score(d) = sum over engines: 1 / (k + rank_engine(d))
   * with k = 60.
   */
  private async searchHybrid(
    req: SearchRequest,
    embedder: Embedder,
    matchCount: number,
    projectFilterId: string | null,
  ): Promise<SearchResponse> {
    const RRF_K = 60;
    const candidateCount = Math.max(matchCount * 5, 30);

    // Run FTS candidates (same filters as searchFts but raw ranks).
    const ftsRows = this.fetchFtsCandidates(req, projectFilterId, candidateCount);
    // Run vector candidates.
    const queryVector = (await embedder.embed([req.query]))[0];
    const vecRows = this.fetchVectorCandidates(req, projectFilterId, embedder);
    const vecRanked = vecRows
      .map((row) => ({
        row,
        score: cosineSimilarity(
          queryVector,
          blobToEmbedding(new Uint8Array(row.embedding as Uint8Array), embedder.dim),
        ),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, candidateCount);

    // Build an id -> rank map for each engine so fusion is cheap.
    const ftsRank = new Map<string, number>();
    ftsRows.forEach((r, i) => ftsRank.set(r.chunk_id, i + 1));
    const vecRank = new Map<string, number>();
    vecRanked.forEach(({ row }, i) => vecRank.set(row.chunk_id, i + 1));

    const fused = new Map<string, { row: VectorCandidateRow; score: number }>();
    // Seed with whichever engine produced each candidate; take the first
    // sighting as the canonical row.
    for (const r of ftsRows) {
      const rrf = 1 / (RRF_K + (ftsRank.get(r.chunk_id) ?? 1));
      fused.set(r.chunk_id, { row: r, score: rrf });
    }
    for (const { row } of vecRanked) {
      const extra = 1 / (RRF_K + (vecRank.get(row.chunk_id) ?? 1));
      const cur = fused.get(row.chunk_id);
      if (cur) {
        cur.score += extra;
      } else {
        fused.set(row.chunk_id, { row, score: extra });
      }
    }

    const ordered = Array.from(fused.values()).sort((a, b) => b.score - a.score);
    const top = ordered.slice(0, matchCount);
    const hits = top.map(({ row, score }) => this.vectorRowToHit(row, score));
    const expandedHits = this.expandSmallToBig(hits, embedder.dim > 768 ? 1 : 2);

    return { hits: expandedHits, mode: "hybrid", totalMatches: ordered.length };
  }

  /**
   * Small-to-big expansion: for each hit chunk, attach the concatenated
   * content of its sibling chunks within `radius` positions in the same
   * document. Siblings don't replace the chunk -- they augment the
   * `content` field so the passage reads naturally.
   *
   * Implementation note: we only expand `content`, not the top-level
   * chunk id / score. Downstream consumers still see the hit as "one
   * chunk" in the UI.
   */
  private expandSmallToBig(hits: SearchHit[], radius: number): SearchHit[] {
    if (radius <= 0 || hits.length === 0) return hits;

    // Group hit chunk indices by document so we can batch the lookup.
    const byDoc = new Map<string, Set<number>>();
    for (const h of hits) {
      const lo = Math.max(0, h.chunkIndex - radius);
      const hi = h.chunkIndex + radius;
      const set = byDoc.get(h.documentId) ?? new Set<number>();
      for (let i = lo; i <= hi; i++) set.add(i);
      byDoc.set(h.documentId, set);
    }

    // Fetch all the sibling contents in one query per document.
    const neighbors = new Map<string, Map<number, string>>();
    for (const [docId, indices] of byDoc.entries()) {
      const placeholders = Array.from(indices).map(() => "?").join(",");
      const rows = this.db.query<{ chunk_index: number; content: string }, (string | number)[]>(
        `SELECT chunk_index, content FROM clio_chunks
          WHERE document_id = ? AND version_id IS NULL AND chunk_index IN (${placeholders})`,
      ).all(docId, ...Array.from(indices));
      const m = new Map<number, string>();
      for (const r of rows) m.set(r.chunk_index, r.content);
      neighbors.set(docId, m);
    }

    return hits.map((h) => {
      const docN = neighbors.get(h.documentId);
      if (!docN) return h;
      const parts: string[] = [];
      for (let i = h.chunkIndex - radius; i <= h.chunkIndex + radius; i++) {
        const body = docN.get(i);
        if (body) parts.push(body);
      }
      // Deduplicate the hit itself so we don't emit "chunk + chunk".
      const expanded = parts.join("\n\n");
      return {
        ...h,
        content: expanded || h.content,
      };
    });
  }

  // ── Candidate fetchers (reused by semantic + hybrid) ──────────────────

  private fetchFtsCandidates(
    req: SearchRequest,
    projectFilterId: string | null,
    candidateCount: number,
  ): VectorCandidateRow[] {
    const matchExpr = buildFtsMatchExpression(req.query);
    const { metaWhere, metaBindings } = this.buildMetadataFilter(req.metadata);

    const sql = `
      SELECT c.id AS chunk_id,
             c.document_id,
             c.chunk_index,
             c.title AS chunk_title,
             c.content,
             c.heading_path,
             c.heading_level,
             c.embedding,
             d.title AS doc_title,
             d.source AS doc_source,
             d.project_id AS doc_project_id,
             p.name AS doc_project_name,
             d.metadata AS doc_metadata,
             bm25(clio_chunks_fts) AS bm25_rank
        FROM clio_chunks_fts f
        JOIN clio_chunks c ON c.rowid = f.rowid
        JOIN clio_documents d ON c.document_id = d.id
        JOIN clio_projects p ON d.project_id = p.id
       WHERE clio_chunks_fts MATCH ?
         AND c.version_id IS NULL
         AND d.deleted_at IS NULL
         ${projectFilterId ? "AND d.project_id = ?" : ""}
         ${metaWhere}
       ORDER BY bm25_rank ASC
       LIMIT ?
    `;
    const bindings: (string | number | boolean)[] = [matchExpr];
    if (projectFilterId) bindings.push(projectFilterId);
    bindings.push(...metaBindings);
    bindings.push(candidateCount);

    return this.db.query<VectorCandidateRow, (string | number | boolean)[]>(sql).all(...bindings);
  }

  /**
   * Fetch every current chunk that matches the project + metadata filter
   * and has an embedding for the active embedder. No prefilter by query
   * text -- brute-force KNN over the candidate set. For the design doc's
   * <100k chunk scale this is sub-second.
   */
  private fetchVectorCandidates(
    req: SearchRequest,
    projectFilterId: string | null,
    embedder: Embedder,
  ): VectorCandidateRow[] {
    const { metaWhere, metaBindings } = this.buildMetadataFilter(req.metadata);

    const sql = `
      SELECT c.id AS chunk_id,
             c.document_id,
             c.chunk_index,
             c.title AS chunk_title,
             c.content,
             c.heading_path,
             c.heading_level,
             c.embedding,
             d.title AS doc_title,
             d.source AS doc_source,
             d.project_id AS doc_project_id,
             p.name AS doc_project_name,
             d.metadata AS doc_metadata,
             0 AS bm25_rank
        FROM clio_chunks c
        JOIN clio_documents d ON c.document_id = d.id
        JOIN clio_projects p ON d.project_id = p.id
       WHERE c.version_id IS NULL
         AND d.deleted_at IS NULL
         AND c.embedding IS NOT NULL
         AND c.embedder = ?
         ${projectFilterId ? "AND d.project_id = ?" : ""}
         ${metaWhere}
    `;
    const bindings: (string | number | boolean)[] = [embedder.name];
    if (projectFilterId) bindings.push(projectFilterId);
    bindings.push(...metaBindings);

    return this.db.query<VectorCandidateRow, (string | number | boolean)[]>(sql).all(...bindings);
  }

  private buildMetadataFilter(metadata?: Record<string, string | number | boolean>): { metaWhere: string; metaBindings: (string | number | boolean)[] } {
    const metaClauses: string[] = [];
    const metaBindings: (string | number | boolean)[] = [];
    if (metadata && typeof metadata === "object") {
      for (const [k, v] of Object.entries(metadata)) {
        metaClauses.push(`json_extract(d.metadata, ?) = ?`);
        metaBindings.push(`$.${k}`);
        metaBindings.push(v as string | number | boolean);
      }
    }
    return {
      metaWhere: metaClauses.length ? ` AND ${metaClauses.join(" AND ")}` : "",
      metaBindings,
    };
  }

  private vectorRowToHit(row: VectorCandidateRow, score: number): SearchHit {
    return {
      chunkId: row.chunk_id,
      documentId: row.document_id,
      chunkIndex: row.chunk_index,
      title: row.chunk_title,
      content: row.content,
      headingPath: parseJsonArray(row.heading_path),
      headingLevel: row.heading_level,
      score,
      docTitle: row.doc_title,
      docSource: row.doc_source,
      docProjectId: row.doc_project_id,
      docProjectName: row.doc_project_name,
      docMetadata: parseJsonObject(row.doc_metadata),
    };
  }

  // ── Stats ──────────────────────────────────────────────────────────────

  async stats(): Promise<ClioStats> {
    const projectCount = this.countOf("clio_projects");
    const documentCount = this.countOf("clio_documents", "deleted_at IS NULL");
    const chunkCount = this.countOf("clio_chunks", "version_id IS NULL");

    let dbSizeBytes = 0;
    const dbPath = this.resolveDbPath();
    try {
      if (dbPath) dbSizeBytes = statSync(dbPath).size;
    } catch { /* DB is ephemeral / in-memory */ }

    const active = getActiveEmbedder(this.db);
    return {
      dbPath: dbPath ?? "(memory)",
      dbSizeBytes,
      projectCount,
      documentCount,
      chunkCount,
      migrations: listAppliedMigrations(this.db),
      activeEmbedder: active ? {
        name: active.name,
        dim: active.dim,
        recommendedChunkMaxChars: active.recommendedChunkMaxChars,
      } : null,
    };
  }

  // ── Migration helper ───────────────────────────────────────────────────

  async migrateDocumentsBetweenProjects(
    fromProjectId: string,
    toProjectId: string,
    opts: { workspaceId?: string; allInProject?: boolean } = {},
  ): Promise<number> {
    if (fromProjectId === toProjectId) return 0;

    // Scope: by default we only move docs tagged with the given
    // workspace_id. `allInProject` preserves the old "move everything"
    // behaviour for the rare case where the user genuinely wants to
    // collapse an old Clio Project into a new one.
    if (!opts.allInProject && !opts.workspaceId) {
      throw new Error(
        "migrateDocumentsBetweenProjects: either workspaceId or allInProject must be set",
      );
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      let result;
      if (opts.allInProject) {
        result = this.db.prepare(
          `UPDATE clio_documents
              SET project_id = ?,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE project_id = ?`,
        ).run(toProjectId, fromProjectId);
      } else {
        result = this.db.prepare(
          `UPDATE clio_documents
              SET project_id = ?,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE project_id = ?
              AND json_extract(metadata, '$.workspace_id') = ?`,
        ).run(toProjectId, fromProjectId, opts.workspaceId!);
      }
      this.db.exec("COMMIT");
      return Number(result.changes);
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ── Reindex ────────────────────────────────────────────────────────────

  async reindex(opts: ReindexOptions = {}): Promise<ReindexResult> {
    const started = Date.now();
    const embedder = await this.getEmbedder();
    if (!embedder) {
      throw new Error(
        "reindex: no active embedder. Install one first with `cfcf clio embedder install <name>`.",
      );
    }
    const batchSize = Math.max(1, Math.min(opts.batchSize ?? 32, 256));

    // Resolve optional project filter.
    let projectFilterId: string | null = null;
    if (opts.project) {
      const p = await this.getProject(opts.project);
      if (!p) {
        return {
          embedder: embedder.name,
          embeddingDim: embedder.dim,
          chunksScanned: 0,
          chunksReembedded: 0,
          chunksSkipped: 0,
          documentsTouched: 0,
          elapsedMs: Date.now() - started,
        };
      }
      projectFilterId = p.id;
    }

    // Find the chunk universe we care about.
    const filterSql = projectFilterId
      ? ` AND d.project_id = ?`
      : "";
    const skipSql = opts.force
      ? ""
      : ` AND (c.embedder IS NULL OR c.embedder != ? OR c.embedding_dim != ? OR c.embedding IS NULL)`;
    const bindings: (string | number)[] = [];
    if (projectFilterId) bindings.push(projectFilterId);
    if (!opts.force) {
      bindings.push(embedder.name);
      bindings.push(embedder.dim);
    }

    // Total count (before filter) for the progress UI.
    const totalBindings: (string | number)[] = [];
    if (projectFilterId) totalBindings.push(projectFilterId);
    const totalRow = this.db.query<{ n: number }, (string | number)[]>(
      `SELECT COUNT(*) AS n
         FROM clio_chunks c
         JOIN clio_documents d ON c.document_id = d.id
        WHERE c.version_id IS NULL
          AND d.deleted_at IS NULL
          ${filterSql}`,
    ).get(...totalBindings);
    const chunksScanned = totalRow?.n ?? 0;

    // Pull the chunks needing re-embedding. Streamed in ID-ordered
    // pages so we don't hold the full set in memory for huge corpora.
    const pageSql = `
      SELECT c.id, c.content, c.document_id
        FROM clio_chunks c
        JOIN clio_documents d ON c.document_id = d.id
       WHERE c.version_id IS NULL
         AND d.deleted_at IS NULL
         ${filterSql}
         ${skipSql}
       ORDER BY c.id
    `;
    const pending = this.db.query<
      { id: string; content: string; document_id: string },
      (string | number)[]
    >(pageSql).all(...bindings);

    let chunksReembedded = 0;
    const touchedDocs = new Set<string>();

    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);
      const vectors = await embedder.embed(batch.map((b) => b.content));
      const blobs = vectors.map((v) => embeddingToBlob(v));

      this.db.exec("BEGIN IMMEDIATE");
      try {
        const upd = this.db.prepare(
          `UPDATE clio_chunks
              SET embedding = ?,
                  embedder = ?,
                  embedding_dim = ?,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = ?`,
        );
        for (let j = 0; j < batch.length; j++) {
          upd.run(blobs[j], embedder.name, embedder.dim, batch[j].id);
          touchedDocs.add(batch[j].document_id);
          chunksReembedded++;
        }
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }

      if (opts.onProgress) {
        opts.onProgress({ processed: Math.min(i + batchSize, pending.length), total: pending.length });
      }
    }

    return {
      embedder: embedder.name,
      embeddingDim: embedder.dim,
      chunksScanned,
      chunksReembedded,
      chunksSkipped: chunksScanned - chunksReembedded,
      documentsTouched: touchedDocs.size,
      elapsedMs: Date.now() - started,
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async close(): Promise<void> {
    if (this.ownsHandle) this.db.close();
  }

  /**
   * Synchronous close, used by the singleton's self-heal path (which
   * runs inside `getClioBackend()`, a sync function). `bun:sqlite`'s
   * `db.close()` is itself sync so this is a thin wrapper.
   */
  closeSync(): void {
    if (this.ownsHandle) {
      try { this.db.close(); } catch { /* ignore -- underlying file may be gone */ }
    }
  }

  /**
   * Report the path of the underlying DB file. Returns `"(memory)"` for
   * ephemeral / test DBs. Exposed so the singleton can check whether
   * the file still exists on disk before returning a stale handle.
   *
   * Uses the path captured at construction time so it works even when
   * the underlying file has been deleted out from under us (querying
   * SQLite in that state can throw).
   */
  getDbPath(): string {
    if (this.dbPath) return this.dbPath;
    // Fallback: query SQLite. This is only used for injected handles
    // where we don't know the path at construction time.
    try {
      return this.resolveDbPath() ?? "(memory)";
    } catch {
      return "(memory)";
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private mapProject(row: {
    id: string;
    name: string;
    description: string | null;
    metadata: string;
    created_at: string;
    updated_at: string;
    document_count?: number;
  }): ClioProject {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      metadata: parseJsonObject(row.metadata),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      documentCount: row.document_count,
    };
  }

  private mapDocument(row: {
    id: string;
    project_id: string;
    title: string;
    source: string;
    content_hash: string;
    metadata: string;
    review_status: string;
    chunk_count: number;
    total_chars: number;
    created_at: string;
    updated_at: string;
    deleted_at: string | null;
  }): ClioDocument {
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      source: row.source,
      contentHash: row.content_hash,
      metadata: parseJsonObject(row.metadata),
      reviewStatus: row.review_status === "pending_review" ? "pending_review" : "approved",
      chunkCount: row.chunk_count,
      totalChars: row.total_chars,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at ?? null,
    };
  }

  private countOf(table: string, where?: string): number {
    const sql = where ? `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}` : `SELECT COUNT(*) AS n FROM ${table}`;
    const row = this.db.query<{ n: number }, []>(sql).get();
    return row?.n ?? 0;
  }

  private resolveDbPath(): string | null {
    const row = this.db.query<{ file: string | null }, []>(
      `SELECT file FROM pragma_database_list WHERE name = 'main' LIMIT 1`,
    ).get();
    return row?.file ?? null;
  }
}

// ── Utilities ────────────────────────────────────────────────────────────

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === "string");
    return [];
  } catch {
    return [];
  }
}

/**
 * Turn a free-text user query into an FTS5 MATCH expression.
 *
 * FTS5's raw MATCH parser is strict: special characters and unbalanced
 * quotes cause syntax errors. We strip control chars + FTS5 operators the
 * user probably didn't mean to use, then wrap each surviving token in
 * double quotes so each is a phrase. Tokens join with OR so any one is a
 * match. Empty / all-stripped input falls back to an impossible string
 * that returns zero hits.
 */
function buildFtsMatchExpression(query: string): string {
  // Remove characters FTS5 treats as operators: ( ) " : * - + ^ NEAR.
  // Keep letters / digits / whitespace / - / _ for hyphenated identifiers.
  // FTS5's porter+unicode61 tokenizer handles the rest.
  const cleaned = query
    .replace(/[\x00-\x1f"():\^*+]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "cf_clio_no_match_sentinel";
  const tokens = cleaned.split(" ").filter((t) => t.length > 0);
  if (tokens.length === 0) return "cf_clio_no_match_sentinel";
  // Quote each token to avoid keyword collisions (e.g. "AND" / "OR" /
  // "NEAR" in the middle of a query). Join with OR.
  return tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}
