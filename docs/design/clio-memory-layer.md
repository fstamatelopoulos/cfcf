# Clio — cf² Memory Layer Design

**Codename:** Clio (muse of history in Greek mythology — remembers what happened, so later agents can learn from it).
**Plan item:** [5.7 — Cross-project knowledge](../plan.md). Lifts the item from "research" into an implementable design.
**Research precursor:** [`docs/research/cross-project-knowledge-layer.md`](../research/cross-project-knowledge-layer.md).
**Status:** Design draft, 2026-04-21. Meant to iterate before any implementation lands.
**Cerefox relationship:** [`github.com/fstamatelopoulos/cerefox`](https://github.com/fstamatelopoulos/cerefox) — Clio is a standalone **fork-by-copy** that reuses schema + algorithms but keeps zero runtime dependency on Cerefox. Local Clio stays API/semantic-compatible with Cerefox so a remote Cerefox backend can be plugged in later via a thin adapter, no role-agent code changes.

---

## 1. Intent

Every cf² agent role (dev, judge, architect, reflection, documenter) writes knowledge during an iteration that currently never leaves the project's repo. A decision made in project A — "use real-time yields instead of fake-timers for this race condition" — doesn't surface when the same agent works on project B two weeks later. **Clio is the persistent memory substrate that closes that gap.**

Concretely:
- **Written** by cf²'s role agents at iteration boundaries.
- **Queried** at context-assembly time by cf² (inject top-k into generated instruction file) and on-demand during a run by the agent (via CLI tool).
- **Queried** by the human user via `cfcf clio <verb>` for introspection.
- **Persisted** locally by default, inside the cf² binary's world (SQLite + sqlite-vec + bundled embedder under `~/.cfcf/`).
- **Future-swappable** for remote Cerefox backend without rewriting role code.

### What Clio is NOT

- Not a general-purpose knowledge base. The substrate is tuned to cf² role artifacts (iteration logs, handoffs, reviews, reflections, decision-log entries).
- Not cross-user. Single-user installation. No ACLs, no tenancy.
- Not a training signal. Pure retrieval.
- Not a replacement for Cerefox. Cerefox remains the user's broader knowledge layer (Cursor, ChatGPT, other agents); Clio is cf²'s private index that happens to share its shape.

## 2. Naming: "project" tension

**Cerefox** uses **Project** as a grouping of related knowledge — the "ecosystem" a bundle of docs belongs to (e.g. "Cerefox", "Teliboria", "Publications"). Multiple projects can share this grouping because they're about the same domain.

**cf² today** uses **project** to mean a single git repository cf² is managing — so "the calc project" is one specific repo with one specific `problem-pack/`.

These collide. In Clio, a grouping like "my TypeScript backend services" would hold memories from many cf² repos (each a separate cf² "project"). The same word can't mean both.

**Proposed resolution:** rename cf²'s `project` → `workspace` across code + API + docs. Then:
- **cf² workspace** = one managed git repo (what's called a project today).
- **Clio Project** = grouping of cf² workspaces that share a knowledge domain (matches Cerefox semantics exactly).

Rename scope if adopted:
- `ProjectConfig` → `WorkspaceConfig` (types)
- `cfcf project init` → `cfcf workspace init` (CLI; keep `project` as deprecated alias for one release)
- `/api/projects/*` → `/api/workspaces/*` (REST; keep `/api/projects/*` as deprecated alias for one release)
- All docs + templates + UI labels
- The `cfcf-docs/` internal file tree stays (`cfcf-docs/iteration-logs/`, etc.) — those names don't reference "project."
- **Project detail page** (web UI) becomes Workspace detail page; **Projects** top-bar link becomes **Workspaces**.

This is a breaking change. It should land as its own iter-5.x polish PR **before** Clio ships, so Clio can be built in a world where the two nouns don't overload. Alternative (keep cf²'s "project" and invent a non-Cerefox-compatible name for the grouping tier) would be faster but permanently forks cf² from Cerefox semantics — discouraged.

**For the rest of this document, "workspace" refers to a single cf² repo and "Clio Project" refers to the grouping tier.** Wherever this doc says "workspace" the code still uses "project" today — read with that in mind.

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                       cf² agents                                │
│  dev · judge · architect · reflection · documenter              │
│   │                          │                                  │
│   │ (agent calls during run) │ (harness preload at assembly)    │
│   ▼                          ▼                                  │
│  bash: `cfcf clio search <q> --project <slug>`                  │
│        `cfcf clio ingest ...`                                   │
│        `cfcf clio get <id>` etc.                                │
└───────────────────────┬─────────────────────────────────────────┘
                        │ HTTP (localhost)
┌───────────────────────▼─────────────────────────────────────────┐
│                    cf² server (Hono)                            │
│                                                                 │
│   /api/clio/search           /api/clio/ingest                   │
│   /api/clio/documents/:id    /api/clio/projects                 │
│   /api/clio/metadata/* etc.                                     │
│                        │                                        │
│                        ▼                                        │
│            ┌───────────────────────┐                            │
│            │   MemoryBackend       │   swap point for future    │
│            │   (interface)         │   remote Cerefox adapter   │
│            └───────────┬───────────┘                            │
│                        │                                        │
│        ┌───────────────┴───────────────┐                        │
│        │                               │                        │
│  ┌─────▼────────┐             ┌────────▼──────┐                 │
│  │ LocalClio    │             │ CerefoxRemote │   (later)       │
│  │ (default)    │             │ (optional)    │                 │
│  └─────┬────────┘             └───────────────┘                 │
│        │                                                        │
│        │                                                        │
│   ┌────▼────────────────────────────────────────────┐           │
│   │ SQLite ~/.cfcf/clio.db                          │           │
│   │  - clio_projects, clio_documents, clio_chunks,  │           │
│   │    clio_document_versions, clio_audit_log       │           │
│   │  - sqlite-vec virtual table for embeddings      │           │
│   │  - fts5 virtual table for keyword search        │           │
│   └─────────────────────────────────────────────────┘           │
│                                                                 │
│   Embedder: ONNX Runtime loading bge-small-en-v1.5 from         │
│             ~/.cfcf/models/ (extracted on first use from the    │
│             cfcf binary or downloaded if lazy-load is on)       │
└─────────────────────────────────────────────────────────────────┘
```

Key points:
- **One process, one binary, one port** — the existing Hono server gets new routes. No separate memory daemon, no new install story.
- **Single SQLite file** at `~/.cfcf/clio.db` (override via `CFCF_CLIO_DB` env). Single database with `project_id` metadata on every chunk, matching Cerefox's design.
- **`MemoryBackend` interface** as the swap point. v1 ships `LocalClio` only. A `CerefoxRemote` adapter is additive in a later iteration and must satisfy the same interface.
- **Agents talk to Clio through bash** (`cfcf clio ...`). Universal across adapters (Claude Code, Codex, future). No MCP server in v1; remote Cerefox integration (later) talks to Cerefox's existing Supabase RPCs over HTTPS.

## 4. SQLite stack

### 4.1 Vector extension: `sqlite-vec`

Choice. `sqlite-vec` (Alex Garcia) is the actively maintained successor to `sqlite-vss`. Pure C, no Faiss dependency, prebuilt binaries for every platform cf² targets, simpler embed path. Current brute-force KNN is sub-second at our expected scale (<100k chunks per user across all workspaces); HNSW is on the extension's roadmap.

Usage mode. We'll use the **embedding-in-table** pattern:
- Store embedding as a `BLOB` column on `clio_chunks` (4 bytes per float × dim).
- Use the `vec_distance_cosine(a, b)` function at query time for distance.
- A companion `vec0` virtual table is available for when we want HNSW later (and doesn't require migration — we can materialise it on demand from the main chunks table).

### 4.2 Keyword / sparse side: FTS5

SQLite ships FTS5 built-in; no extension required. Create a `clio_chunks_fts` virtual table over `clio_chunks.content`. Use BM25 ranking (FTS5's default). Keep synchronised via triggers.

### 4.3 Hybrid search

Reciprocal Rank Fusion (RRF, Cormack/Clarke/Buettcher) with k=60 — the de-facto standard for combining dense + sparse without per-system rank calibration. Same approach Cerefox's `cerefox_hybrid_search` Postgres RPC uses.

```
score(d) = Σ over engines: 1 / (k + rank_engine(d))
```

SQLite CTE that does it in one query:

```sql
WITH
  fts_hits AS (
    SELECT chunk_id, row_number() OVER (ORDER BY bm25(clio_chunks_fts)) AS r
    FROM clio_chunks_fts WHERE clio_chunks_fts MATCH :query LIMIT :fts_k
  ),
  vec_hits AS (
    SELECT id AS chunk_id, row_number() OVER (ORDER BY vec_distance_cosine(embedding, :q_vec)) AS r
    FROM clio_chunks WHERE version_id IS NULL LIMIT :vec_k
  ),
  fused AS (
    SELECT chunk_id, (1.0/(60+r)) AS score FROM fts_hits
    UNION ALL
    SELECT chunk_id, (1.0/(60+r)) AS score FROM vec_hits
  )
SELECT chunk_id, SUM(score) AS rrf_score FROM fused GROUP BY chunk_id ORDER BY rrf_score DESC LIMIT :match_count;
```

### 4.4 Small-to-big retrieval

After ranking chunks, pull each winner's **sibling chunks** from the same document (same `document_id`, ±N in `chunk_index`, `version_id IS NULL`) for full-passage context. Same pattern as Cerefox — precision from chunk-level match, coherence from passage-level return.

## 5. Schema

Reused from Cerefox almost verbatim (minus Postgres-specific types). SQLite + FTS5 + sqlite-vec.

```sql
-- Projects: domain grouping. Compatible with Cerefox's project concept.
CREATE TABLE clio_projects (
  id         TEXT PRIMARY KEY,            -- UUID
  name       TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Documents: one per ingested artifact (iteration-log, reflection-analysis,
-- judge-assessment, decision-log entry, architect-review).
CREATE TABLE clio_documents (
  id             TEXT PRIMARY KEY,        -- UUID
  project_id     TEXT NOT NULL REFERENCES clio_projects(id),
  title          TEXT NOT NULL,
  source         TEXT NOT NULL,           -- e.g. "cfcf-docs/iteration-logs/iteration-3.md"
  content_hash   TEXT NOT NULL UNIQUE,    -- sha256 of the full markdown; dedupe guard
  metadata       TEXT NOT NULL DEFAULT '{}',  -- JSON blob; filterable via json_extract
  review_status  TEXT NOT NULL DEFAULT 'approved',  -- 'approved' | 'pending_review'
  chunk_count    INTEGER NOT NULL DEFAULT 0,
  total_chars    INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Chunks: search corpus. One row per chunk, for current and (v2+) archived versions.
-- Current chunks have version_id IS NULL; archived chunks point to clio_document_versions.
CREATE TABLE clio_chunks (
  id              TEXT PRIMARY KEY,
  document_id     TEXT NOT NULL REFERENCES clio_documents(id) ON DELETE CASCADE,
  version_id      TEXT REFERENCES clio_document_versions(id),  -- NULL = current
  chunk_index     INTEGER NOT NULL,
  heading_path    TEXT NOT NULL DEFAULT '[]',  -- JSON array of heading titles
  heading_level   INTEGER,
  content         TEXT NOT NULL,
  char_count      INTEGER NOT NULL,
  embedding       BLOB NOT NULL,            -- sqlite-vec FLOAT[384] for bge-small
  embedder        TEXT NOT NULL,            -- e.g. "bge-small-en-v1.5"
  embedding_dim   INTEGER NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Enforce one-current-chunk per (document_id, chunk_index) -- matches Cerefox's
-- partial unique index.
CREATE UNIQUE INDEX clio_chunks_current_idx
  ON clio_chunks(document_id, chunk_index) WHERE version_id IS NULL;

CREATE INDEX clio_chunks_doc_idx ON clio_chunks(document_id);
CREATE INDEX clio_chunks_version_idx ON clio_chunks(version_id);

-- FTS5 virtual table over current chunks.
CREATE VIRTUAL TABLE clio_chunks_fts USING fts5(
  content,
  content='clio_chunks',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Triggers: keep FTS in sync, and skip archived chunks.
CREATE TRIGGER clio_chunks_ai AFTER INSERT ON clio_chunks
  WHEN new.version_id IS NULL
BEGIN
  INSERT INTO clio_chunks_fts(rowid, content) VALUES (new.rowid, new.content);
END;
-- ... ad / au similarly.

-- Document versions: v2+ feature. Schema in place now so v1 ingests don't
-- need a migration later.
CREATE TABLE clio_document_versions (
  id              TEXT PRIMARY KEY,
  document_id     TEXT NOT NULL REFERENCES clio_documents(id) ON DELETE CASCADE,
  version_number  INTEGER NOT NULL,
  metadata        TEXT NOT NULL DEFAULT '{}',
  chunk_count     INTEGER NOT NULL,
  total_chars     INTEGER NOT NULL,
  source          TEXT,
  archived        INTEGER NOT NULL DEFAULT 0,    -- protect specific versions from retention
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(document_id, version_number)
);

-- Audit log: v2+ feature. Ingested / searched / retrieved / deleted events.
CREATE TABLE clio_audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  event_type   TEXT NOT NULL,     -- 'ingest' | 'search' | 'get' | 'delete' | 'restore' | 'purge'
  actor        TEXT,              -- e.g. "cfcf-harness", "dev:claude-code:sonnet-4.5", "user"
  project_id   TEXT,
  document_id  TEXT,
  query        TEXT,              -- for search events
  metadata     TEXT                -- JSON details
);
```

### 5.1 Metadata conventions

Metadata is JSON, queryable via SQLite's JSON1 `json_extract`. Standard keys for cf²-written docs:

```json
{
  "workspace_id": "calc-5dbcfa",         // the cf² workspace (renamed from "project")
  "workspace_name": "calc",
  "iteration": 5,
  "role": "dev",                          // dev | judge | architect | reflection | documenter | user
  "author": "dev:claude-code:sonnet-4.5", // <role>:<adapter>[:<model>]
  "artifact_type": "iteration-log",       // iteration-log | iteration-handoff | judge-assessment
                                          // | reflection-analysis | decision-log-entry | architect-review
  "tier": "episodic",                     // "episodic" (raw) | "semantic" (curated lessons)
  "tags": ["auth", "async-test"],         // optional free tags
  "reflection_health": "converging"       // reflection-analysis only; informs ranking boosts
}
```

Three metadata keys we'll index directly (via indexed JSON extraction) for query performance: `workspace_id`, `role`, `artifact_type`. Everything else stays JSON-queried. Free-text `tags` live in the JSON.

### 5.2 What gets written, when

| Trigger | What is ingested | Metadata highlights |
|---|---|---|
| End of DEV phase (post-commit) | `cfcf-docs/iteration-logs/iteration-N.md` | role=dev, artifact_type=iteration-log, tier=episodic |
| End of DEV phase (post-commit) | `cfcf-docs/iteration-handoff.md` (the live file; the archived copy too on v2) | role=dev, artifact_type=iteration-handoff, tier=episodic |
| End of JUDGE phase (post-commit) | `cfcf-docs/judge-assessment.md` | role=judge, artifact_type=judge-assessment, tier=episodic |
| End of REFLECT phase (post-commit) | `cfcf-docs/reflection-analysis.md` | role=reflection, artifact_type=reflection-analysis, tier=semantic (reflections are already compressed/strategic) |
| Each `decision-log.md` append | The new entry only (parsed out of the tagged section) | role from the `[role: X]` tag; tier=semantic if category is lesson/strategy, episodic otherwise |
| End of ARCHITECT review (first-run or re-review) | `cfcf-docs/architect-review.md` | role=architect, artifact_type=architect-review, tier=semantic |
| Manual via CLI | Anything the user passes | role=user, tier=semantic |

Content-hash dedup means re-running an iteration that happens to produce an identical artifact won't double-ingest.

### 5.3 What gets preloaded into the agent

At context-assembly time, the cf² harness runs two queries:
1. **Broad:** top-k semantic hits for the Problem Pack's `problem.md` across all Clio Projects. Surfaces generalised lessons.
2. **Narrow:** top-k hits filtered by `artifact_type IN ('reflection-analysis', 'architect-review')` scoped to the current Clio Project (if the workspace is mapped to one). Surfaces curated strategic notes from sibling workspaces.

Results (the small-to-big expanded passages, not raw chunks) land in a new file `cfcf-docs/clio-relevant.md` that the generated `CLAUDE.md` / `AGENTS.md` points at as a Tier-2 read. Fresh each iteration.

## 6. Embedder strategy

### 6.1 v1 default

**`bge-small-en-v1.5`** (BAAI). 384 dimensions, ~120 MB, strong retrieval quality for its size, permissive MIT licence, widely benchmarked. Runs via ONNX Runtime Node bindings in-process.

### 6.2 Alternatives (v1 bundles one, others downloadable in later iterations)

| Model | Dim | Size | When useful |
|---|---|---|---|
| `all-MiniLM-L6-v2` | 384 | 23 MB | Low-resource installs; binary-size sensitive; 2× faster than bge-small but quality is visibly weaker |
| `bge-small-en-v1.5` (default) | 384 | 120 MB | Balanced — recommended for v1 |
| `bge-base-en-v1.5` | 768 | 430 MB | Quality bump; worth it for 10k+ chunk corpora |
| `nomic-embed-text-v1.5` | 768 | 140 MB | Long-context (8k tokens) — useful if we ever ingest undersized chunks |
| `mxbai-embed-large-v1` | 1024 | 670 MB | Top quality; overkill for v1 |

### 6.3 Per-Project embedder pinning

Embeddings are not cross-model compatible. We record the `embedder` and `embedding_dim` on every chunk row. If the user switches embedders later (`cfcf clio embedder set <name>`), cf² will:
1. Refuse to mix — new ingests use the new model; existing chunks stay queryable only when the query is embedded with the model they were stored under.
2. Surface a `cfcf clio reindex` command to re-embed everything under the new model. This is an offline, one-shot, async operation. Schema already supports the transition via the `embedding_upgrade` column we'll add when this feature lands (mirroring Cerefox's approach).

For v1: single bundled embedder, no switching, `reindex` deferred.

### 6.4 Runtime: ONNX Runtime Node

`onnxruntime-node` provides platform binaries (darwin-arm64 / darwin-x64 / linux-x64 / win32-x64) around 30 MB each. The ONNX model file itself is separate. Both bundled into the cf² binary via Bun's asset embedding, extracted to `~/.cfcf/models/` and `~/.cfcf/native/` on first use (same pattern as sqlite-vec).

## 7. API design

Two surfaces: **HTTP** on the cf² server, **CLI** commands that call the HTTP surface. Both mirror the Cerefox MCP tool verbs for semantic compatibility.

### 7.1 HTTP endpoints (cf² server)

All under `/api/clio/*`. JSON bodies, same auth / error-shape conventions as the rest of the cf² API.

| Method | Path | Purpose | v1? |
|---|---|---|---|
| `POST` | `/api/clio/ingest` | Ingest a document (chunk + embed + store). Cerefox-compatible body shape. | ✅ |
| `GET`  | `/api/clio/search` | Hybrid search. Query params: `q`, `project`, `match_count`, `metadata`, `mode` (`hybrid` / `fts` / `semantic`). | ✅ |
| `GET`  | `/api/clio/documents/:id` | Retrieve a document by id. Optional `?version_id=` (v2+). | ✅ (v1 without version param) |
| `GET`  | `/api/clio/projects` | List Clio Projects (name, id, document_count). | ✅ |
| `GET`  | `/api/clio/metadata/keys` | List all metadata keys used by any document in a project. | v2 |
| `POST` | `/api/clio/metadata/search` | Exact-match metadata filter; returns matching documents without text scoring. | v2 |
| `GET`  | `/api/clio/documents/:id/versions` | List archived versions. | v2 |
| `GET`  | `/api/clio/audit-log` | Query the audit log with filters. | v2 |
| `DELETE` | `/api/clio/documents/:id` | Soft-delete. | v2 |
| `POST` | `/api/clio/documents/:id/restore` | Restore soft-deleted. | v2 |
| `GET`  | `/api/clio/stats` | DB size, chunk count per project, index health. | ✅ |

### 7.2 CLI commands

Top-level `cfcf clio <verb>`; `cfcf memory` is registered as an alias for discoverability (commander.js `.alias('memory')`).

```bash
# Search
cfcf clio search "flaky async auth tests"
cfcf clio search "retrieval patterns" --project "cf-ecosystem" --match-count 5 --mode hybrid
cfcf clio search "auth" --metadata '{"role":"judge","tier":"semantic"}'

# Project management
cfcf clio projects                       # list all
cfcf clio project create "cf-ecosystem" --description "cf², Clio, Cerefox code"
cfcf clio project show cf-ecosystem

# Ingest (mostly automated, but manual path for ad-hoc notes)
cfcf clio ingest path/to/note.md --project cf-ecosystem --title "Deprecation note"
cfcf clio ingest --stdin --project cf-ecosystem --title "..." < file.md

# Retrieve
cfcf clio get <document-id>
cfcf clio get <document-id> --raw    # just the content
cfcf clio get <document-id> --json   # with metadata

# Reindex (v2+): re-embed all chunks with the current embedder
cfcf clio reindex --project cf-ecosystem
cfcf clio embedder list               # show available
cfcf clio embedder set bge-base-en-v1.5

# Introspection
cfcf clio stats
cfcf clio metadata keys --project cf-ecosystem     # v2

# Migration (later)
cfcf clio migrate --to cerefox --url https://... --token ...   # v2+
```

Verbs match Cerefox MCP tools where they exist (`search`, `ingest`, `get_document` → `get`, `list_projects` → `projects`, `list_versions`, `get_audit_log`, `metadata_search`, `list_metadata_keys`). The tense/form differs (CLI prefers imperative verb form, MCP uses `list_*` / `get_*` noun forms) but the semantics and payload shapes are 1:1.

### 7.3 Agent-exposed guide

cf² writes `cfcf-docs/clio-guide.md` per iteration — short, cue-card style. Points agents at the commands they can invoke during a run. Excerpt:

```markdown
# Clio — cross-project memory (quick reference for agents)

When you hit a question past iterations or other workspaces may have answered,
run `cfcf clio search "<your question>"`. Returns up to 5 relevant markdown
passages with source + metadata.

Scope narrower by adding `--project <project-name>` (a Clio Project is a
grouping of cf² workspaces; see `cfcf clio projects` to list).

Filter by role / artifact: `--metadata '{"role":"reflection"}'`. Valid roles:
dev, judge, architect, reflection, documenter, user. Valid artifact types:
iteration-log, iteration-handoff, judge-assessment, reflection-analysis,
decision-log-entry, architect-review.

Retrieve a full document by id: `cfcf clio get <id>`.

You do NOT need to ingest anything. cf² automatically ingests this iteration's
outputs after each phase commits — your iteration-log, handoff,
decision-log entries, plus judge and reflection outputs produced later
in the loop.
```

The generated `CLAUDE.md` / `AGENTS.md` lists this as a Tier-2 read.

## 8. Packaging and delivery

### 8.1 What gets bundled into `cfcf-binary`

Beyond today's embedded assets (templates + web dist):

| Asset | Approx size | Per platform? |
|---|---|---|
| `sqlite-vec` native extension | ~1 MB | ✅ (darwin-arm64/x64, linux-x64, win32-x64) |
| `onnxruntime-node` native binding | ~30 MB | ✅ |
| `bge-small-en-v1.5.onnx` model | ~120 MB | ❌ (same ONNX file across platforms) |
| Tokeniser files for the model | ~2 MB | ❌ |

**Total binary growth: ~150 MB → final binary ~220 MB.** User confirmed acceptable.

Embedding strategy: mirrors `scripts/embed-web-dist.ts` → we add `scripts/embed-clio-assets.ts` that base64-encodes each asset into a generated `packages/server/src/clio-assets.generated.ts` (gitignored). On first Clio use, the cf² server:
1. Checks `~/.cfcf/native/sqlite-vec.<ext>` and `~/.cfcf/models/bge-small-en-v1.5.onnx` — if present, use them.
2. If absent, extract from the embedded base64 asset map and write to disk (one-time cost, ~0.5s).
3. Load via `db.loadExtension(...)` and `ort.InferenceSession.create(...)` respectively.

Users who'd rather save disk can use `CFCF_CLIO_LAZY_DOWNLOAD=1` — skip the embed, fetch model + extension from a pinned GitHub Releases URL on first use.

### 8.2 DB location

Default `~/.cfcf/clio.db`. Override via `CFCF_CLIO_DB` (same pattern as `CFCF_CONFIG_DIR` / `CFCF_LOGS_DIR`). Single DB for all projects, cross-workspace by design.

### 8.3 Schema migrations

`packages/core/src/clio/migrations/NNNN_description.sql` files, executed in order on server startup. Standard pattern. Migration version tracked in a `clio_migrations` table.

## 9. Cerefox reuse strategy

**Fork-by-copy, no runtime dependency.** Cerefox continues to evolve (knowledge graph is planned); cf² shouldn't drag that complexity in. We copy the bits we need at this moment in time, keep attribution, and let the two projects diverge.

What we copy from `../cerefox`:

| Cerefox artifact | Clio equivalent | Reuse mode |
|---|---|---|
| `src/cerefox/db/rpcs.sql` (1649 lines Postgres) | `packages/core/src/clio/sql/*.sql` + TS code using better-sqlite3 | **Port, don't copy.** Postgres-specific (`pgvector`, `tsvector`, `ts_rank`). Rewrite for SQLite + sqlite-vec + FTS5. Algorithms preserved (RRF, small-to-big expansion, metadata filter, dedup by content_hash). ~1000 lines SQLite, half as many TS helpers around it. |
| `src/cerefox/chunking/markdown.py` (305 Python) | `packages/core/src/clio/chunking/markdown.ts` | **Port to TypeScript.** Heading-aware Markdown chunker using `unified` + `remark-parse`. Algorithm 1:1 (chunk-boundary heuristics, heading_path, heading_level assignment, chunk-size targeting). ~250 TS lines. |
| `src/cerefox/embeddings/base.py` + `cloud.py` | `packages/core/src/clio/embedders/*.ts` | **Port.** Local ONNX embedder is cf²-specific (Cerefox uses cloud embeddings). Interface shape from `base.py` is reused; implementation is new. |
| `supabase/functions/cerefox-search/index.ts` | `packages/server/src/routes/clio/search.ts` | **Reference — reimplement.** Argument parsing, response envelope, and query-composition logic are structurally similar but Hono + SQLite is different enough that we rewrite rather than copy. |
| `supabase/functions/cerefox-ingest/index.ts` | `packages/server/src/routes/clio/ingest.ts` | **Reference — reimplement.** Same as above. |
| `supabase/functions/cerefox-mcp/*` | n/a for v1 | **Don't port.** MCP server is a later additive concern; when we do add it, this is the template. |
| Schema design (tables, indexes, FKs, versioning semantics) | `packages/core/src/clio/migrations/0001_initial.sql` | **Borrow directly.** Table shapes translate almost verbatim; only types change (UUID → TEXT, TIMESTAMPTZ → TEXT ISO, JSONB → TEXT with JSON1). |
| Metadata conventions (filterable keys, review_status) | ditto | **Borrow.** |
| CLI verb names + argument shapes | `packages/cli/src/commands/clio.ts` | **Match semantics; swap transport.** MCP → CLI + HTTP. |

**Attribution.** Each ported file gets a header comment: `// Derived from cerefox/<path> @<commit-sha>. Maintained independently in cf².` Cerefox is MIT, cf² will be too, no licence friction.

**Drift over time.** Expected and accepted. If Cerefox adds knowledge-graph extraction or a new chunking strategy, cf² decides independently whether it's worth porting. If cf² needs cf²-specific tuning (e.g. boosts on `reflection-analysis` documents), that doesn't bleed into Cerefox.

## 10. Security and privacy

- **All data stays on the machine** in v1. No network calls from the Clio path. Embedder runs locally via ONNX Runtime.
- **SQLite file is a plain file** under `~/.cfcf/clio.db`. Users can back it up, move it, inspect with any SQLite tool. Same trust posture as `~/.cfcf/logs/`.
- **No cross-user leak** — single-user installation, no multi-tenancy.
- **When `CerefoxRemote` lands** (v3+), it carries its own privacy story: user's self-hosted Cerefox + whatever embedder they've configured there. The cf² binary won't ship OpenAI or any cloud embedder bundled.
- **The audit log** (v2) stores query strings. User-visible, introspectable via `cfcf clio audit`. Nothing hidden.

## 11. Implementation phases

### v1 — "local Clio works end-to-end" (one iteration, likely one large PR)

- Schema + sqlite-vec + FTS5 + migrations infrastructure.
- LocalClio `MemoryBackend` impl: write + search + get + list-projects.
- Bundled embedder (bge-small) + ONNX runtime + sqlite-vec in the binary.
- HTTP endpoints for the above + `/api/clio/stats`.
- CLI: `cfcf clio search | ingest | get | projects | stats`. `cfcf memory` alias.
- Auto-ingest hooks in the iteration loop (dev, judge, reflection, architect artifacts + decision-log entries).
- Context-assembly preload: `cfcf-docs/clio-relevant.md` generated each iteration.
- Agent guide: `cfcf-docs/clio-guide.md` generated per iteration; referenced from CLAUDE.md/AGENTS.md Tier-2 reads.
- Tests: chunking, embeddings, hybrid search, small-to-big expansion, ingest idempotency (content_hash dedup), migration runner.
- Docs: `docs/guides/clio-quickstart.md`, updates to `workflow.md` + `cli-usage.md`.
- Release: `v0.8.0` (this is big enough — Clio is a new core component — to bump minor rather than patch).

### v2 — governance + migration

- `clio_document_versions` + `cfcf clio reindex`.
- `clio_audit_log` + `cfcf clio audit`.
- Metadata search endpoints (`/api/clio/metadata/*`).
- Embedder switching + multi-embedder support (with the `embedding_upgrade` column pattern from Cerefox).
- `cfcf clio migrate --to cerefox` one-shot exporter.

### v3+ — remote Cerefox backend

- `CerefoxRemote` `MemoryBackend` impl behind the same interface.
- `memoryBackend: { kind: "cerefox", url, token }` config + validation.
- All CLI verbs work identically against either backend.

### Out of scope (for now)

- MCP server. If we want it later, the Cerefox edge-function code is the template.
- Knowledge graph / entity extraction.
- LLM-based memory compaction (Generative Agents-style). Revisit when corpus grows past O(100k) chunks.
- Multi-user / team deployments.

## 12. Open questions

Tracking for the next iteration of this doc:

1. **The workspace rename.** Proposed in §2. Confirm approach; if agreed, schedule as a breaking-change PR that lands before Clio v1.
2. **Content-hash dedup granularity.** Per-artifact (each iteration-log is one document, dedup'd as a whole) vs. per-heading (each heading becomes a sub-document). Per-artifact is simpler; per-heading gives finer retrieval. Start per-artifact.
3. **How much of an iteration to write.** Every phase or only rollup? Proposed: every phase (iteration-log, handoff, judge, reflection) — each is small (~1-5 KB) and the dedup guards against noise. Reconsider if the corpus grows faster than expected.
4. **Ranking boosts.** Should `reflection-analysis` documents get a score boost in general retrieval (since they're curated and strategic)? Probably yes, small one (e.g. +10% on RRF score). Decide during implementation based on how the preloaded context feels in practice.
5. **Clio Project auto-assignment.** When a cf² workspace first runs and ingests something, which Clio Project does it default to? Options: (a) "Default" single project; (b) one Project per workspace (maximises separation, kills the cross-workspace sharing that's the whole point); (c) user explicitly assigns via `cfcf workspace set --clio-project <name>`. My lean: (a) for v1 (one default), add (c) as a second-PR improvement.
6. **Dogfood plan.** When v1 ships, first ingest the cf² repo itself: all iteration-logs, reflections, decision-log history. Use it as the first quality check — does a dev-agent run on a fresh cf² feature see relevant snippets from prior iterations? That's the test.
7. **Memory pressure on iteration speed.** Ingesting 4–5 artifacts per iteration + running bge-small embeddings = non-trivial CPU for a few seconds per iteration. Should it be async (fire-and-forget after the iteration commit returns)? Yes — ingest doesn't block loop progression. Proposed: write to a background queue, process on idle or at next iteration boundary.

## 13. Changelog

- **2026-04-21**: Initial design draft. Picks embedded-SQLite + sqlite-vec + bundled ONNX embedder as the concrete path (Option B.1 from the research doc); maps Cerefox reuse by file; defines schema, API verbs, and packaging; proposes workspace-vs-Clio-project rename.
