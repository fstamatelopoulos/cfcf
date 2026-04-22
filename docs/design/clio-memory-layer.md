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

**Resolution (landed in v0.8.0, plan item 5.10):** cf²'s `project` noun has been renamed to `workspace` across code + API + docs. Now:
- **cf² workspace** = one managed git repo.
- **Clio Project** = grouping of cf² workspaces that share a knowledge domain (matches Cerefox semantics exactly).

What shipped:
- `WorkspaceConfig` / `WorkspaceStatus` types (was `ProjectConfig` / `ProjectStatus`)
- `cfcf workspace *` CLI (was `cfcf project *`); `--workspace <name>` flag (was `--project`)
- `/api/workspaces/*` REST surface (was `/api/projects/*`); `workspaceId` / `workspaceName` on response bodies
- Web UI: "Workspaces" top-bar link + Workspace detail page; `#/workspaces/:id` hash route
- `<cfcf config dir>/workspaces/<id>/` on-disk config (was `<cfcf config dir>/projects/<id>/`) -- platform-specific dir: `~/Library/Application Support/cfcf/` on macOS, `~/.config/cfcf/` on Linux
- The `cfcf-docs/` internal file tree stays (`cfcf-docs/iteration-logs/`, etc.) — those names don't reference "project."

For the rest of this document, "workspace" refers to a single cf² repo and "Clio Project" refers to the grouping tier.

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

Metadata is JSON, queryable via SQLite's JSON1 `json_extract`. Clio is **agent-first** but not cf²-only: users and other agents will ingest arbitrary Markdown docs that widen the knowledge base — design guidelines, problem-domain knowledge, research notes, meeting memos, onboarding material, architectural decision records. The taxonomy is **extensible** — the set of known `artifact_type` values grows without a schema migration; Clio just stores the string.

**Standard keys:**

```json
{
  "workspace_id": "calc-5dbcfa",         // the cf² workspace (if applicable; null for workspace-less ingests)
  "workspace_name": "calc",
  "iteration": 5,                         // iteration-related artifacts only
  "role": "dev",                          // dev | judge | architect | reflection | documenter | user | agent | tool
  "author": "dev:claude-code:sonnet-4.5", // <role>:<adapter>[:<model>] for cf² artifacts;
                                          // "user" for CLI-ingested docs; free-form string otherwise
  "artifact_type": "iteration-log",       // extensible -- see table below
  "origin": "cfcf-auto",                  // cfcf-auto | user-cli | agent-tool | external-import
  "tier": "episodic",                     // "episodic" (raw trace) | "semantic" (curated / generalised)
  "tags": ["auth", "async-test"],         // optional free-form tags (array of strings)
  "reflection_health": "converging"       // reflection-analysis only; informs ranking boosts
}
```

**Known `artifact_type` values** (open-ended list; new values are accepted without schema changes):

| Value | Source | Written by | Tier default |
|---|---|---|---|
| `iteration-log` | cf² auto | dev | episodic |
| `iteration-handoff` | cf² auto | dev | episodic |
| `judge-assessment` | cf² auto | judge | episodic |
| `reflection-analysis` | cf² auto | reflection | semantic |
| `decision-log-entry` | cf² auto | dev/judge/architect/reflection/user | semantic (if category ∈ {lesson, strategy}) else episodic |
| `architect-review` | cf² auto | architect | semantic |
| `iteration-summary` | cf² auto | dev (post-iteration cfcf-generated summary) | semantic |
| `design-guideline` | user CLI / agent | user / agent | semantic |
| `domain-knowledge` | user CLI / agent | user / agent | semantic |
| `research-note` | user CLI / agent | user / agent | episodic |
| `adr` | user CLI / agent | user / agent | semantic |
| `onboarding` | user CLI / agent | user / agent | semantic |
| `meeting-notes` | user CLI / agent | user / agent | episodic |
| `reference` | user CLI / agent | user / agent | semantic |
| `note` | generic catch-all | any | caller's choice |
| `<anything else>` | caller | caller | caller's choice |

Clio treats the taxonomy as open — `cfcf clio ingest ... --artifact-type my-custom-type` works, and retrieval filters accept any string. The table above is convention, not enforcement. Specific `artifact_type` values get ranking boosts (see §11.5) and can be filtered on at query time.

**Indexed for query performance** (via JSON-extracted columns): `workspace_id`, `role`, `artifact_type`, `tier`, `origin`. Everything else stays JSON-queried. Free-text `tags` live in the JSON and are searchable via `json_each` joins when needed.

### 5.2 What gets written, when

**Default policy:** Clio ingests **summaries and important lessons/decisions, not every raw trace.** The episodic/per-iteration logs can be pulled on-demand from the git repo when someone wants the full detail; Clio's role is cross-project *transfer*, which is best served by curated signal, not by firehosing every iteration-log.

A knob: `clio.ingestPolicy` on `CfcfGlobalConfig` / `ProjectConfig` with values `"summaries-only"` (default) | `"all"` (raw + summaries, for heavy dogfooding or debugging) | `"off"` (no auto-ingest; Clio only holds what the user / agents explicitly push).

**Auto-ingest under `summaries-only` (default):**

| Trigger | What is ingested | Metadata highlights |
|---|---|---|
| End of REFLECT phase (post-commit) | `cfcf-docs/reflection-analysis.md` | role=reflection, artifact_type=reflection-analysis, tier=semantic |
| End of ARCHITECT review | `cfcf-docs/architect-review.md` | role=architect, artifact_type=architect-review, tier=semantic |
| Each `decision-log.md` append that is `[category: lesson]`, `[category: strategy]`, `[category: resolved-question]`, or `[category: risk]` | That entry only (parsed out of the tagged section) | role from the `[role: X]` tag; tier=semantic |
| End of iteration (post-judge, post-reflect) | `iteration-summary` -- a new cfcf-generated condensed doc combining dev's `## Summary` block from iteration-log + judge's determination/concerns + reflection's `key_observation`. Short. | role=cfcf, artifact_type=iteration-summary, tier=semantic |

**Auto-ingest under `all` (opt-in, for dogfooding / high-signal projects):** all of the above, plus:

| Trigger | What is ingested | Metadata highlights |
|---|---|---|
| End of DEV phase | `cfcf-docs/iteration-logs/iteration-N.md` | artifact_type=iteration-log, tier=episodic |
| End of DEV phase | `cfcf-docs/iteration-handoff.md` (the archived copy) | artifact_type=iteration-handoff, tier=episodic |
| End of JUDGE phase | `cfcf-docs/judge-assessment.md` | artifact_type=judge-assessment, tier=episodic |
| Every `decision-log.md` append (any category) | That entry | caller's category drives tier |

**User / agent ingest (always available, regardless of policy):**

| Source | How | Typical `artifact_type` |
|---|---|---|
| User-curated Markdown doc | `cfcf clio ingest path/to/note.md --project <clio-project> [--workspace <ws>] [--artifact-type <type>]` | design-guideline, domain-knowledge, research-note, adr, onboarding, reference, note, or any user-supplied string |
| Agent during its run (via bash) | `cfcf clio ingest --stdin --title "..." --project "..." --artifact-type <type>` | agent-chosen |
| External programmatic import | Direct HTTP `POST /api/clio/ingest` | any |

Content-hash dedup means re-running an iteration or re-ingesting an unchanged file won't double-store. Dedup scope: per-document, by sha256 of the full Markdown body (same as Cerefox).

### 5.3 What gets preloaded into the agent

At context-assembly time, the cf² harness runs two queries:
1. **Broad:** top-k semantic hits for the Problem Pack's `problem.md` across all Clio Projects. Surfaces generalised lessons.
2. **Narrow:** top-k hits filtered by `artifact_type IN ('reflection-analysis', 'architect-review')` scoped to the current Clio Project (if the workspace is mapped to one). Surfaces curated strategic notes from sibling workspaces.

Results (the small-to-big expanded passages, not raw chunks) land in a new file `cfcf-docs/clio-relevant.md` that the generated `CLAUDE.md` / `AGENTS.md` points at as a Tier-2 read. Fresh each iteration.

## 6. Embedder strategy

### 6.1 v1 default

**`bge-small-en-v1.5`** (BAAI). 384 dimensions, ~120 MB, strong retrieval quality for its size, permissive MIT licence, widely benchmarked. Runs via ONNX Runtime Node bindings in-process. Bundled into the cf² binary.

### 6.2 Alternatives (always installable via CLI; not bundled)

Users can install a heavier (or lighter) embedder at any time. Clio ships with the default above; other models are **downloaded on demand** to `~/.cfcf/models/` so the binary stays lean-ish and users pay the disk cost only for models they actually want.

| Model | Dim | Size | When useful |
|---|---|---|---|
| `all-MiniLM-L6-v2` | 384 | 23 MB | Low-resource installs; when you really want to be lean |
| `bge-small-en-v1.5` (default) | 384 | 120 MB | Balanced — recommended for v1 |
| `nomic-embed-text-v1.5` | 768 | 140 MB | Long-context (8k tokens) — useful when ingesting long design docs without chunking noise |
| `bge-base-en-v1.5` | 768 | 430 MB | Quality bump over the small variant |
| `mxbai-embed-large-v1` | 1024 | 670 MB | Top-quality open-weights option; users who explicitly want "as close to the best as local gets" |
| Ollama-hosted models (any) | varies | runs in Ollama | If the user already has Ollama, a thin `ollama://<model>` adapter can skip bundling entirely |

### 6.3 Embedder CLI

```bash
cfcf clio embedder list                      # bundled + installed + available catalogue
cfcf clio embedder install mxbai-embed-large-v1   # downloads to ~/.cfcf/models/, verifies checksum
cfcf clio embedder uninstall <name>          # removes the model files
cfcf clio embedder set <name>                # makes <name> the active default for new ingests
cfcf clio embedder active                    # prints the currently active model + dim
```

Verification: each installable model has a pinned URL + sha256 in a Clio manifest (`packages/core/src/clio/embedders/catalogue.ts`). Verified on download; refuses mismatch.

### 6.4 Per-Project embedder pinning + reindex

Embeddings are not cross-model compatible. Every chunk row records `embedder` + `embedding_dim`. When the user switches embedders mid-life:

1. **Mixed-model state** — existing chunks stay queryable only when the query is embedded with the same model. Mixing would poison relevance.
2. **`cfcf clio reindex --project <clio-project>`** — re-embeds all chunks under the active model. One-shot, offline. Uses Cerefox's `embedding_upgrade` schema pattern (second vector column populated during migration; atomic cutover when all chunks are re-done) so the corpus stays searchable throughout.
3. **`cfcf clio reindex --all`** — reindexes every project.

v1 ships with `install`, `list`, `active`, and `set` verbs. `reindex` and `uninstall` are v2.

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

# Ingest (mostly automated from cf² loops, plus manual/agent paths)
# Arbitrary Markdown docs -- design guidelines, domain knowledge, research
# notes, meeting memos, onboarding material, anything the user or an
# agent thinks is useful cross-project context.
cfcf clio ingest path/to/note.md --project cf-ecosystem --title "Deprecation note"
cfcf clio ingest path/to/guideline.md --project cf-ecosystem --title "API style" \
  --artifact-type design-guideline --tier semantic --tags api,style
cfcf clio ingest --stdin --project cf-ecosystem --title "Auth gotcha" \
  --artifact-type domain-knowledge --author "user" < notes.md

# Retrieve
cfcf clio get <document-id>
cfcf clio get <document-id> --raw    # just the content
cfcf clio get <document-id> --json   # with metadata

# Embedders (shipped with bge-small; user can install heavier models on demand)
cfcf clio embedder list              # bundled + installed + available
cfcf clio embedder install mxbai-embed-large-v1
cfcf clio embedder set nomic-embed-text-v1.5
cfcf clio embedder active

# Reindex (v2+): re-embed all chunks with the active embedder
cfcf clio reindex --project cf-ecosystem

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

## 11.5 Ranking + boosting (scratchpad, will become its own doc)

RRF over FTS5 + sqlite-vec gets us hybrid search out of the box. But raw RRF treats every document equally, which loses information — a `reflection-analysis` is strategically curated; an `iteration-log` is a raw trace; a `design-guideline` is authoritative; a `meeting-notes` is casual. Clio should rank these differently.

This section captures the scratchpad of ideas for later iteration. **Expected to grow into its own design doc** (`docs/design/clio-ranking.md`) once we have enough signal to choose between them. v1 ships the simplest defensible boost set; v2+ iterates.

### Ideas to consider

- **Artifact-type boost.** Curated types score higher than raw episodic traces. Rough ordering: `design-guideline`, `adr`, `architect-review`, `reflection-analysis` → boost; `iteration-summary`, `decision-log-entry (lesson/strategy)` → medium; `iteration-log`, `iteration-handoff`, `judge-assessment`, `meeting-notes`, `research-note` → baseline. Implementation: a small lookup of multiplicative boosts applied to RRF score.
- **Tier boost.** `tier=semantic` generally outranks `tier=episodic` for cross-project transfer queries. Not necessarily within same-workspace queries, where episodic recency matters.
- **Recency decay.** `score(d) *= exp(-age_days / τ)` with τ on the order of 90–180 days. Prevents ancient decisions from drowning current ones. Optional per-query override (`--no-decay` for archaeology).
- **Project-match boost.** Same Clio Project as the query's originating workspace → multiplier. Different Project, same organisation-level tag → smaller multiplier. No relation → baseline.
- **Workspace-match boost.** Same cf² workspace → strongest match weight (this is "within my own history"). Different workspace → baseline. Configurable whether same-workspace results are included at all (user might explicitly want cross-workspace only).
- **Heading-path match.** A chunk whose `heading_path` contains query-relevant terms gets a score bump (the passage is structurally about the query topic, not just mentions it).
- **Reflection health signal.** Reflection analyses with `iteration_health: converging` suggest generalisable success patterns; `stalled` / `diverging` suggest cautionary tales. Both useful, but possibly for different query classes. Open question — worth instrumenting once we have data.
- **User-pinned "important" flag.** Explicit opt-in curation: user runs `cfcf clio pin <doc-id>`, the document gets a strong boost. For the things the user *knows* matter.
- **Cross-encoder reranker.** After RRF + boosts produce top-N (say N=30), run them through a small cross-encoder model (e.g. `bge-reranker-base`, ~100 MB) to pick the final top-k. Published benchmarks show meaningful gains. Cost: a second model + ~200ms latency. Worth it for v2.
- **Per-role ranking flavours.** Dev query might benefit from code-example boosts; architect query from architectural-decision boosts; reflection query from cross-iteration pattern boosts. Implementation: pass `role=<caller>` at query time and switch between named boost profiles.
- **Workspace-scoped vs cross-project intent detection.** If the query mentions "last iteration" or "in this project", prefer same-workspace results. If it mentions "we've seen before" or "usually", prefer cross-workspace. Probably out of scope for v1; note for later.

### Open questions for the ranking doc

1. **Score normalisation.** RRF scores are tiny (≈ 1/60 to 2/60). Boosts as multiplicative or additive? Combined final score shape?
2. **Boost-combination formula.** Independent multipliers (product) vs weighted additive (sum with per-factor weights)? Product is sensitive to extreme values; additive is tunable but arbitrary.
3. **Expose boosts to the user?** As CLI flags (`--boost artifact-type reflection-analysis=2.0`) so users can tune per-query? Or internal-only with a default profile?
4. **Are boosts evaluated before or after small-to-big expansion?** The chunk that matched gets the boost — does the expanded passage inherit the same score, or does the document score come from the best-ranked chunk in it?
5. **How do we tune?** Without labelled evaluation data, boost values are guesses. Option: self-dogfood with a small eval set we curate by hand (query → which document we *expected* to rank top-1).
6. **When to rerank.** Top-30 → cross-encoder → top-5? Top-50 → top-10? Depends on latency budget and user's patience.
7. **Interaction with the ingest-policy knob.** Under `summaries-only`, episodic artifacts aren't in the index at all — so the tier boost is partially redundant. Under `all`, the episodic flood is real and tier boost matters most.

### v1 starting posture

Ship with a **minimal, documented boost profile**:

```ts
const V1_BOOSTS = {
  tier_semantic:    1.25,   // multiplicative
  type_reflection:  1.20,
  type_architect:   1.20,
  type_guideline:   1.30,
  type_adr:         1.30,
  type_iter_summary: 1.10,
  same_workspace:   1.20,
  same_project:     1.10,
  recency_tau_days: 120,    // exponential decay
};
```

Applied after RRF, before small-to-big. No cross-encoder in v1 (add v2). No user-tunable flags (add when we have something to tune against). Log the raw RRF score and the applied boost multipliers in the audit log so we can reason about why a result ranked where it did.

---

## 12. Open questions

### Resolved 2026-04-21

1. **Workspace rename** — **agreed.** Cf²'s `project` renames to `workspace`; Cerefox's `project` semantics (domain grouping) are preserved as **Clio Project**. Schedule as its own prerequisite breaking-change PR (plan item 5.10) that lands before Clio v1.
2. **Content-hash dedup granularity** — **per-artifact / per-file.** One ingested Markdown file = one `clio_documents` row, dedup'd by sha256 of the full body. Chunking inside that document uses the heading-aware strategy ported from Cerefox (`heading_path`, `heading_level`). Retrieval operates exactly as Cerefox does: hybrid match → chunk hits → small-to-big sibling expansion.
3. **Ingest cadence** — **summaries + important lessons/decisions, not everything** (default). See §5.2 — `clio.ingestPolicy="summaries-only"` is the default; `"all"` is an opt-in for dogfooding; `"off"` disables cf²-auto. User/agent ad-hoc ingestion is always available regardless.
4. **Ranking boosts** — moved into a dedicated section (§11.5) that will spin off as its own design doc once v1 ships and we have signal.
5. **Clio Project assignment** — **explicit at workspace-init time.** `cfcf workspace init` grows a `--project <name>` parameter, optional but **strongly suggested** (an interactive prompt nudges the user to set one, with a short explanation of what it's for). Empty is allowed for users who want to ingest into an unassigned "default" Project. See §12.1 for the open sub-question about changing the assignment post-init.
6. **Dogfooding** — **just ship it and observe.** Once v1 lands, kick off a fresh cf² workspace on a new problem and watch what the role-agents write to Clio during a loop. No upfront curated eval set; we learn from the real run. UI surface (see v2 scope) + audit log give the inspection needed. Expected eventual path: replicate most of Cerefox's logic in Clio as the two projects' needs converge.
7. **Ingest latency** — **keep it simple and synchronous in v1.** This is unattended-code-factory territory; if a role-agent run takes an extra 2-5 seconds for ingest that's invisible at the iteration scale. Revisit only if latency becomes unreasonable (many minutes per invocation). No background queue in v1.

### 12.1 Still open (for the next design-iteration session)

1. **Changing a workspace's Clio Project after init.** Three surfaces to consider:
   - CLI: `cfcf workspace set --project <new-name>` should obviously rewire future ingests.
   - **Historical chunks already written under the old Project**: do we (a) leave them as-is with the old `project_id` (audit-faithful, but the workspace's history is now split across two Clio Projects), (b) re-key them to the new Project (updates `project_id` on every existing chunk — preserves the "this workspace's history is here" intuition), or (c) offer both via a `--migrate-history` flag?
   - **Migration mechanics**: is re-keying a single SQL UPDATE on `clio_chunks.project_id` + `clio_documents.project_id`? (I think yes — the `project_id` is just a foreign key; the embeddings don't care.)
   - Strong lean: (c) — CLI defaults to non-migrating "new ingests only", explicit `--migrate-history` opt-in for the full rewrite. Audit log records the change either way.
2. **Taxonomy governance.** If `artifact_type` is open-ended, how do we prevent "iteration-log" and "iterationlog" and "IterationLog" from fragmenting the corpus? Options: (a) warn on unusual types during ingest with a "did you mean `<similar>`?" nudge, (b) maintain a canonical catalogue file users can grow, (c) just let it flow and teach the boost system to be tolerant. Start with (c); revisit if fragmentation actually happens.
3. **What does an empty Clio Project mean in practice?** A workspace with no Project assigned ingests to `project_id=null` or to a synthetic `"default"` Project? Lean toward a named `"default"` Project auto-created on first ingest — keeps the schema NOT NULL constraint, keeps queries uniform, lets users rename it later.
4. **Default `project` parameter during `cfcf workspace init` prompt wording.** Something like *"Which knowledge-sharing Project does this workspace belong to? Enter a name like 'cf-ecosystem' to share memory with related projects, or press Enter to use 'default'."* — to iterate on during implementation.

## 13. Changelog

- **2026-04-21**: Initial design draft. Picks embedded-SQLite + sqlite-vec + bundled ONNX embedder as the concrete path (Option B.1 from the research doc); maps Cerefox reuse by file; defines schema, API verbs, and packaging; proposes workspace-vs-Clio-project rename.
- **2026-04-21 (revision 2)**: Broadened `artifact_type` taxonomy (§5.1) to be open-ended — Clio welcomes user/agent-ingested design guidelines, domain knowledge, research notes, ADRs, onboarding material, etc. beyond just cf²'s own artifacts. `artifact_type` is stored as a freeform string; Clio accepts unknown values without schema changes. Added `origin` metadata key distinguishing `cfcf-auto` from `user-cli` / `agent-tool` / `external-import`. §5.2 rewritten around a `clio.ingestPolicy` knob — default `"summaries-only"` (reflection analyses, architect reviews, decision-log lessons/strategies, a new cfcf-generated `iteration-summary` per iteration) with opt-in `"all"` for raw-trace dogfooding and `"off"` for user-ingest-only mode. §6 embedder strategy flipped to an install-on-demand model — ships with bge-small-en-v1.5 bundled, heavier alternatives (nomic, bge-base, mxbai) installable via `cfcf clio embedder install`. New §11.5 "Ranking + boosting" captures v1 boost profile + brainstorm of future improvements; will spin off into its own doc (`docs/design/clio-ranking.md`) once v1 has run. §12 resolved six of seven original open questions (workspace rename ✅, dedup granularity ✅, ingest cadence ✅, ranking ✅ moved, dogfooding ✅, latency ✅) and added a new §12.1 with four still-open items — most importantly, the Clio-Project-reassignment migration story.
