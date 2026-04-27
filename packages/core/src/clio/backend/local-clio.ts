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
  ClioDocumentVersion,
  IngestRequest,
  IngestResult,
  SearchRequest,
  SearchResponse,
  SearchHit,
  DocumentSearchResponse,
  DocumentSearchHit,
  ClioStats,
} from "../types.js";
import type {
  MemoryBackend,
  ReindexOptions,
  ReindexResult,
  DocumentContent,
  MetadataSearchRequest,
  MetadataSearchResponse,
  MetadataKeyInfo,
  AuditLogQuery,
} from "./types.js";
import type { ClioAuditEntry } from "../types.js";
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

/** Row shape returned when SELECTing from `clio_documents`. */
interface DocumentRow {
  id: string;
  project_id: string;
  title: string;
  source: string;
  author: string;
  content_hash: string;
  metadata: string;
  review_status: string;
  chunk_count: number;
  total_chars: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /** Optional: present when the SELECT joins on clio_document_versions. */
  version_count?: number;
}

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
  doc_author: string;
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
    // Title is required for create paths. On `--document-id` updates
    // (Branch 1 below) we may take the existing doc's title -- so the
    // emptiness check moves into the create-path resolver instead of
    // here.

    // Resolve (or auto-create) the Project. The caller is expected to
    // pass a slug; UUID inputs skip auto-create (see resolveProject).
    const project = await this.resolveProject(req.project, { createIfMissing: true });
    const contentHash = sha256Hex(req.content);

    // The audit-write call lives at the bottom of this function so a
    // single mutation produces a single audit row regardless of which
    // branch ran. We also surface IngestRequest.author into every
    // entry's `actor` column for write attribution (5.12 + 5.13).
    const actor = req.author?.trim() || "agent";

    // ── Branch 1: update by document_id (deterministic). ──────────────
    //
    // Mirrors Cerefox's `cerefox_ingest(document_id=...)`. The caller
    // explicitly named which document to update; we error if it's
    // missing or soft-deleted rather than silently fall through to a
    // create. `updateIfExists` is overridden when both are passed.
    if (req.documentId) {
      const target = await this.getDocument(req.documentId);
      if (!target || target.deletedAt) {
        throw new Error(`ingest: document_id "${req.documentId}" not found`);
      }
      const result = await this.updateDocument(target, req, contentHash);
      if (req.updateIfExists) {
        result.note = "documentId provided; updateIfExists flag was overridden";
      }
      this.writeAudit({
        eventType: "update-content",
        actor,
        projectId: result.document.projectId,
        documentId: result.id,
        metadata: {
          version_id: result.versionId,
          version_number: result.versionNumber,
          chunks: result.chunksInserted,
          total_chars: result.document.totalChars,
          title_preserved: req.title === undefined,
          author_preserved: req.author === undefined,
        },
      });
      return result;
    }

    // ── Branch 2: update by title (within same Project). ──────────────
    //
    // Mirrors Cerefox's `update_if_exists`. Looks up by exact title in
    // the resolved Project; on hit, snapshot+replace; on miss, fall
    // through to the create path.
    if (req.updateIfExists) {
      // Title is the lookup key for this branch -- required.
      if (!req.title || !req.title.trim()) {
        throw new Error("ingest: title is required when --update-if-exists is set");
      }
      const existing = await this.findDocumentByTitle(project.id, req.title);
      if (existing) {
        const result = await this.updateDocument(existing, req, contentHash);
        this.writeAudit({
          eventType: "update-content",
          actor,
          projectId: result.document.projectId,
          documentId: result.id,
          metadata: {
            version_id: result.versionId,
            version_number: result.versionNumber,
            chunks: result.chunksInserted,
            total_chars: result.document.totalChars,
            matched_by: "title",
          },
        });
        return result;
      }
      // Fall through to create.
    }

    // ── Branch 3: dedup by content_hash. ──────────────────────────────
    //
    // PR1 behaviour: if the exact same content already lives in Clio
    // under any document, skip and return the existing record. The
    // caller can opt out of this dedup by passing `updateIfExists` or
    // `documentId` (both branches above bypass this lookup).
    const existingRow = this.db.query<DocumentRow, [string]>(
      `SELECT * FROM clio_documents WHERE content_hash = ? AND deleted_at IS NULL LIMIT 1`,
    ).get(contentHash);
    if (existingRow) {
      return {
        id: existingRow.id,
        action: "skipped",
        created: false,
        document: this.mapDocument(existingRow),
        chunksInserted: 0,
      };
    }

    // ── Branch 4: create. ─────────────────────────────────────────────
    const created = await this.createDocument(project.id, req, contentHash);
    this.writeAudit({
      eventType: "create",
      actor,
      projectId: created.document.projectId,
      documentId: created.id,
      metadata: {
        chunks: created.chunksInserted,
        total_chars: created.document.totalChars,
      },
    });
    return created;
  }

  // ── Ingest helpers (5.11) ──────────────────────────────────────────────

  /**
   * Insert a brand-new document + its chunks. Embeds chunks before
   * opening the write transaction so we don't hold a write lock during
   * the (slow) embedder call.
   */
  private async createDocument(
    projectId: string,
    req: IngestRequest,
    contentHash: string,
  ): Promise<IngestResult> {
    // Title is required on create paths (no existing doc to inherit from).
    if (!req.title || !req.title.trim()) {
      throw new Error("ingest: title is required when creating a new document");
    }
    const title = req.title;
    const embedder = await this.getEmbedder();
    // Chunker config resolution (Cerefox parity for MAX/MIN_CHUNK_CHARS):
    //   - max: embedder-recommended wins (context window matters more
    //     than a hand-tuned global). FTS-only mode + no embedder →
    //     IngestRequest.chunkMaxChars (server forwards from config) →
    //     4000 default.
    //   - min: IngestRequest.chunkMinChars (server forwards from
    //     config) → 100 default. Caller-side; no embedder override.
    const chunkOpts: { maxChunkChars?: number; minChunkChars?: number } = {};
    if (embedder) {
      chunkOpts.maxChunkChars = embedder.recommendedChunkMaxChars;
    } else if (req.chunkMaxChars !== undefined) {
      chunkOpts.maxChunkChars = req.chunkMaxChars;
    }
    if (req.chunkMinChars !== undefined) chunkOpts.minChunkChars = req.chunkMinChars;
    const chunks = chunkMarkdown(req.content, chunkOpts);
    const embeddings = await this.embedChunks(chunks.map((c) => c.content), embedder, title);

    const docId = randomUUID();
    const now = new Date().toISOString();
    const metadata = JSON.stringify(req.metadata ?? {});
    const totalChars = req.content.length;

    const author = req.author?.trim() || "agent";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO clio_documents
          (id, project_id, title, source, author, content_hash, metadata, review_status,
           chunk_count, total_chars, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        docId,
        projectId,
        title,
        req.source ?? "manual",
        author,
        contentHash,
        metadata,
        req.reviewStatus ?? "approved",
        chunks.length,
        totalChars,
        now,
        now,
      );
      this.insertChunkBatch(docId, chunks, embeddings, embedder, now);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    const doc = await this.getDocument(docId);
    if (!doc) throw new Error(`Clio ingest wrote doc ${docId} but could not read it back`);
    return {
      id: docId,
      action: "created",
      created: true,
      document: doc,
      chunksInserted: chunks.length,
    };
  }

  /**
   * Snapshot the existing live chunks into a new version row, then
   * replace them with new chunks from `req.content`. Mirrors Cerefox's
   * `cerefox_ingest_document` UPDATE branch (rpcs.sql) which delegates
   * to `cerefox_snapshot_version` for the archive-prior-chunks step.
   *
   * Embedding is done before the transaction (same reasoning as
   * createDocument). The transaction holds:
   *   1. INSERT clio_document_versions row   (the snapshot record)
   *   2. UPDATE clio_chunks SET version_id = <new> WHERE document_id = ?
   *      AND version_id IS NULL  (FTS triggers fire here -- prior chunks
   *      drop out of the FTS index because trigger predicate
   *      `WHEN new.version_id IS NULL` no longer matches)
   *   3. UPDATE clio_documents SET title=, content_hash=, metadata=,
   *      chunk_count=, total_chars=, updated_at=
   *   4. INSERT new chunks (FTS triggers fire on insert -- new chunks
   *      enter the FTS index)
   * All four steps are atomic; rollback restores the prior state.
   */
  private async updateDocument(
    target: ClioDocument,
    req: IngestRequest,
    contentHash: string,
  ): Promise<IngestResult> {
    // 5.11 follow-up: on `--document-id` update, preserve target's
    // title + author + metadata when the caller didn't pass them.
    // Rationale: agents typically want to update CONTENT only; the
    // file-ingest CLI defaults `title` to the file basename which
    // would otherwise silently clobber a deliberately-named doc.
    // Caller can still override either field by passing it explicitly.
    const resolvedTitle = req.title?.trim() ? req.title : target.title;
    const titlePreserved = req.title === undefined;
    const newAuthor = req.author?.trim() ? req.author.trim() : target.author;
    const authorPreserved = req.author === undefined;
    const resolvedMetadata = req.metadata ?? target.metadata;

    const embedder = await this.getEmbedder();
    // Chunker config resolution (Cerefox parity for MAX/MIN_CHUNK_CHARS):
    //   - max: embedder-recommended wins (context window matters more
    //     than a hand-tuned global). FTS-only mode + no embedder →
    //     IngestRequest.chunkMaxChars (server forwards from config) →
    //     4000 default.
    //   - min: IngestRequest.chunkMinChars (server forwards from
    //     config) → 100 default. Caller-side; no embedder override.
    const chunkOpts: { maxChunkChars?: number; minChunkChars?: number } = {};
    if (embedder) {
      chunkOpts.maxChunkChars = embedder.recommendedChunkMaxChars;
    } else if (req.chunkMaxChars !== undefined) {
      chunkOpts.maxChunkChars = req.chunkMaxChars;
    }
    if (req.chunkMinChars !== undefined) chunkOpts.minChunkChars = req.chunkMinChars;
    const chunks = chunkMarkdown(req.content, chunkOpts);
    const embeddings = await this.embedChunks(chunks.map((c) => c.content), embedder, resolvedTitle);

    const now = new Date().toISOString();
    const versionId = randomUUID();
    const metadata = JSON.stringify(resolvedMetadata);
    const totalChars = req.content.length;
    // The `source` column on clio_document_versions records WHO WROTE
    // the content being archived (i.e. the prior live author), not
    // who is triggering this update. That way `cfcf clio versions` +
    // future audit queries answer "who wrote v3?" with `versions[0]
    // .source` rather than requiring a JOIN with the audit log.
    // Cerefox's same column conflates "trigger label" + "author"; we
    // pick the more useful interpretation.
    const archivedAuthor = target.author || "agent";
    // Suppress unused-warning by referencing the resolved values above.
    void titlePreserved; void authorPreserved;

    let versionNumber = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Compute the next version number (sequential per document). Mirrors
      // cerefox_snapshot_version's MAX(version_number) + 1.
      const maxRow = this.db.query<{ max_n: number | null }, [string]>(
        `SELECT MAX(version_number) AS max_n FROM clio_document_versions WHERE document_id = ?`,
      ).get(target.id);
      versionNumber = (maxRow?.max_n ?? 0) + 1;

      // Count current chunks for the snapshot's chunk_count + total_chars.
      const liveCounts = this.db.query<{ n: number; chars: number | null }, [string]>(
        `SELECT COUNT(*) AS n, COALESCE(SUM(char_count), 0) AS chars
           FROM clio_chunks
          WHERE document_id = ? AND version_id IS NULL`,
      ).get(target.id);
      const priorChunkCount = liveCounts?.n ?? 0;
      const priorTotalChars = liveCounts?.chars ?? 0;

      // 1. Create the snapshot row. `source` records the author of
      //    the OUTGOING content (target.author). Future audit / version
      //    listing answers "who wrote v3?" without JOINing the audit log.
      this.db.prepare(`
        INSERT INTO clio_document_versions
          (id, document_id, version_number, source, metadata, chunk_count, total_chars, archived, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
      `).run(versionId, target.id, versionNumber, archivedAuthor, "{}", priorChunkCount, priorTotalChars, now);

      // 2. Archive prior live chunks under the new version. The
      //    fts-update trigger fires per row: `WHEN old.version_id IS NULL OR new.version_id IS NULL`
      //    matches old=NULL, so the trigger removes the row from FTS.
      this.db.prepare(`
        UPDATE clio_chunks
           SET version_id = ?, updated_at = ?
         WHERE document_id = ? AND version_id IS NULL
      `).run(versionId, now, target.id);

      // 3. Update the document row in place. `title`/`author`/`metadata`
      //    use the preserve-or-override values resolved above.
      this.db.prepare(`
        UPDATE clio_documents
           SET title = ?, source = ?, author = ?, content_hash = ?, metadata = ?,
               review_status = ?, chunk_count = ?, total_chars = ?, updated_at = ?
         WHERE id = ?
      `).run(
        resolvedTitle,
        req.source ?? target.source,
        newAuthor,
        contentHash,
        metadata,
        req.reviewStatus ?? target.reviewStatus,
        chunks.length,
        totalChars,
        now,
        target.id,
      );

      // 4. Insert the new live chunks.
      this.insertChunkBatch(target.id, chunks, embeddings, embedder, now);

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    const doc = await this.getDocument(target.id);
    if (!doc) throw new Error(`Clio update wrote doc ${target.id} but could not read it back`);
    return {
      id: target.id,
      action: "updated",
      created: false,
      document: doc,
      chunksInserted: chunks.length,
      versionId,
      versionNumber,
    };
  }

  /**
   * Run the embedder over all chunk texts and convert the resulting
   * vectors into BLOBs. Returns null when no embedder is active OR when
   * the embedder call fails -- in either case the caller proceeds to
   * insert chunks without embeddings (FTS still works; vector search
   * skips them). Same semantics as the original PR1 inline block.
   */
  private async embedChunks(
    texts: string[],
    embedder: Embedder | null,
    docTitleForLog: string,
  ): Promise<Uint8Array[] | null> {
    if (!embedder || texts.length === 0) return null;
    try {
      const vectors = await embedder.embed(texts);
      return vectors.map((v) => embeddingToBlob(v));
    } catch (err) {
      console.warn(
        `[clio] embedder failed for "${docTitleForLog}" -- ingesting without embeddings: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * INSERT one chunk per row with the live (`version_id IS NULL`) state.
   * Caller MUST be inside an open write transaction.
   */
  private insertChunkBatch(
    documentId: string,
    chunks: ReturnType<typeof chunkMarkdown>,
    embeddings: Uint8Array[] | null,
    embedder: Embedder | null,
    nowIso: string,
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO clio_chunks
        (id, document_id, chunk_index, heading_path, heading_level, title,
         content, char_count, embedding, embedder, embedding_dim, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const emb = embeddings ? embeddings[i] : null;
      stmt.run(
        randomUUID(),
        documentId,
        chunk.chunkIndex,
        JSON.stringify(chunk.headingPath),
        chunk.headingLevel,
        chunk.title || null,
        chunk.content,
        chunk.charCount,
        emb,
        embedder ? embedder.name : null,
        embedder ? embedder.dim : null,
        nowIso,
        nowIso,
      );
    }
  }

  async getDocument(id: string): Promise<ClioDocument | null> {
    // Subquery for version_count is cheap (the index on
    // clio_document_versions.document_id resolves it in O(versions)).
    const row = this.db.query<DocumentRow, [string]>(
      `SELECT d.*,
              (SELECT COUNT(*) FROM clio_document_versions v WHERE v.document_id = d.id) AS version_count
         FROM clio_documents d
        WHERE d.id = ?
        LIMIT 1`,
    ).get(id);
    if (!row) return null;
    return this.mapDocument(row);
  }

  /**
   * Look up a live document by exact title within a Project. Used by
   * the `updateIfExists` ingest path. Returns the most recently
   * updated match if multiple documents share the same title (this can
   * happen if `updateIfExists` was never used and the user ingested
   * the same title twice; the newer one wins). Soft-deleted documents
   * are excluded.
   */
  async findDocumentByTitle(projectId: string, title: string): Promise<ClioDocument | null> {
    const row = this.db.query<DocumentRow, [string, string]>(
      `SELECT * FROM clio_documents
        WHERE project_id = ? AND title = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 1`,
    ).get(projectId, title);
    if (!row) return null;
    return this.mapDocument(row);
  }

  /**
   * Reconstruct full Markdown content for a document. Default = the
   * live (current) version (`version_id IS NULL`); pass
   * `opts.versionId` to retrieve an archived version returned by
   * `listDocumentVersions`. Mirrors Cerefox's `cerefox_get_document`.
   *
   * Content is the chunks joined with "\n\n" in chunk_index order --
   * round-trip-faithful with the chunker's split convention.
   */
  async getDocumentContent(id: string, opts?: { versionId?: string }): Promise<DocumentContent | null> {
    const doc = await this.getDocument(id);
    if (!doc) return null;
    const versionFilter = opts?.versionId ?? null;

    let rows: { content: string; char_count: number }[];
    if (versionFilter === null) {
      rows = this.db.query<{ content: string; char_count: number }, [string]>(
        `SELECT content, char_count FROM clio_chunks
          WHERE document_id = ? AND version_id IS NULL
          ORDER BY chunk_index ASC`,
      ).all(id);
    } else {
      rows = this.db.query<{ content: string; char_count: number }, [string, string]>(
        `SELECT content, char_count FROM clio_chunks
          WHERE document_id = ? AND version_id = ?
          ORDER BY chunk_index ASC`,
      ).all(id, versionFilter);
    }
    if (rows.length === 0 && versionFilter !== null) {
      // Specific version was requested but no chunks under it.
      return null;
    }

    const content = rows.map((r) => r.content).join("\n\n");
    const totalChars = rows.reduce((acc, r) => acc + r.char_count, 0);
    return {
      document: doc,
      content,
      chunkCount: rows.length,
      totalChars,
      versionId: versionFilter,
    };
  }

  /**
   * List archived versions for a document, newest-first. Empty array
   * for documents that have never been updated. Mirrors Cerefox's
   * `cerefox_list_document_versions`.
   */
  async listDocumentVersions(documentId: string): Promise<ClioDocumentVersion[]> {
    const rows = this.db.query<{
      id: string;
      document_id: string;
      version_number: number;
      source: string | null;
      metadata: string;
      chunk_count: number;
      total_chars: number;
      archived: number;
      created_at: string;
    }, [string]>(
      `SELECT id, document_id, version_number, source, metadata,
              chunk_count, total_chars, archived, created_at
         FROM clio_document_versions
        WHERE document_id = ?
        ORDER BY version_number DESC`,
    ).all(documentId);
    return rows.map((r) => ({
      id: r.id,
      documentId: r.document_id,
      versionNumber: r.version_number,
      source: r.source,
      metadata: parseJsonObject(r.metadata),
      chunkCount: r.chunk_count,
      totalChars: r.total_chars,
      archived: r.archived !== 0,
      createdAt: r.created_at,
    }));
  }

  async listDocuments(opts: {
    project?: string;
    limit?: number;
    offset?: number;
    deletedFilter?: "exclude" | "include" | "only";
  } = {}): Promise<ClioDocument[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    const deletedFilter = opts.deletedFilter ?? "exclude";

    let projectId: string | null = null;
    if (opts.project) {
      // Resolve name → id; if neither name nor id matches, return empty.
      const proj = await this.getProject(opts.project);
      if (!proj) return [];
      projectId = proj.id;
    }
    const where: string[] = [];
    if (deletedFilter === "exclude") where.push("d.deleted_at IS NULL");
    else if (deletedFilter === "only") where.push("d.deleted_at IS NOT NULL");
    // 'include' adds no clause -- both live and tombstoned docs.
    if (projectId) where.push("d.project_id = ?");
    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `
      SELECT d.*,
             (SELECT COUNT(*) FROM clio_document_versions v WHERE v.document_id = d.id) AS version_count
        FROM clio_documents d
        ${whereClause}
       ORDER BY d.created_at DESC
       LIMIT ? OFFSET ?
    `;
    const bindings: (string | number)[] = projectId
      ? [projectId, limit, offset]
      : [limit, offset];
    const rows = this.db.query<DocumentRow, (string | number)[]>(sql).all(...bindings);
    return rows.map((r) => this.mapDocument(r));
  }

  async deleteDocument(id: string, opts: { author?: string } = {}): Promise<void> {
    // Look up first so we can distinguish "doesn't exist" (throws) from
    // "already soft-deleted" (no-op). Mirrors cerefox_delete_document's
    // RAISE EXCEPTION behaviour.
    const actor = opts.author?.trim() || "agent";
    const target = this.db.query<{ id: string; project_id: string; deleted_at: string | null }, [string]>(
      `SELECT id, project_id, deleted_at FROM clio_documents WHERE id = ? LIMIT 1`,
    ).get(id);
    if (!target) throw new Error(`deleteDocument: document "${id}" not found`);
    if (target.deleted_at) return; // already deleted; idempotent (no audit row)
    this.db.prepare(
      `UPDATE clio_documents SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    ).run(id);
    this.writeAudit({
      eventType: "delete", actor,
      projectId: target.project_id, documentId: id,
    });
  }

  async metadataSearch(opts: MetadataSearchRequest): Promise<MetadataSearchResponse> {
    if (!opts.metadataFilter || Object.keys(opts.metadataFilter).length === 0) {
      throw new Error("metadataSearch: metadataFilter must contain at least one key");
    }
    const matchCount = Math.min(Math.max(opts.matchCount ?? 50, 1), 500);

    let projectId: string | null = null;
    if (opts.project) {
      const proj = await this.getProject(opts.project);
      if (!proj) return { documents: [], metadataFilter: opts.metadataFilter };
      projectId = proj.id;
    }

    const conds: string[] = [];
    const bindings: (string | number | boolean)[] = [];

    if (!opts.includeDeleted) conds.push("deleted_at IS NULL");
    if (projectId) {
      conds.push("project_id = ?");
      bindings.push(projectId);
    }
    if (opts.updatedSince) {
      conds.push("updated_at >= ?");
      bindings.push(opts.updatedSince);
    }
    // Per-key json_extract equality. Top-level keys only (matches
    // Cerefox v1; nested-object containment is a future ask).
    for (const [k, v] of Object.entries(opts.metadataFilter)) {
      conds.push(`json_extract(metadata, ?) = ?`);
      bindings.push(`$.${k}`);
      bindings.push(v);
    }

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const sql = `SELECT * FROM clio_documents ${where} ORDER BY updated_at DESC LIMIT ?`;
    bindings.push(matchCount);

    const rows = this.db.query<DocumentRow, (string | number | boolean)[]>(sql).all(...bindings);
    return {
      documents: rows.map((r) => this.mapDocument(r)),
      metadataFilter: opts.metadataFilter,
    };
  }

  async listMetadataKeys(opts: { project?: string } = {}): Promise<MetadataKeyInfo[]> {
    let projectId: string | null = null;
    if (opts.project) {
      const proj = await this.getProject(opts.project);
      if (!proj) return [];
      projectId = proj.id;
    }
    // Pull every live doc's metadata + walk it in JS. SQLite has no
    // native "list JSON keys across rows" without recursive CTE
    // contortions; the corpus is small enough that an N-row scan is
    // fine. Cerefox does this server-side via PG's jsonb_each; we
    // emulate the contract.
    const sql = projectId
      ? `SELECT metadata FROM clio_documents WHERE deleted_at IS NULL AND project_id = ?`
      : `SELECT metadata FROM clio_documents WHERE deleted_at IS NULL`;
    const rows = projectId
      ? this.db.query<{ metadata: string }, [string]>(sql).all(projectId)
      : this.db.query<{ metadata: string }, []>(sql).all();

    const keyToCount = new Map<string, number>();
    const keyToValues = new Map<string, Set<string>>(); // values stringified for set comparison

    for (const r of rows) {
      const m = parseJsonObject(r.metadata);
      for (const [k, v] of Object.entries(m)) {
        keyToCount.set(k, (keyToCount.get(k) ?? 0) + 1);
        // Only collect scalar values for the sample set; arrays/objects
        // would dilute the signal and aren't valid metadata_search
        // filter values anyway (top-level scalars only in v1).
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          let set = keyToValues.get(k);
          if (!set) { set = new Set(); keyToValues.set(k, set); }
          if (set.size < 5) set.add(JSON.stringify(v));
        }
      }
    }

    const out: MetadataKeyInfo[] = [];
    for (const [key, documentCount] of keyToCount) {
      const samples = Array.from(keyToValues.get(key) ?? []).map((s) => JSON.parse(s));
      out.push({ key, documentCount, valueSamples: samples });
    }
    // Most-used keys first (handy for the agent discovering the schema).
    out.sort((a, b) => b.documentCount - a.documentCount);
    return out;
  }

  async restoreDocument(id: string, opts: { author?: string } = {}): Promise<void> {
    const actor = opts.author?.trim() || "agent";
    const target = this.db.query<{ id: string; project_id: string; deleted_at: string | null }, [string]>(
      `SELECT id, project_id, deleted_at FROM clio_documents WHERE id = ? LIMIT 1`,
    ).get(id);
    if (!target) throw new Error(`restoreDocument: document "${id}" not found`);
    if (!target.deleted_at) return; // already live; idempotent (no audit row)
    this.db.prepare(
      `UPDATE clio_documents SET deleted_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    ).run(id);
    this.writeAudit({
      eventType: "restore", actor,
      projectId: target.project_id, documentId: id,
    });
  }

  // ── Audit log (5.13) ───────────────────────────────────────────────────

  /**
   * Internal: write one row to clio_audit_log. Called from the public
   * mutation paths (ingest create/update, deleteDocument, restoreDocument,
   * migrateDocumentsBetweenProjects). Reads (search, get, listDocuments,
   * etc.) intentionally do NOT call this -- the volume would dwarf the
   * write events and the trust story is about who-wrote-what.
   *
   * Failures are swallowed (best-effort): we don't want a stuck audit
   * write to fail an otherwise-successful ingest. The mutation has
   * already committed when this fires.
   */
  private writeAudit(entry: {
    eventType: ClioAuditEntry["eventType"];
    actor: string | null;
    projectId?: string | null;
    documentId?: string | null;
    query?: string | null;
    metadata?: Record<string, unknown>;
  }): void {
    try {
      this.db.prepare(
        `INSERT INTO clio_audit_log (event_type, actor, project_id, document_id, query, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        entry.eventType,
        entry.actor,
        entry.projectId ?? null,
        entry.documentId ?? null,
        entry.query ?? null,
        JSON.stringify(entry.metadata ?? {}),
      );
    } catch (err) {
      // Last-resort warn; never throw from the audit path.
      // eslint-disable-next-line no-console
      console.warn(`[clio] audit write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async getAuditLog(opts: AuditLogQuery = {}): Promise<ClioAuditEntry[]> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const conds: string[] = [];
    const bindings: (string | number)[] = [];

    if (opts.eventType) { conds.push("event_type = ?"); bindings.push(opts.eventType); }
    if (opts.actor)     { conds.push("actor = ?");      bindings.push(opts.actor); }
    if (opts.documentId){ conds.push("document_id = ?"); bindings.push(opts.documentId); }
    if (opts.since)     { conds.push("timestamp >= ?"); bindings.push(opts.since); }
    if (opts.project) {
      const proj = await this.getProject(opts.project);
      if (!proj) return [];
      conds.push("project_id = ?");
      bindings.push(proj.id);
    }

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const sql = `SELECT id, timestamp, event_type, actor, project_id, document_id, query, metadata
                 FROM clio_audit_log ${where}
                 ORDER BY id DESC LIMIT ?`;
    bindings.push(limit);

    const rows = this.db.query<{
      id: number;
      timestamp: string;
      event_type: string;
      actor: string | null;
      project_id: string | null;
      document_id: string | null;
      query: string | null;
      metadata: string | null;
    }, (string | number)[]>(sql).all(...bindings);

    return rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      eventType: r.event_type as ClioAuditEntry["eventType"],
      actor: r.actor,
      projectId: r.project_id,
      documentId: r.document_id,
      query: r.query,
      metadata: r.metadata ? parseJsonObject(r.metadata) : {},
    }));
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
   * Document-level search. The agent-facing default: one row per
   * matching document (Cerefox-style), not per chunk. Mirrors
   * `cerefox_search_docs` behaviour:
   *   1. Run chunk-level search with `matchCount × 5` candidates so
   *      dedup has enough material to fill `matchCount` unique docs.
   *   2. Group hits by `document_id`, keep the best-scoring chunk as
   *      the representative.
   *   3. Truncate to `matchCount` distinct documents.
   *   4. Decorate each hit with `versionCount` + `matchingChunks`
   *      (counts inside the candidate pool, not all chunks).
   *
   * For human/agent search ("which docs match X?") this is far cleaner
   * than chunk-level (which surfaces multiple chunks of the same doc
   * + makes near-irrelevant docs that share ONE keyword sit between
   * chunks of the right doc). Chunk-level remains available via
   * `search()` for callers that need the raw view.
   */
  async searchDocuments(req: SearchRequest): Promise<DocumentSearchResponse> {
    // Doc-level matchCount default is smaller (5) than chunk-level (10):
    // a doc-level "show me top N matches" is more useful with fewer,
    // higher-quality entries than a long list. Cerefox's default is 5.
    const matchCount = Math.max(1, Math.min(req.matchCount ?? 5, 50));

    // Cerefox-style small-to-big knobs (with sensible defaults that
    // match Cerefox's RPC defaults). These can be overridden per-call
    // (when callers pass them on `SearchRequest`) but the global
    // config is the usual source of truth -- the route layer reads
    // it once and forwards.
    const smallDocThreshold = req.smallDocThreshold ?? 20000;
    const contextWindow = Math.max(0, req.contextWindow ?? 1);

    // Fetch a 5x candidate pool so dedup has enough material.
    const chunkRes = await this.search({ ...req, matchCount: matchCount * 5 });

    // Group by documentId, keep the highest-scoring chunk as the
    // representative. Hits are already ordered by score descending,
    // so the first chunk per doc encountered IS the best.
    const seen = new Map<string, SearchHit & { _matching: number }>();
    for (const hit of chunkRes.hits) {
      const existing = seen.get(hit.documentId);
      if (existing) {
        existing._matching++;
      } else {
        seen.set(hit.documentId, { ...hit, _matching: 1 });
      }
    }

    // Take the top `matchCount` unique docs.
    const ranked = Array.from(seen.values()).slice(0, matchCount);

    // Pull versionCount + chunkCount + timestamps in one query for
    // efficiency rather than calling getDocument N times.
    const docIds = ranked.map((h) => h.documentId);
    const docMeta = new Map<string, {
      chunk_count: number;
      total_chars: number;
      version_count: number;
      created_at: string;
      updated_at: string;
    }>();
    if (docIds.length > 0) {
      const placeholders = docIds.map(() => "?").join(",");
      const rows = this.db.query<{
        id: string;
        chunk_count: number;
        total_chars: number;
        version_count: number;
        created_at: string;
        updated_at: string;
      }, string[]>(
        `SELECT d.id, d.chunk_count, d.total_chars, d.created_at, d.updated_at,
                (SELECT COUNT(*) FROM clio_document_versions v WHERE v.document_id = d.id) AS version_count
           FROM clio_documents d
          WHERE d.id IN (${placeholders})`,
      ).all(...docIds);
      for (const r of rows) {
        docMeta.set(r.id, {
          chunk_count: r.chunk_count,
          total_chars: r.total_chars,
          version_count: r.version_count,
          created_at: r.created_at,
          updated_at: r.updated_at,
        });
      }
    }

    // Cerefox-style small-to-big content resolution per hit:
    //   - small doc (total_chars ≤ smallDocThreshold) → return FULL
    //     document content as bestChunkContent. is_partial=false.
    //   - large doc → return matched chunk + contextWindow neighbours
    //     on each side. is_partial=true.
    // Threshold of 0 disables the small-doc-full-content path entirely.
    const fullContentByDoc = new Map<string, string>();
    if (smallDocThreshold > 0) {
      const smallDocIds = ranked
        .filter((h) => (docMeta.get(h.documentId)?.total_chars ?? Infinity) <= smallDocThreshold)
        .map((h) => h.documentId);
      if (smallDocIds.length > 0) {
        const placeholders = smallDocIds.map(() => "?").join(",");
        const chunks = this.db.query<{ document_id: string; content: string; chunk_index: number }, string[]>(
          `SELECT document_id, content, chunk_index
             FROM clio_chunks
            WHERE document_id IN (${placeholders})
              AND version_id IS NULL
            ORDER BY document_id, chunk_index ASC`,
        ).all(...smallDocIds);
        const byDoc = new Map<string, string[]>();
        for (const c of chunks) {
          const arr = byDoc.get(c.document_id) ?? [];
          arr.push(c.content);
          byDoc.set(c.document_id, arr);
        }
        for (const [docId, arr] of byDoc) {
          fullContentByDoc.set(docId, arr.join("\n\n"));
        }
      }
    }

    // For large docs (NOT in fullContentByDoc), build the chunk +
    // contextWindow neighbour window FROM THE DB explicitly. We don't
    // reuse `h.content` because the chunk-level search already ran its
    // own `expandSmallToBig` (with a fixed dim-based radius) which
    // would otherwise leak into the doc-level result, ignoring our
    // contextWindow knob entirely. Fetching fresh from clio_chunks is
    // the only way to honour contextWindow=0 (bare chunk) and any
    // per-call override.
    const partialContent = new Map<string, string>(); // chunkId → final content for the partial path
    const largeDocs = ranked.filter((h) => !fullContentByDoc.has(h.documentId));
    for (const h of largeDocs) {
      const lo = Math.max(0, h.chunkIndex - contextWindow);
      const hi = h.chunkIndex + contextWindow;
      const rows = this.db.query<{ content: string; chunk_index: number }, [string, number, number]>(
        `SELECT content, chunk_index FROM clio_chunks
          WHERE document_id = ? AND version_id IS NULL
            AND chunk_index BETWEEN ? AND ?
          ORDER BY chunk_index ASC`,
      ).all(h.documentId, lo, hi);
      partialContent.set(h.chunkId, rows.map((r) => r.content).join("\n\n"));
    }

    const hits: DocumentSearchHit[] = ranked.map((h) => {
      const meta = docMeta.get(h.documentId);
      const fullDocContent = fullContentByDoc.get(h.documentId);
      const isPartial = fullDocContent === undefined;
      const content = fullDocContent
        ?? partialContent.get(h.chunkId)
        ?? h.content; // last-resort fallback; should never fire
      return {
        documentId: h.documentId,
        docTitle: h.docTitle,
        docSource: h.docSource,
        docAuthor: h.docAuthor ?? "agent",
        docProjectId: h.docProjectId,
        docProjectName: h.docProjectName,
        docMetadata: h.docMetadata,
        chunkCount: meta?.chunk_count ?? 0,
        totalChars: meta?.total_chars ?? 0,
        versionCount: meta?.version_count ?? 0,
        matchingChunks: h._matching,
        bestScore: h.score,
        bestChunkHeadingPath: h.headingPath,
        bestChunkHeadingLevel: h.headingLevel,
        bestChunkTitle: h.title,
        bestChunkContent: content,
        bestChunkId: h.chunkId,
        bestChunkIndex: h.chunkIndex,
        createdAt: meta?.created_at ?? "",
        updatedAt: meta?.updated_at ?? "",
        isPartial,
      };
    });

    return {
      hits,
      mode: chunkRes.mode,
      totalMatches: chunkRes.totalMatches,
      totalDocuments: seen.size,
    };
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
             d.author AS doc_author,
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
        doc_author: string;
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
      docAuthor: r.doc_author ?? "agent",
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
    // Threshold filter (Cerefox port; see decisions-log 2026-04-25).
    // Drops noise-floor matches that would otherwise show up as "hits"
    // simply because the corpus is small. Caller-supplied minScore wins;
    // backend default 0 means "no filter" (the route layer plugs in 0.5
    // when neither call nor config sets a value).
    const minScore = req.minScore ?? 0;
    const filtered = minScore > 0 ? scored.filter((x) => x.score >= minScore) : scored;
    filtered.sort((a, b) => b.score - a.score);
    const top = filtered.slice(0, matchCount);

    const hits = top.map((x) => this.vectorRowToHit(x.row, x.score));
    const expandedHits = this.expandSmallToBig(hits, embedder.dim > 768 ? 1 : 2);

    return { hits: expandedHits, mode: "semantic", totalMatches: hits.length };
  }

  /**
   * Hybrid search: alpha-weighted score blending of normalised FTS
   * BM25 + raw cosine similarity. Cerefox parity (their `p_alpha`
   * RPC parameter; default 0.7).
   *
   * Why renormalisation: SQLite FTS5's `bm25()` returns values in
   * `[-∞, 0]` where more-negative is more relevant -- corpus-relative,
   * unbounded, not directly comparable to cosine `[0, 1]`. We min-max
   * normalise BM25 within the candidate pool, flip sign, scale to
   * `[0, 1]`. Trade-off: the same query against different filter
   * combinations can produce different ABSOLUTE blended scores
   * (because the candidate pool changes), but RELATIVE ranking is
   * preserved -- which is what hybrid search cares about. Cerefox
   * doesn't have this problem because Postgres' `ts_rank_cd` is
   * already in `[0, 1]`.
   *
   * Formula (each chunk):
   *   blended = α × cosine + (1 − α) × normalised_bm25
   *
   * FTS-matched chunks ALWAYS pass through regardless of cosine
   * (mirrors Cerefox's threshold semantics: minScore filters only
   * vector-only candidates). Decisions-log 2026-04-25 + 2026-04-27
   * captures the choice + the algorithm switch from RRF.
   */
  private async searchHybrid(
    req: SearchRequest,
    embedder: Embedder,
    matchCount: number,
    projectFilterId: string | null,
  ): Promise<SearchResponse> {
    const alpha = clampAlpha(req.alpha ?? 0.7);
    const candidateCount = Math.max(matchCount * 5, 30);
    const minScore = req.minScore ?? 0;

    // FTS candidate pool. Each row's `bm25_rank` is BM25 in [-∞, 0]
    // where more-negative = more relevant (we negate below).
    const ftsRows = this.fetchFtsCandidates(req, projectFilterId, candidateCount);
    // Vector candidates + raw cosine per chunk.
    const queryVector = (await embedder.embed([req.query]))[0];
    const vecRows = this.fetchVectorCandidates(req, projectFilterId, embedder);
    const vecScored = vecRows
      .map((row) => ({
        row,
        cosine: cosineSimilarity(
          queryVector,
          blobToEmbedding(new Uint8Array(row.embedding as Uint8Array), embedder.dim),
        ),
      }))
      .sort((a, b) => b.cosine - a.cosine)
      .slice(0, candidateCount);

    // Min-max normalise BM25 across the FTS candidate pool. Convert
    // to a "higher = better" `[0, 1]` scale comparable to cosine.
    // Edge case: if every candidate has the same BM25 score (or only
    // one candidate), all normalise to 1.0 -- the FTS branch's
    // contribution becomes uniform across hits, which is fine
    // (degenerate input → degenerate ranking; α biases stay sensible).
    const ftsNormalised = new Map<string, number>();
    if (ftsRows.length > 0) {
      // bm25_rank is more-negative-better. Lower number = better.
      const ranks = ftsRows.map((r) => r.bm25_rank);
      const minRank = Math.min(...ranks); // most-negative (best)
      const maxRank = Math.max(...ranks); // least-negative (worst)
      const range = maxRank - minRank;
      for (const r of ftsRows) {
        // Flip so best=1, worst=0. When range is 0 (all equal), score=1.
        const normalised = range > 0 ? (maxRank - r.bm25_rank) / range : 1;
        ftsNormalised.set(r.chunk_id, normalised);
      }
    }
    const vecCosine = new Map<string, number>();
    vecScored.forEach(({ row, cosine }) => vecCosine.set(row.chunk_id, cosine));

    // Build fused candidate set. Seed with FTS rows (always pass
    // through). Then add vector rows that either: (a) co-occurred in
    // FTS (boost via the vector contribution), or (b) are vector-only
    // and clear the minScore floor.
    const fused = new Map<string, { row: VectorCandidateRow; score: number }>();
    for (const r of ftsRows) {
      const ftsScore = ftsNormalised.get(r.chunk_id) ?? 0;
      const cosineScore = vecCosine.get(r.chunk_id) ?? 0;
      // FTS-matched chunks ALWAYS pass through (no minScore filter on this branch).
      const blended = alpha * cosineScore + (1 - alpha) * ftsScore;
      fused.set(r.chunk_id, { row: r, score: blended });
    }
    for (const { row, cosine } of vecScored) {
      if (fused.has(row.chunk_id)) continue; // already counted via FTS branch
      // Vector-only: apply minScore floor.
      if (minScore > 0 && cosine < minScore) continue;
      // No FTS match → ftsScore = 0 contribution.
      const blended = alpha * cosine + (1 - alpha) * 0;
      fused.set(row.chunk_id, { row, score: blended });
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
             d.author AS doc_author,
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
             d.author AS doc_author,
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
      docAuthor: row.doc_author ?? "agent",
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
      const changes = Number(result.changes);
      if (changes > 0) {
        // One audit row per migrate call (not per moved doc -- that
        // would balloon the log on big sweeps). The metadata JSON
        // captures from/to projects + the scope decision.
        this.writeAudit({
          eventType: "migrate-project",
          actor: "agent",
          projectId: toProjectId,
          metadata: {
            from_project_id: fromProjectId,
            to_project_id: toProjectId,
            workspace_id: opts.workspaceId ?? null,
            scope: opts.allInProject ? "all-in-project" : "workspace",
            documents_moved: changes,
          },
        });
      }
      return changes;
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

  private mapDocument(row: DocumentRow): ClioDocument {
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      source: row.source,
      author: row.author ?? "agent",
      contentHash: row.content_hash,
      metadata: parseJsonObject(row.metadata),
      reviewStatus: row.review_status === "pending_review" ? "pending_review" : "approved",
      chunkCount: row.chunk_count,
      totalChars: row.total_chars,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at ?? null,
      // version_count is populated only when the calling SELECT joined
      // on clio_document_versions (listDocuments + getDocument do).
      // Other paths (search-hit doc rows, internal lookups) leave it
      // undefined so callers that don't need it pay no JOIN cost.
      versionCount: row.version_count,
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

/**
 * Clamp the hybrid-search alpha (vector vs FTS blend weight) to
 * [0, 1]. Out-of-range inputs (NaN, negatives, > 1) fall back to 0.7
 * (Cerefox default). Used by `searchHybrid` so the engine always sees
 * a sane blend weight regardless of upstream validation.
 */
function clampAlpha(alpha: number): number {
  if (typeof alpha !== "number" || Number.isNaN(alpha) || alpha < 0 || alpha > 1) {
    return 0.7;
  }
  return alpha;
}

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
