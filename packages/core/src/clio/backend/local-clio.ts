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
import type { MemoryBackend } from "./types.js";
import { statSync } from "fs";

const DEFAULT_MATCH_COUNT = 10;
const FTS_CANDIDATE_MULTIPLIER = 5;

// UUID v4 pattern (loose). Used to distinguish "project id" from "project name".
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class LocalClio implements MemoryBackend {
  private readonly db: Database;
  private readonly ownsHandle: boolean;

  /**
   * Construct a LocalClio. By default it opens (and migrates) the DB at
   * `CFCF_CLIO_DB` or `~/.cfcf/clio.db`. Tests can pass their own
   * already-opened Database via `opts.db` to use an isolated temp DB.
   */
  constructor(opts: { db?: Database; path?: string } = {}) {
    if (opts.db) {
      this.db = opts.db;
      this.ownsHandle = false;
    } else {
      this.db = openClioDb({ path: opts.path });
      this.ownsHandle = true;
    }
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

    const chunks = chunkMarkdown(req.content);
    const docId = randomUUID();
    const now = new Date().toISOString();
    const metadata = JSON.stringify(req.metadata ?? {});
    const totalChars = req.content.length;

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
           content, char_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const chunk of chunks) {
        insertChunk.run(
          randomUUID(),
          docId,
          chunk.chunkIndex,
          JSON.stringify(chunk.headingPath),
          chunk.headingLevel,
          chunk.title || null,
          chunk.content,
          chunk.charCount,
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

  // ── Search ─────────────────────────────────────────────────────────────

  async search(req: SearchRequest): Promise<SearchResponse> {
    if (!req.query || !req.query.trim()) {
      throw new Error("search: query is empty");
    }
    const mode = req.mode ?? "fts";
    // PR1 supports FTS only. Hybrid/semantic fall back to FTS with a note
    // in the response (the server layer is responsible for warning callers).
    if (mode !== "fts" && mode !== "hybrid" && mode !== "semantic") {
      throw new Error(`search: unknown mode "${mode}"`);
    }
    const matchCount = Math.max(1, Math.min(req.matchCount ?? DEFAULT_MATCH_COUNT, 100));

    // Resolve optional project filter. Don't auto-create: "search non-existent
    // project" should return zero hits, not silently create a Project.
    let projectFilterId: string | null = null;
    if (req.project) {
      const p = await this.getProject(req.project);
      if (!p) return { hits: [], mode: "fts", totalMatches: 0 };
      projectFilterId = p.id;
    }

    // Translate an FTS5 MATCH query. We quote the user's query so
    // tokenizer-unfriendly characters don't break the parser -- wrapping
    // in double quotes makes it a phrase query, so we also include a
    // fallback pass with individual tokens to keep the feel close to
    // websearch_to_tsquery semantics.
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

    return {
      dbPath: dbPath ?? "(memory)",
      dbSizeBytes,
      projectCount,
      documentCount,
      chunkCount,
      migrations: listAppliedMigrations(this.db),
      // PR2 populates this.
      activeEmbedder: null,
    };
  }

  // ── Migration helper ───────────────────────────────────────────────────

  async migrateDocumentsBetweenProjects(fromProjectId: string, toProjectId: string): Promise<number> {
    if (fromProjectId === toProjectId) return 0;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(
        `UPDATE clio_documents SET project_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE project_id = ?`,
      ).run(toProjectId, fromProjectId);
      this.db.exec("COMMIT");
      return Number(result.changes);
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async close(): Promise<void> {
    if (this.ownsHandle) this.db.close();
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
