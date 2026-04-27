# Clio (item 5.7) — test plan + implementation summary

> **Historical record (v0.9.0).** This doc captures the testing-and-acceptance shape for Clio's v0.9.0 ship (item 5.7). The implementation has evolved since: hybrid search switched from RRF to **alpha-weighted score blending** (item 5.12, 2026-04-27); search now returns one row per document by default; small-to-big retrieval is per-document (not per-chunk); the update-doc API + version snapshots + soft-delete + audit log shipped under items 5.11 + 5.13. References to "RRF k=60" below describe the original implementation; the current algorithm is documented in `docs/design/clio-memory-layer.md` §4.3 and the 2026-04-27 entries of `docs/decisions-log.md`.

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

### Post-review refinements (commit `4932e1a`, 2026-04-23)

- **`cfcf init` pick-equals-install (refined 2026-04-22).** Catalogue prompt accepts a numeric pick or `S`. If a model is picked, `cfcf init` now downloads + activates it inline via a local `LocalClio` (no server needed). Pick is saved to `clio.preferredEmbedder` *before* the install attempt, so a network failure doesn't lose the preference — user can retry with `cfcf clio embedder install` (no arg, resolves from saved preference).
- **Download progress bar** on stderr during the HF download: `[████░░░░░░] 45%  54.0/120.0 MB  model.onnx`. Throttled to ≥5% ticks per file (item 6.19).
- **Pre-download bandwidth hint + post-install auto-verification (item 6.19 remainder, 2026-04-22).** The loading line now carries a size + ETA (`~130 MB; est. 21s-1m at 50-10 Mbps` for the default nomic embedder). Install reads `clio_active_embedder` back and fails hard if it doesn't match the chosen entry; on success prints `✓ Clio ready: <name> (dim=N, chunk=N chars)`.
- **`--migrate-history` is workspace-scoped by default.** Filters by `metadata.workspace_id` so sibling workspaces' history stays put. New `--all-in-project` flag opts back into the wide sweep for Project-collapse scenarios.
- **`cfcf clio reindex [--project <name>] [--force] [--batch-size <n>]`**: re-embeds chunks under the currently-active embedder. Idempotent; batched; per-batch transactions.
- **`cfcf clio embedder set <name> --reindex`**: the canonical, safe embedder-switch flow. `--force` still available for recovery scenarios but with a visible degradation warning.



- **Embedder catalogue** (`embedders/catalogue.ts`): 4 built-in models (bge-small, MiniLM, nomic long-context, bge-base). Each entry pins `recommendedChunkMaxChars` + `recommendedExpansionRadius` so chunk size + small-to-big radius track the model.
- **ONNX embedder** via `@huggingface/transformers` (new dep). Lazy model download to `~/.cfcf/models/` on first `embed()` call. Progress line to stderr. Graceful fallback to FTS-only on load failure.
- **Active-embedder tracking** (migration 0002, `embedders/store.ts`): single-row `clio_active_embedder` table. `setActiveEmbedder` refuses to switch when embeddings from the old model exist (force flag paired with v2 reindex).
- **Hybrid search** in `LocalClio.search`: mode=`"fts"` (default), `"semantic"` (pure vector), `"hybrid"` (RRF fusion k=60 over FTS top-N + vector top-N). Brute-force cosine over candidate set (no sqlite-vec extension yet; design doc §4.1 says it's fine at our scale).
- **Small-to-big expansion**: each hit's `content` is expanded inline with its ±N siblings using the active embedder's recommended radius.
- **Embedder CLI**: `cfcf clio embedder {list,active,install,set}` (+ `--force` + `--json`). HTTP: `GET /api/clio/embedders`, `POST /api/clio/embedders/install`, `POST /api/clio/embedders/set`.
- **Build** (during the Clio iteration; superseded in v0.10.0): originally `bun build --compile` with `--external @huggingface/transformers --external onnxruntime-node --external sharp` so the native-binding packages didn't blow up the compiler. Binary stayed lean (~64 MB); transformers was installed via node_modules on the host. Item 5.5 (v0.10.0) replaced this with the npm-format `bun build` (no `--compile`); same external set carries over but the bundled JS now ships as `@cerefox/cfcf-cli`.

### Tests

| Package | Tests | Notes |
|---|---|---|
| `packages/core` (all) | **336 pass** | Of which 81 are new Clio tests. |
| `packages/server/src/routes/clio.test.ts` | **21 pass** | HTTP contract tests with isolated temp DB via `setClioBackend`. |
| `packages/cli` | 2 pass | Unchanged. |
| `packages/web` | 9 pass | Unchanged. |
| **Total** | **378 tests** | All green. |

New Clio tests by file:
- `packages/core/src/clio/db.test.ts` — 8 (schema + migrations).
- `packages/core/src/clio/chunking/markdown.test.ts` — 12 (chunker port).
- `packages/core/src/clio/backend/local-clio.test.ts` — 27 (FTS backend + workspace-scoped migrate).
- `packages/core/src/clio/backend/local-clio-hybrid.test.ts` — 9 (hybrid + semantic + small-to-big; uses deterministic MockEmbedder).
- `packages/core/src/clio/backend/local-clio-reindex.test.ts` — 7 (reindex scenarios: no-embedder / idempotent / backfill / model-switch / force / project-filter / unknown-project).
- `packages/core/src/clio/embedders/store.test.ts` — 6 (active-embedder store).
- `packages/core/src/clio/loop-ingest.test.ts` — 21 (auto-ingest hooks + clio-relevant generation).
- `packages/server/src/routes/clio.test.ts` — 22 (HTTP routes end-to-end; includes both workspace-scoped + all-in-project migrate flows).

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
bun run test                               # all 378 pass (see Tests section above)
bun run build                              # ~333ms compile, binary 64 MB
```

Clear Clio DB between runs when you want a clean slate:

```bash
rm -f ~/.cfcf/clio.db ~/.cfcf/clio.db-wal ~/.cfcf/clio.db-shm
```

### 1. Core: DB + migrations

```bash
cfcf server start
cfcf clio stats
# Expected: DB at ~/.cfcf/clio.db, 0 docs/chunks/projects, migrations=[0001_initial.sql, 0002_active_embedder.sql]
```

Corner cases:
- `CFCF_CLIO_DB=/tmp/foo.db cfcf clio stats` → creates /tmp/foo.db.
- Delete clio.db mid-run → next CLI call recreates on first read via `getClioBackend()` (server holds a stale handle, but `bun:sqlite` handles file removal gracefully on first lock attempt).

### 2. Projects (CRUD)

```bash
cfcf clio projects                          # empty
cfcf clio project create cf-ecosystem --description "cf² + Clio + Cerefox code"
cfcf clio projects                          # shows cf-ecosystem
cfcf clio project show cf-ecosystem
cfcf clio project create cf-ecosystem       # should fail with 409
cfcf clio project create CF-Ecosystem       # should fail (case-insensitive uniqueness)
```

### 3. Ingest + dedup + FTS search

```bash
# Small doc
echo "# Auth design\n\nUse real-time yields instead of fake-timers for auth flakes." > /tmp/auth.md
cfcf clio ingest /tmp/auth.md --project cf-ecosystem --title "Auth gotcha" --artifact-type design-guideline --tier semantic --tags auth

# Re-ingest same file: should say "Already in Clio (content_hash match)"
cfcf clio ingest /tmp/auth.md --project cf-ecosystem --title "Auth gotcha"

# Stdin ingest
cat /tmp/auth.md | cfcf clio ingest --stdin --project cf-ecosystem --title "Pipe ingest"

# Search
cfcf clio search "real-time yields"
cfcf clio search "flaky tests" --project cf-ecosystem
cfcf clio search "auth" --metadata '{"role":"design-guideline"}'       # should be 0 hits (wrong key)
cfcf clio search "auth" --metadata '{"artifact_type":"design-guideline"}'
cfcf clio search "!!! )( *" --project cf-ecosystem                     # operator chars stripped; no crash
cfcf clio search ""                                                     # rejected
cfcf clio search "xyz" --match-count 0                                  # clamped to 1
cfcf clio search "xyz" --match-count 9999                               # clamped to 100
```

### 4. Workspace ↔ Clio Project assignment

```bash
# Init workspace with --project flag
cfcf workspace init --repo /tmp/cfcf-calc --name calc-test --project cf-ecosystem
cfcf workspace show calc-test           # Clio Project: cf-ecosystem

# Init without flag in a TTY -- should pick interactively
cfcf workspace init --repo /tmp/cfcf-calc2 --name calc-test2
# Expected: prompt lists existing Projects + "N) create new" + "S) skip"

# Init with --no-prompt in a TTY -- should skip without asking
cfcf workspace init --repo /tmp/cfcf-calc3 --name calc-test3 --no-prompt
cfcf workspace show calc-test3          # Clio Project: (none -- auto-routes to 'default' on first ingest)

# Reassign without migrating history -- future ingests only
cfcf workspace set calc-test --project new-project-name
# Expected: "Historical documents remain under "cf-ecosystem". Pass --migrate-history ..."

# Reassign + migrate: WORKSPACE-SCOPED by default (only this workspace's docs move)
cfcf workspace set calc-test --project final-project --migrate-history
# Expected: prints "Re-keyed N historical document(s) (docs tagged to workspace <ws-id>)."
# Sibling workspaces in cf-ecosystem keep their docs there.

cfcf clio projects                      # confirm doc counts moved
```

**Corner cases for `--migrate-history`** (this is the most nuanced behavior):

```bash
# Seed two workspaces sharing one Clio Project, with docs from each:
cfcf workspace init --repo /tmp/cfcf-r1 --name sharedA --project shared-proj --no-prompt
cfcf workspace init --repo /tmp/cfcf-r2 --name sharedB --project shared-proj --no-prompt

# Ingest via each workspace (auto-tags metadata.workspace_id):
# (Easiest way to do this is run a brief iteration on each -- see section 7.)
# For a quick manual test, ingest directly via HTTP with a workspace_id:
WSA_ID=$(cfcf workspace show sharedA | grep "^  ID:" | awk '{print $2}')
WSB_ID=$(cfcf workspace show sharedB | grep "^  ID:" | awk '{print $2}')
curl -s -X POST http://localhost:7233/api/clio/ingest \
  -H "Content-Type: application/json" \
  -d "{\"project\":\"shared-proj\",\"title\":\"A1\",\"content\":\"# A1\\n\\ndoc from sharedA\",\"metadata\":{\"workspace_id\":\"$WSA_ID\"}}"
curl -s -X POST http://localhost:7233/api/clio/ingest \
  -H "Content-Type: application/json" \
  -d "{\"project\":\"shared-proj\",\"title\":\"A2\",\"content\":\"# A2\\n\\nsecond doc from sharedA\",\"metadata\":{\"workspace_id\":\"$WSA_ID\"}}"
curl -s -X POST http://localhost:7233/api/clio/ingest \
  -H "Content-Type: application/json" \
  -d "{\"project\":\"shared-proj\",\"title\":\"B1\",\"content\":\"# B1\\n\\ndoc from sharedB\",\"metadata\":{\"workspace_id\":\"$WSB_ID\"}}"

cfcf clio projects                      # shared-proj has 3 docs

# Workspace-scoped migrate: sharedA's 2 docs move, sharedB's 1 doc stays.
cfcf workspace set sharedA --project sharedA-only --migrate-history
cfcf clio projects                      # shared-proj: 1, sharedA-only: 2

# The wide-sweep flag: moves EVERY doc regardless of workspace. Only for
# collapsing Projects.
cfcf workspace set sharedB --project sharedA-only --migrate-history --all-in-project
cfcf clio projects                      # shared-proj: 0, sharedA-only: 3

# --all-in-project requires --migrate-history; the CLI should reject the
# combo otherwise:
cfcf workspace set sharedA --project foo --all-in-project
# Expected error: "--all-in-project has no effect without --migrate-history."
```

### 5. `cfcf init` (embedder prompt + Next Steps)

```bash
# Fresh install
rm -f ~/Library/Application\ Support/cfcf/config.json    # macOS
cfcf init
# Walk through the existing agent + permission prompts, then:
# At the "Clio memory layer" step, you should see:
#   - an explanation of FTS vs. hybrid/semantic modes,
#   - a list of 4 embedders with "★" next to nomic-embed-text-v1.5 (the new default),
#   - prompt: "Embedder choice (1-4 / S) [1]:"
```

Three flows to cover:
- **Pick the default (press Enter)**: init immediately downloads the model (~130 MB, q8-quantized variant) with a stderr progress bar; Next Steps shows "Clio ready: active embedder is nomic-embed-text-v1.5". `ls ~/.cfcf/models/` should show the cached model directory under `nomic-ai/nomic-embed-text-v1.5/`. `sqlite3 ~/.cfcf/clio.db "SELECT name FROM clio_active_embedder"` should return `nomic-embed-text-v1.5`.
- **Pick a specific embedder (e.g. "3")**: same download-during-init flow but for the chosen model. Verify via `cfcf clio embedder active`.
- **Skip (type "S")**: no download, no DB write to `clio_active_embedder`; Next Steps includes a "FTS-only mode" note with the install command.
- **Network-failure during install**: (simulate by disconnecting wifi before picking a non-default model) init should continue, print the captured install error in a final "Install error (captured -- you can retry)" line, and have written `clio.preferredEmbedder: <picked>` to the config. Then `cfcf clio embedder install` (no arg) should resume from the saved preference.

Re-running `cfcf init --force` should re-prompt (can change the pick). If the current active embedder matches the new pick, the install is a no-op.

### 6. Embedder install (real ONNX path)

Requires a real HuggingFace download on first run. Expect ~120 MB + ~30-60s on first install.

```bash
cfcf server start
cfcf clio embedder list                 # no active marker
cfcf clio embedder active               # "No active embedder."

cfcf clio embedder install bge-small-en-v1.5
# Expected stderr:
#   [clio] loading embedder "bge-small-en-v1.5" from HuggingFace (~120 MB; first-run only)…
#   [clio] embedder ready.
# Then stdout: "Active embedder: bge-small-en-v1.5 (dim=384, chunk=1800 chars)"

cfcf clio embedder active               # shows active record
cfcf clio embedder list                 # "●" next to bge-small-en-v1.5

ls -la ~/.cfcf/models/                           # transformers.js cache populated
```

Failure modes to exercise:
- **No network**: install should fail loudly with a clear error; subsequent searches fall back to FTS automatically.
- **Refuse switch with existing embeddings, no flag**: after ingesting something, `cfcf clio embedder set all-MiniLM-L6-v2` should refuse with a message pointing at `--reindex` or `--force`.
- **`--reindex` flow (canonical)**: `cfcf clio embedder set all-MiniLM-L6-v2 --reindex` should switch + re-embed everything atomically. Prints the reindex stats line.
- **`--force` (recovery only)**: `cfcf clio embedder set <x> --force` should succeed but print the "vector search degraded until you run cfcf clio reindex" warning. Running `cfcf clio reindex` afterwards should clean it up.
- **`--reindex` and `--force` together**: CLI should reject with "Pass either --reindex or --force, not both."

### 7. `cfcf clio reindex` (direct invocations)

```bash
# Happy path: idempotent when nothing has changed.
cfcf clio reindex
# Expected: "re-embedded: 0, skipped: <chunk-count>"

# Force re-embed everything (useful after model update within the same slug).
cfcf clio reindex --force

# Scope to one Clio Project.
cfcf clio reindex --project cf-ecosystem

# Unknown project -> zero stats, no error.
cfcf clio reindex --project this-project-does-not-exist

# No embedder installed -> clear error message pointing at install command.
cfcf clio embedder install bge-small-en-v1.5   # (undo a fresh DB)
# (cannot fully test "no embedder" without nuking the active-embedder row;
#  can inspect via `sqlite3 ~/.cfcf/clio.db "DELETE FROM clio_active_embedder"`)

# Batch size override (bigger = faster, more RAM).
cfcf clio reindex --force --batch-size 64

# JSON output for scripting.
cfcf clio reindex --json | jq .
```

### 8. Hybrid + semantic search (requires installed embedder)

```bash
# Seed a small corpus
for i in 1 2 3; do
  echo "# Doc $i\n\nAuth flows + token refresh strategies, iter $i notes." > /tmp/d$i.md
  cfcf clio ingest /tmp/d$i.md --project cf-ecosystem --title "Doc $i"
done
cfcf clio ingest /tmp/auth.md --project cf-ecosystem --title "Original"

# Search in all three modes. With no --mode and no clio.defaultSearchMode
# in the global config, the server resolves mode to "auto":
#   - active embedder present → hybrid (RRF over FTS + vector)
#   - no active embedder      → fts
cfcf clio search "token refresh"                # uses the configured default
cfcf clio search "token refresh" --mode fts
cfcf clio search "token refresh" --mode semantic
cfcf clio search "token refresh" --mode hybrid
cfcf clio search "token refresh" --mode hybrid --match-count 3 --json | jq .

# Hybrid should rank "Auth gotcha" (shares 'flaky' + 'yields' + 'auth') and the
# repeated Doc-i docs reasonably. Output ordering shouldn't change across runs
# for deterministic queries.
```

Verify `score` values in the JSON output are positive numbers (they are the RRF fused scores in hybrid mode, cosine in semantic, flipped BM25 in fts).

Check that hits include multiple chunks of context (small-to-big) — each hit's `content` should be larger than an individual chunk.

### 9. Loop integration — requires a running iteration loop

Easiest reproducer: run a single iteration against the calc example.

```bash
# Setup (if you haven't already)
cd /tmp/cfcf-calc && git init && git commit --allow-empty -m "initial" && cd -
cfcf workspace init --repo /tmp/cfcf-calc --name calc-clio --project cf-ecosystem

# Kick the loop (don't let it run forever -- stop after iteration 2)
cfcf run --workspace calc-clio
# In another terminal, after iteration 1 completes:
cfcf stop --workspace calc-clio
```

After the stop:
```bash
# Should have ingested (with default summaries-only policy):
# - architect-review.md (if pre-loop review ran under autoReviewSpecs)
# - reflection-analysis.md (if reflection ran)
# - Tagged decision-log entries
# - An iteration-summary doc
cfcf clio stats            # document + chunk counts increased
cfcf clio search "calc"    # should find things

# The agent cue card should be present in the workspace:
ls /tmp/cfcf-calc/cfcf-docs/clio-guide.md
ls /tmp/cfcf-calc/cfcf-docs/clio-relevant.md   # may be "no hits" on first iter
```

Corner cases:
- `workspace.clio.ingestPolicy = "off"`: no ingests should happen. Set via `PUT /api/workspaces/:id` (body: `{"clio": {"ingestPolicy": "off"}}`) and rerun.
- `workspace.clio.ingestPolicy = "all"`: iteration-log + handoff + judge-assessment all get ingested.
- Make the Clio backend fail mid-iteration (e.g. `chmod 000 ~/.cfcf/clio.db`): the iteration must complete successfully + logs should show `[clio] ... failed: ...` warnings but no error.

### 10. Web UI

The web UI wasn't modified as part of this feature — status tab should continue to show iteration / review / document / reflection history as before. There are no Clio-specific web surfaces in this PR (deferred: a "Clio" tab showing recent ingests + search box is a candidate follow-up).

### 11. Config surface round-trips

```bash
cfcf config show          # shows clio.ingestPolicy if set
cfcf config edit          # can edit it interactively
# Or via PUT /api/config body {"clio": {"ingestPolicy": "summaries-only"}}
```

### 12. Binary smoke (compiled)

```bash
bun run build
cfcf --version           # 0.8.0 (bumped to 0.9.0 when the PR merges)
cfcf clio --help          # every subcommand shows help
cfcf clio embedder --help
cfcf clio reindex --help
cfcf workspace set --help # exercises --migrate-history + --all-in-project help text
cfcf init --help
```

Consider running cfcf from a fresh directory (`cd /tmp && cfcf server start`) to confirm the no-repo code path still works with the new deps.

---

## Known limitations / deferred

All of these are tracked as concrete items in `docs/plan.md` (6.15-6.19).

- **sqlite-vec not integrated** (plan item 6.15). PR2 uses brute-force cosine in TS; fine at the design-doc's <100k chunk scale. Bun-on-macOS `loadExtension` quirk deferred to the installer work (5.5) — plan is for the installer to ship a pinned SQLite + sqlite-vec per-platform and wire it via `Database.setCustomSQLite()`.
- **Audit log not wired** (plan item 6.16). The `clio_audit_log` table exists (schema 0001) but nothing writes to it yet. Plan: port Cerefox's audit-log logic.
- **Soft-delete + versioning not wired** (plan item 6.17). Table shapes exist (`deleted_at`, `clio_document_versions`), no writes yet. Plan: port Cerefox's `update_document_content` / `soft_delete` / `restore` logic.
- **Web UI has no Clio surface** (plan item 6.18). No changes to the web UI in this feature.
- **`cfcf init` Clio onboarding polish** (plan item 6.19, now 🔄). Shipped on 2026-04-22: pick-equals-install inline download, stderr progress bar, `embedder install` without-arg resolves `clio.preferredEmbedder`. Still pending: bandwidth warning before download, post-install auto-verification, installer (5.5) pre-warm path.
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
12. `packages/cli/src/commands/clio.ts` — CLI surface (includes `reindex` + `embedder set --reindex`).
13. `packages/cli/src/commands/workspace.ts` — `--project` flag + interactive picker + `workspace set --migrate-history [--all-in-project]`.
14. `packages/cli/src/commands/init.ts` — `cfcf init` flow including the Clio embedder prompt step.
15. `packages/core/src/templates/clio-guide.md` — agent cue card.
16. `docs/guides/clio-quickstart.md` + `docs/guides/cli-usage.md` + `docs/api/server-api.md` — docs.
17. Tests: `packages/core/src/clio/**/*.test.ts` + `packages/server/src/routes/clio.test.ts`.
