# Clio (item 5.7) — test plan + implementation summary

Doc purpose: help the user do thorough manual + corner-case testing of the Clio implementation shipped on branch `iteration-5/clio`. Also serves as the brief outline of what landed.

**Branch**: `iteration-5/clio` (pushed; no PR open). Latest commit: whatever is on `origin/iteration-5/clio` HEAD when you read this.

---

## What landed

Three PRs shipped as one branch. Pipeline is end-to-end: Clio DB is created on demand, workspaces can be attached to Clio Projects, cf² auto-ingests curated artifacts at iteration boundaries, search works in three modes (FTS / hybrid / semantic), and agents see cross-workspace context preloaded into their instruction file.

### PR1 — Foundation (commits `d791f49` → `b9c0c2f` → `4993ea8` → `287f4a8` → `9982575` → `7acb936`)

- **Schema + migrations runner** (`packages/core/src/clio/db.ts`, `migrations/0001_initial.sql`)
  - SQLite + FTS5; tables: `clio_projects`, `clio_documents`, `clio_chunks`, `clio_chunks_fts`, `clio_document_versions`, `clio_audit_log` (last two are v2+ placeholders with their shapes landed now so no future migration is needed).
  - `bun:sqlite` driver (no extension loading needed in PR1 — FTS5 is built in).
  - Pragmas: WAL, FKs on, synchronous=NORMAL, busy_timeout=5s.
  - Migration runner wraps each migration in a transaction + rolls back on failure.
  - DB lives at `~/.cfcf/clio.db` (override via `CFCF_CLIO_DB`).
- **Markdown chunker** (`chunking/markdown.ts`): 1:1 TS port of `cerefox/src/cerefox/chunking/markdown.py`. Same chunk boundaries as Cerefox for the same input.
- **LocalClio backend** (`backend/local-clio.ts`, `backend/types.ts`): the default `MemoryBackend` impl. CRUD for projects + documents, FTS5 search with BM25 ranking, content_hash dedup across the whole DB, project + metadata filters.
- **HTTP surface** (`packages/server/src/routes/clio.ts`): `GET /api/clio/projects`, `POST /api/clio/projects`, `GET /api/clio/projects/:idOrName`, `POST /api/clio/ingest`, `GET /api/clio/search`, `GET /api/clio/documents/:id`, `GET /api/clio/stats`, `PUT /api/workspaces/:id/clio-project`.
- **CLI** (`packages/cli/src/commands/clio.ts`): `cfcf clio {search,ingest,get,projects,project create|show,stats}`. Top-level alias `cfcf memory`.
- **Workspace wiring** (`packages/cli/src/commands/workspace.ts`): `cfcf workspace init --project <clio-project>` + interactive Clio Project picker on TTY; `cfcf workspace set <name> --project <new> [--migrate-history]`. `WorkspaceConfig.clioProject` field persisted per workspace.
- **Global config**: `CfcfGlobalConfig.clio.ingestPolicy` default (summaries-only) + per-workspace override.

### PR3 — Loop integration (commit `fc88f51`)

- **Auto-ingest hooks** (`packages/core/src/clio/loop-ingest.ts`) called from `iteration-loop.ts`, all respecting `workspace.clio.ingestPolicy`:
  - After pre-loop architect commit → `ingestArchitectReview` (trigger=loop).
  - After reflection commit → `ingestReflectionAnalysis`.
  - At end of iteration (before DECIDE) → `ingestRawIterationArtifacts` (policy=all only), `ingestDecisionLogEntries` (summaries-only filters to semantic categories), `ingestIterationSummary` (cf²-built compact dev+judge+reflection summary).
  - Manual `cfcf review` → `ingestArchitectReview` (trigger=manual).
- **Context preload** (`writeClioRelevant`): generates `cfcf-docs/clio-relevant.md` each iteration. Broad cross-Project search + narrow same-Project search for reflection-analyses + architect-reviews. Attached to the generated `CLAUDE.md`/`AGENTS.md` Tier-2 reads.
- **Agent cue card** (`clio-guide.md` template): written fresh each iteration with the commands agents can run during a loop.
- **All ingest calls are try/catch-wrapped** so Clio failures never break a loop.

### PR2 — Embeddings + hybrid search (commit `83f1361`)

- **Embedder catalogue** (`embedders/catalogue.ts`): 4 built-in models (bge-small, MiniLM, nomic long-context, bge-base). Each entry pins `recommendedChunkMaxChars` + `recommendedExpansionRadius` so chunk size + small-to-big radius track the model.
- **ONNX embedder** via `@huggingface/transformers` (new dep). Lazy model download to `~/.cfcf/models/` on first `embed()` call. Progress line to stderr. Graceful fallback to FTS-only on load failure.
- **Active-embedder tracking** (migration 0002, `embedders/store.ts`): single-row `clio_active_embedder` table. `setActiveEmbedder` refuses to switch when embeddings from the old model exist (force flag paired with v2 reindex).
- **Hybrid search** in `LocalClio.search`: mode=`"fts"` (default), `"semantic"` (pure vector), `"hybrid"` (RRF fusion k=60 over FTS top-N + vector top-N). Brute-force cosine over candidate set (no sqlite-vec extension yet; design doc §4.1 says it's fine at our scale).
- **Small-to-big expansion**: each hit's `content` is expanded inline with its ±N siblings using the active embedder's recommended radius.
- **Embedder CLI**: `cfcf clio embedder {list,active,install,set}` (+ `--force` + `--json`). HTTP: `GET /api/clio/embedders`, `POST /api/clio/embedders/install`, `POST /api/clio/embedders/set`.
- **Build** (`package.json`): `bun build --compile` now passes `--external @huggingface/transformers --external onnxruntime-node --external sharp` so the native-binding packages don't blow up the compiler. Binary stays lean (~64 MB); transformers is installed via node_modules on the host.

### Tests

| Package | Tests | Notes |
|---|---|---|
| `packages/core` (all) | **336 pass** | Of which 81 are new Clio tests. |
| `packages/server/src/routes/clio.test.ts` | **21 pass** | HTTP contract tests with isolated temp DB via `setClioBackend`. |
| `packages/cli` | 2 pass | Unchanged. |
| `packages/web` | 9 pass | Unchanged. |
| **Total** | **368 tests** | All green. |

New Clio tests by file:
- `packages/core/src/clio/db.test.ts` — 8 (schema + migrations).
- `packages/core/src/clio/chunking/markdown.test.ts` — 12 (chunker port).
- `packages/core/src/clio/backend/local-clio.test.ts` — 25 (FTS backend).
- `packages/core/src/clio/backend/local-clio-hybrid.test.ts` — 9 (hybrid + semantic + small-to-big; uses deterministic MockEmbedder).
- `packages/core/src/clio/embedders/store.test.ts` — 6 (active-embedder store).
- `packages/core/src/clio/loop-ingest.test.ts` — 21 (auto-ingest hooks + clio-relevant generation).
- `packages/server/src/routes/clio.test.ts` — 21 (HTTP routes end-to-end).

**Manual ONNX embedder testing is required** — the automated tests use a deterministic MockEmbedder to exercise the hybrid pipeline without pulling a ~120 MB model on every `bun test`. The real embedder round-trip (HuggingFace download → Transformers.js session → embed → cosine similarity) is part of the test plan below.

---

## Test plan

Tackle in order. Each section has setup + happy path + corner cases.

### 0. Preflight

```bash
cd /Users/fotis/src/cfcf
git status                                 # clean, on iteration-5/clio
bun install                                # picks up @huggingface/transformers
bun run typecheck                          # clean
bun run test                               # all 368 pass (see Tests section above)
bun run build                              # ~395ms compile, binary 64 MB
```

Clear Clio DB between runs when you want a clean slate:

```bash
rm -f ~/.cfcf/clio.db ~/.cfcf/clio.db-wal ~/.cfcf/clio.db-shm
```

### 1. Core: DB + migrations

```bash
./cfcf-binary server start
./cfcf-binary clio stats
# Expected: DB at ~/.cfcf/clio.db, 0 docs/chunks/projects, migrations=[0001_initial.sql, 0002_active_embedder.sql]
```

Corner cases:
- `CFCF_CLIO_DB=/tmp/foo.db ./cfcf-binary clio stats` → creates /tmp/foo.db.
- Delete clio.db mid-run → next CLI call recreates on first read via `getClioBackend()` (server holds a stale handle, but `bun:sqlite` handles file removal gracefully on first lock attempt).

### 2. Projects (CRUD)

```bash
./cfcf-binary clio projects                          # empty
./cfcf-binary clio project create cf-ecosystem --description "cf² + Clio + Cerefox code"
./cfcf-binary clio projects                          # shows cf-ecosystem
./cfcf-binary clio project show cf-ecosystem
./cfcf-binary clio project create cf-ecosystem       # should fail with 409
./cfcf-binary clio project create CF-Ecosystem       # should fail (case-insensitive uniqueness)
```

### 3. Ingest + dedup + FTS search

```bash
# Small doc
echo "# Auth design\n\nUse real-time yields instead of fake-timers for auth flakes." > /tmp/auth.md
./cfcf-binary clio ingest /tmp/auth.md --project cf-ecosystem --title "Auth gotcha" --artifact-type design-guideline --tier semantic --tags auth

# Re-ingest same file: should say "Already in Clio (content_hash match)"
./cfcf-binary clio ingest /tmp/auth.md --project cf-ecosystem --title "Auth gotcha"

# Stdin ingest
cat /tmp/auth.md | ./cfcf-binary clio ingest --stdin --project cf-ecosystem --title "Pipe ingest"

# Search
./cfcf-binary clio search "real-time yields"
./cfcf-binary clio search "flaky tests" --project cf-ecosystem
./cfcf-binary clio search "auth" --metadata '{"role":"design-guideline"}'       # should be 0 hits (wrong key)
./cfcf-binary clio search "auth" --metadata '{"artifact_type":"design-guideline"}'
./cfcf-binary clio search "!!! )( *" --project cf-ecosystem                     # operator chars stripped; no crash
./cfcf-binary clio search ""                                                     # rejected
./cfcf-binary clio search "xyz" --match-count 0                                  # clamped to 1
./cfcf-binary clio search "xyz" --match-count 9999                               # clamped to 100
```

### 4. Workspace ↔ Clio Project assignment

```bash
# Init workspace with --project flag
./cfcf-binary workspace init --repo /tmp/cfcf-calc --name calc-test --project cf-ecosystem
./cfcf-binary workspace show calc-test           # Clio Project: cf-ecosystem

# Init without flag in a TTY -- should pick interactively
./cfcf-binary workspace init --repo /tmp/cfcf-calc2 --name calc-test2
# Expected: prompt lists existing Projects + "N) create new" + "S) skip"

# Init with --no-prompt in a TTY -- should skip without asking
./cfcf-binary workspace init --repo /tmp/cfcf-calc3 --name calc-test3 --no-prompt
./cfcf-binary workspace show calc-test3          # Clio Project: (none -- auto-routes to 'default' on first ingest)

# Reassign without migrating history
./cfcf-binary workspace set calc-test --project new-project-name
# Expected: future ingests go to new-project-name; old cf-ecosystem docs stay put.

# Reassign + migrate
./cfcf-binary workspace set calc-test --project final-project --migrate-history
# Expected: prints "Re-keyed N historical document(s) to the new Project."

./cfcf-binary clio projects                      # confirm doc counts moved
```

### 5. Embedder install (PR2 real ONNX path — untested in CI)

This is the part I couldn't fully verify in the session — it requires a real HuggingFace download. Expect ~120 MB + ~30-60s on first run.

```bash
./cfcf-binary clio embedder list                 # no active marker
./cfcf-binary clio embedder active               # "No active embedder."

./cfcf-binary clio embedder install bge-small-en-v1.5
# Expected stderr:
#   [clio] loading embedder "bge-small-en-v1.5" from HuggingFace (~120 MB; first-run only)…
#   [clio] embedder ready.
# Then stdout: "Active embedder: bge-small-en-v1.5 (dim=384, chunk=1800 chars)"

./cfcf-binary clio embedder active               # shows active record
./cfcf-binary clio embedder list                 # "●" next to bge-small-en-v1.5

ls -la ~/.cfcf/models/                           # transformers.js cache populated
```

Likely failure modes worth exercising:
- No network: install should fail loud + fall back to FTS-only.
- Install a second embedder while embeddings exist: `cfcf clio embedder set all-MiniLM-L6-v2` should refuse with a clear error pointing at `--force` or reindex.
- `--force`: should warn in the CLI help text and switch (will poison vector search until re-ingest).

### 6. Hybrid + semantic search (PR2, requires installed embedder)

```bash
# Seed a small corpus
for i in 1 2 3; do
  echo "# Doc $i\n\nAuth flows + token refresh strategies, iter $i notes." > /tmp/d$i.md
  ./cfcf-binary clio ingest /tmp/d$i.md --project cf-ecosystem --title "Doc $i"
done
./cfcf-binary clio ingest /tmp/auth.md --project cf-ecosystem --title "Original"

# Search in all three modes
./cfcf-binary clio search "token refresh" --mode fts
./cfcf-binary clio search "token refresh" --mode semantic
./cfcf-binary clio search "token refresh" --mode hybrid
./cfcf-binary clio search "token refresh" --mode hybrid --match-count 3 --json | jq .

# Hybrid should rank "Auth gotcha" (shares 'flaky' + 'yields' + 'auth') and the
# repeated Doc-i docs reasonably. Output ordering shouldn't change across runs
# for deterministic queries.
```

Verify `score` values in the JSON output are positive numbers (they are the RRF fused scores in hybrid mode, cosine in semantic, flipped BM25 in fts).

Check that hits include multiple chunks of context (small-to-big) — each hit's `content` should be larger than an individual chunk.

### 7. Loop integration (PR3) — requires a running iteration loop

Easiest reproducer: run a single iteration against the calc example.

```bash
# Setup (if you haven't already)
cd /tmp/cfcf-calc && git init && git commit --allow-empty -m "initial" && cd -
./cfcf-binary workspace init --repo /tmp/cfcf-calc --name calc-clio --project cf-ecosystem

# Kick the loop (don't let it run forever -- stop after iteration 2)
./cfcf-binary run --workspace calc-clio
# In another terminal, after iteration 1 completes:
./cfcf-binary stop --workspace calc-clio
```

After the stop:
```bash
# Should have ingested (with default summaries-only policy):
# - architect-review.md (if pre-loop review ran under autoReviewSpecs)
# - reflection-analysis.md (if reflection ran)
# - Tagged decision-log entries
# - An iteration-summary doc
./cfcf-binary clio stats            # document + chunk counts increased
./cfcf-binary clio search "calc"    # should find things

# The agent cue card should be present in the workspace:
ls /tmp/cfcf-calc/cfcf-docs/clio-guide.md
ls /tmp/cfcf-calc/cfcf-docs/clio-relevant.md   # may be "no hits" on first iter
```

Corner cases:
- `workspace.clio.ingestPolicy = "off"`: no ingests should happen. Set via `PUT /api/workspaces/:id` (body: `{"clio": {"ingestPolicy": "off"}}`) and rerun.
- `workspace.clio.ingestPolicy = "all"`: iteration-log + handoff + judge-assessment all get ingested.
- Make the Clio backend fail mid-iteration (e.g. `chmod 000 ~/.cfcf/clio.db`): the iteration must complete successfully + logs should show `[clio] ... failed: ...` warnings but no error.

### 8. Web UI

The web UI wasn't modified as part of this feature — status tab should continue to show iteration / review / document / reflection history as before. There are no Clio-specific web surfaces in this PR (deferred: a "Clio" tab showing recent ingests + search box is a candidate follow-up).

### 9. Config surface round-trips

```bash
./cfcf-binary config show          # shows clio.ingestPolicy if set
./cfcf-binary config edit          # can edit it interactively
# Or via PUT /api/config body {"clio": {"ingestPolicy": "summaries-only"}}
```

### 10. Binary smoke (compiled)

```bash
bun run build
./cfcf-binary --version           # 0.8.0 (bumped to 0.9.0 when the PR merges)
./cfcf-binary clio --help          # every subcommand shows help
./cfcf-binary clio embedder --help
./cfcf-binary workspace set --help
```

Consider running the binary from a fresh directory (`cd /tmp && /path/to/cfcf-binary server start`) to confirm the no-repo code path still works with the new deps.

---

## Known limitations / deferred

- **sqlite-vec not integrated.** PR2 uses brute-force cosine in TS, which is fine at the design-doc's <100k chunk scale. sqlite-vec (HNSW) is a future optimisation. The Bun-on-macOS `loadExtension` quirk blocks dropping in sqlite-vec as a loadable extension; addressed via `Database.setCustomSQLite()` or `better-sqlite3` when we get there.
- **`cfcf clio reindex` not shipped.** The `--force` flag on `embedder set` is a placeholder for the v2 reindex flow.
- **Audit log not wired.** The `clio_audit_log` table exists (schema 0001) but nothing writes to it yet. v2.
- **Soft-delete + versioning not wired.** Same: table shapes exist, but `deleted_at` + `clio_document_versions` are unused. v2.
- **Web UI has no Clio surface.** Planned follow-up.
- **Manual ONNX e2e not in CI.** Validated with MockEmbedder + manual testing against HuggingFace model download.

---

## Release

Bump to `v0.9.0` when the PR merges. Current branch is still at `0.8.0`; the version bump will happen with the merge commit.

---

## Files of interest (for code review)

Sorted roughly by reading order:

1. `docs/research/clio-implementation-decisions.md` — pre-code design decisions.
2. `packages/core/src/clio/migrations/0001_initial.sql` + `0002_active_embedder.sql` — schema.
3. `packages/core/src/clio/db.ts` — migrations runner.
4. `packages/core/src/clio/chunking/markdown.ts` — Cerefox port.
5. `packages/core/src/clio/types.ts` — public types.
6. `packages/core/src/clio/backend/local-clio.ts` — the bulk of the implementation.
7. `packages/core/src/clio/embedders/catalogue.ts` + `store.ts` + `onnx-embedder.ts` + `types.ts`.
8. `packages/core/src/clio/loop-ingest.ts` — auto-ingest hooks.
9. `packages/core/src/iteration-loop.ts` — wiring points (search for "Clio" comments).
10. `packages/core/src/context-assembler.ts` — Tier-2 read list update.
11. `packages/server/src/routes/clio.ts` — HTTP surface.
12. `packages/cli/src/commands/clio.ts` — CLI surface.
13. `packages/cli/src/commands/workspace.ts` — `--project` flag + interactive picker + `workspace set`.
14. `packages/core/src/templates/clio-guide.md` — agent cue card.
15. `docs/guides/clio-quickstart.md` + `docs/guides/cli-usage.md` + `docs/api/server-api.md` — docs.
16. Tests: `packages/core/src/clio/**/*.test.ts` + `packages/server/src/routes/clio.test.ts`.
