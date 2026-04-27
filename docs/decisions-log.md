# cfcf Decisions & Lessons Log

**Purpose:** This log captures important decisions and lessons learned that are NOT already documented in `plan.md`, `design/technical-design.md`, or other design docs, and that are not obvious from git history. It serves as a quick reference to avoid repeating failed experiments and to preserve rationale for non-obvious choices.

**What to add here:**
- Failed experiments and why they didn't work (so we don't repeat them)
- Non-obvious implementation decisions that future developers would question
- Surprising gotchas discovered during development
- Performance findings that influenced design choices

**What NOT to add here:**
- Architectural decisions (those go in `plan.md` decision log)
- Design rationale (those go in `design/technical-design.md` or `design/cfcf-requirements-vision.md`)
- Bug fixes (those are in git history)

**Format:** Newest entries at the top. Each entry has a date and a brief explanation.

---

## Log

### 2026-04-27 -- Migration 0003 nuked clio_chunks via DROP TABLE cascade (caught + fixed pre-merge)

**Symptom**: a user's `cfcf clio search "decisions"` returned 0 hits even though `cfcf clio docs list` showed two documents with non-zero `chunk_count`. Reproducer: load 0001 + 0002, ingest a chunk, run 0003 → `clio_chunks` empty + `clio_chunks_fts` corrupted with `SQLITE_CORRUPT_VTAB: database disk image is malformed`. Caught only because the user dogfood-tested the freshly-built branch; would have shipped to v0.11.0 otherwise.

**Cause**: 0003 rebuilds `clio_documents` via the canonical SQLite 12-step pattern (CREATE new → INSERT FROM old → DROP old → RENAME new). `DROP TABLE clio_documents` fires the `ON DELETE CASCADE` action on `clio_chunks.document_id` for every row in the parent table. The original 0003 used `PRAGMA defer_foreign_keys = ON` inside the migration's transaction expecting that to defer the cascade. **It does not.** Per SQLite docs, `defer_foreign_keys` only postpones FK constraint *checks* — referential *actions* (CASCADE / SET NULL / etc.) fire immediately as part of the parent row's deletion.

**Why the original test missed it**: my smoke test was `openClioDb('/tmp/<fresh>')` → all migrations apply against an empty schema with no chunks → no cascade target → "looks fine." The bug only surfaces when 0003 runs against a DB that already has chunks (which is exactly every existing user). Lesson: migration tests must run the migration against a populated DB, not a fresh one.

**Fix**: `PRAGMA foreign_keys = OFF` BEFORE the wrapping `BEGIN IMMEDIATE` (it's a no-op inside an active transaction; the migration runner had it inside, which silently ignored). Re-enable after `COMMIT`. The migration runner now scans the migration's first 4 lines for a `-- @migration-flags: disable-foreign-keys` marker and brackets the transaction with the pragma when present. 0003 carries the marker; future migrations that drop+rebuild a parent table need the same flag. Regression test in `db.test.ts` reproduces the exact failure path (0001+0002 with a chunk → run 0003 → assert chunk + FTS survive).

**User-side recovery**: chunks are unrecoverable from the corrupted DB; the doc rows survived (with stale `chunk_count` columns), but the actual chunk text + FTS index are gone. The fix is to wipe `~/.cfcf/clio.db` and re-ingest. Embedder model + active-embedder pick survive in the file system / config, but the documents need to come back from their original sources.

---

### 2026-04-26 -- Clio Cerefox parity (5.11/5.12/5.13): four design choices worth recording

Same branch (`iteration-5/clio-update-api`) ships 5.12 (agent-parity API surface) + 5.13 (audit log) + 5.11 follow-ups (soft-delete + restore mutation API) on top of 5.11 PR1's update + versioning. Four decisions baked into the implementation:

**1. `author` is a typed column on `clio_documents`, not a metadata key.** Migration `0004_author_column` adds `author TEXT NOT NULL DEFAULT 'agent'` + an index. Cerefox keeps author only on the audit log; we promoted it to a first-class column because (a) `cfcf clio search` callers want author rendered next to each hit without a JOIN, (b) future audit/retention queries filter heavily on author, (c) the migration is cheap and the storage cost is negligible vs the query simplicity. Default `'agent'` backfills cleanly for pre-5.12 records.

**2. Version row's `source` carries the OUTGOING author, not the trigger label.** Cerefox's `cerefox_document_versions.source` stores the snapshot's trigger label (`"file"` / `"paste"` / `"agent"` / `"manual"`). Our equivalent column instead stores **who wrote the content being archived** (`target.author` at update time). Rationale: `cfcf clio versions <doc-id>` answers "who wrote v3?" with `versions[0].source` directly; with Cerefox's interpretation, the same question requires a JOIN with the audit log. Different read-model optimisation; same column name.

**3. Reads aren't audit-logged.** The `clio_audit_log` placeholder schema (from 0001) had `event_type` enum entries for `'search'` and `'get'`. We dropped those from the live writer. Reasons: (a) volume — every preload-context read in the iteration loop would write a row, dwarfing actual mutation entries; (b) the trust story 5.13 is wired for is "who changed what", not "who saw what"; (c) Cerefox's `cerefox_audit_log` is also write-only in practice. The columns stay (no migration churn) so a future "verbose mode" could turn read-logging back on without schema work.

**4. Audit writes are best-effort + outside the mutation transaction.** A failure in `writeAudit` warns to stderr and returns; the underlying mutation still succeeds. Symmetric to Cerefox's `cerefox_create_audit_entry` which is `PERFORM`-ed (no return value checked) at the bottom of the ingest RPC. The alternative — wrap audit + mutation in one transaction — would mean a stuck audit could roll back successful ingests, which is the wrong failure mode for an observability layer. Idempotent no-op delete/restore (already-deleted / already-live) intentionally do NOT write audit rows; the user expectation is "did anything change?" → "no" → "no log entry".

**Out of 5.11/5.12/5.13, tracked elsewhere:**
- Retention auto-cleanup of old version rows + audit rows — small follow-up; pairs with the same write-paths.
- Nested-object metadata containment (filter on `metadata.tags[]` etc.) — Cerefox v1 doesn't support this either; future ask.
- Read-side audit (search/get logging) — see decision #3; doable when needed.

---

### 2026-04-26 -- Clio update-doc API (5.11): three design choices worth recording

PR1 of item 5.11 ships the `update_if_exists` + `document_id` ingest paths, version snapshots, and versioned content reads. Three decisions buried in the implementation that future readers should know about:

**1. Migration 0003 drops the UNIQUE constraint on `content_hash`.** PR1 of Clio (5.7) declared the column UNIQUE because the only ingest path was create + content-hash-dedup. The update API breaks that assumption: a legitimate update of doc A whose new content happens to match doc B's current hash would fire the UNIQUE constraint and reject the update. Hash collisions by content match are a real-world possibility (two agents converging on the same final state). Replacement: a non-unique index. The dedup-on-create lookup still benefits from the index but no longer rejects parallel docs with the same hash; when there's a hash collision, the dedup query returns one of them as the "skipped" target — benign. The migration uses the canonical 12-step SQLite table-rebuild pattern with `PRAGMA defer_foreign_keys = ON` (NOT `foreign_keys = OFF`, which is a no-op inside the migration runner's transaction); FK enforcement is postponed to COMMIT time, when the new table exists with the same name and `clio_chunks`'s FK resolves cleanly.

**2. `version_id IS NULL` = "live"; FTS triggers gate on it.** Mirrors Cerefox's convention. The `clio_chunks_fts_au` trigger fires on UPDATE with predicate `WHEN old.version_id IS NULL OR new.version_id IS NULL` — so the snapshot path's `UPDATE clio_chunks SET version_id = <new>` automatically removes the prior chunks from the FTS index (`old.version_id IS NULL` matches), and the subsequent INSERT of new chunks adds them back (the AI trigger fires for `new.version_id IS NULL`). One-line schema invariant; no application code needed to keep search and versions in sync.

**3. `IngestResult.action` is the new source of truth; `created` is kept for one release.** PR1 returned `{ created: boolean }`. With three outcomes (`"created"`, `"updated"`, `"skipped"`) a boolean stops carrying the signal. We added `action` as an enum alongside `created` (`true` iff `action === "created"`) so PR1 callers keep working without code changes; the legacy field is `@deprecated` in the JSDoc and slated for removal once dependent code (notably `iteration-loop`'s auto-ingest hooks) has migrated. Same pattern as Cerefox's `IngestResult.action` ("create" | "update-content" | "skipped").

**Out of scope for 5.11 PR1, tracked elsewhere:**
- Soft-delete mutation API (`DELETE` + `restore`) — table column already filtered on the read side; mutation API in a 5.11 follow-up.
- `author`/`requestor` field beyond storing it in the version row's `source` column — full write-attribution + read filtering moves to 5.12 with the rest of the agent-parity surface.
- Audit-log writes — 5.13.
- Retention cleanup of old version rows — also 5.13 (pairs with audit log; both touch the same write-path).

---

### 2026-04-26 -- v0.10.0 post-pivot dogfood findings (server-spawn, progress-bar, init cached-skip, CI artifact retention)

Same day as the pivot above. These are the four follow-on bugs surfaced by dogfood-installing the new npm-format build on Intel Mac. Captured here so future contributors know these are **install-shape gotchas**, not design flaws — they're the kind of thing that only shows up after a real install.

**1. `cfcf server start` failed silently under the npm-format install.** The CLI's spawn-self mechanism inherited from the `--compile` shape used `process.execPath` as the binary to re-spawn with `CFCF_INTERNAL_SERVE=1`. Under the npm-format install, `process.execPath` resolves to the bun runtime itself, not the cfcf entry — re-spawning bare `bun` with no script argument launches a Bun REPL, which never starts the server. The readiness poll timed out with the misleading "Failed to start cfcf server after 5s. Try running directly: bun run dev:server" message (which itself is dev-mode advice that doesn't apply to installed users). **Fix**: derive the bundled JS path from `import.meta.url` (server-spawn.ts is inlined into `dist/cfcf.js` by `bun build`) and spawn `bun run <bundle>` with `CFCF_INTERNAL_SERVE=1`. Lesson: any "re-spawn self" pattern needs to know whether `process.execPath` is the entry or the runtime — those are the same thing for a `--compile` binary but different for everything else.

**2. Embedder install progress bar glitched on re-runs.** Three pre-existing bugs in `OnnxEmbedder`'s `progress_callback` surfaced on the post-install dogfood:
   - Lines clobbered each other: `finalizeLine()` only emitted a newline when `activeFile === file`, so a "done" event for any other file appended its `✓` line directly onto the active progress bar's row. Fix: always finalize the in-place line before any append-only write.
   - `(? MB)` for cached files: files already on disk emit a single "done" event with no prior progress events; the renderer fell through to "?". Fix: prefer prior.loaded → info.total → "cached" so users see a meaningful size or an explicit "cached" marker.
   - Bogus `[streaming...] 0.0 MB` for tiny files: the indeterminate-mode heuristic latched on `total === loaded` from the first event, triggering for any tiny file that completed in one chunk. Fix: drop that clause; only mark indeterminate when total actually grows event-to-event.

**3. `cfcf init --force` re-ran the warmup-with-progress-bar dance even when the embedder was fully cached + active.** The user expected init to detect "model on disk + active in clio.db" and skip silently. Originally `installActiveEmbedder({ loadNow: true })` always called `warmup()` → transformers re-validated metadata files via network → the noisy progress bar ran for tiny config.json/tokenizer.json files. **Fix**: new `isEmbedderCached(entry)` helper (existence-only check on the dtype-aware ONNX weights file under `~/.cfcf/models/<hf-id>/`); init checks active-embedder DB row + cache presence before installing, and short-circuits with `✓ Clio ready: <name> (already cached and active; ...)` when both match. First-time installs and embedder switches still hit the full download + progress path. Lesson: when a workflow triggers a heavy operation, give it a fast path for the "already done" case — the user shouldn't have to wonder whether something is actually being downloaded.

**4. GitHub Actions artifact storage quota hit.** Old `--compile` binary builds (~22 MB darwin + ~38 MB linux per push) accumulated on a 90-day default retention. We'd added `retention-days: 7` earlier, but that only applies to NEW artifacts; the old ones stayed. ~104 artifacts ≈ 3 GB — 6× the free-tier 500 MB quota. **Fix**: bulk-delete via `gh api -X DELETE`. **Prevention**: the rewritten `ci.yml` on the npm-format branch produces a single ~250 KB CLI tarball per push (vs two 60 MB binaries before), so we'll stay comfortably under quota even without retention tweaks. Lesson: `retention-days` is forward-only; setting it doesn't reclaim old artifacts. Audit existing storage before assuming a quota issue is fixed.

---

### 2026-04-26 -- Installer (5.5): pivot from Bun-compiled binary to npm-format distribution

**Context.** Spent the day building 5.5 according to the original design: `bun --compile` produces a self-contained native binary; the installer ships a tarball with the binary + colocated `node_modules/` + custom SQLite + sqlite-vec; users curl-bash to install. Phase-0 smoke passed locally. We dogfood-installed on this Intel Mac. Then `cfcf init` failed with `Cannot find module '@huggingface/transformers' from '/$bunfs/root/cfcf'`. Spent several hours trying workarounds; none stuck. Pivoted at end of day to a standard npm-format CLI distribution, in line with how every other Node-ecosystem CLI ships (OpenClaw, Vercel, Yarn, Anthropic Claude Code originally).

This entry captures **what we tried**, **why each attempt failed**, **what we learned**, and **what we shipped instead**, so a future contributor (or future me) doesn't redo the investigation.

**Part 1 — The wall: Bun `--compile` doesn't resolve heavy native deps from disk.**

`bun build --compile --external <pkg>` is supposed to produce a binary where `<pkg>` resolves at runtime via standard Node module resolution. In practice, Bun's compile-mode runtime resolver searches only the embedded `/$bunfs/root/` filesystem; it doesn't walk to disk for `--external` modules. Verified via:

- `cfcf-binary` at `~/.cfcf/bin/cfcf` with deps colocated at `~/.cfcf/bin/node_modules/@huggingface/transformers/` (verified by `cfcf doctor`). Direct invocation: `Cannot find module '@huggingface/transformers' from '/$bunfs/root/cfcf'`.
- Same with `NODE_PATH=...` set explicitly. Bun ignores NODE_PATH in compile mode.
- Same with the binary invoked directly (not via the symlink) to rule out path-resolution quirks.

The "from `/$bunfs/root/cfcf`" path tells the story: Bun's resolver starts inside the compiled binary's virtual filesystem and never reaches the disk-side colocated `node_modules/`.

**Part 2 — Workarounds we tried, none of which worked.**

1. **Static absolute path in `import()`**: `await import("/Users/.../node_modules/@huggingface/transformers")`. Result: Bun's resolver treats the absolute path as a bare specifier, errors `Cannot find module '/Users/.../...'`.

2. **`file://` URL in `import()`**: `await import(pathToFileURL(absPath).href)`. Result: the entry-point JS file loads, BUT transformers' own internal imports (`import "onnxruntime-common"`, `import "onnxruntime-node"`) go through Bun's regular resolver again, which still doesn't walk to disk. So we can load transformers' top-level file but its first transitive dep import fails.

3. **Static top-level `import * as Transformers from "@huggingface/transformers"`**: forces Bun's compiler to statically analyse the import. Hope was Bun would bundle transformers + its dep tree into the binary. Result: it does NOT bundle. Binary stays the same size (~66 MB). Inspecting the binary with `strings ... | grep huggingface` shows only ~16 references — essentially nothing transformers-related embedded. Bun's compile-mode bundler quietly externalises packages with native `.node` addons or dynamic `require()` patterns regardless of the `--external` flag.

4. **`createRequire(process.execPath)` for CJS-anchored require**: didn't try in detail; transformers is ESM and `createRequire` is CJS-only.

5. **Wrapper shell script that sets up env before exec'ing the binary**: didn't try; the symptoms (Bun's resolver staying inside `bunfs`) suggested env tweaks wouldn't help. Confirmed retrospectively: the issue is internal to how Bun's compiled-binary resolver walks paths, not anything env can influence.

**Part 3 — Why this isn't fixable in our codebase.**

Bun's `--compile` is intentionally a single-executable model. Its resolver was designed for the case "JS that I can fully bundle." Heavy native-addon deps with dynamic `require()` patterns (which is exactly what `onnxruntime-node` does to load its `.node` binary based on `process.platform`/`arch`) sit outside that model. The community pattern for tools using transformers.js + ONNX Runtime is to ship as Node-ecosystem packages — not self-contained binaries — and Hugging Face's own docs explicitly recommend `serverComponentsExternalPackages: ['onnxruntime-node']` (= "don't bundle this, expect the runtime to resolve it") for Next.js. Tools that DO ship self-contained AI inference (Ollama, LM Studio) are written in Go/Rust with C++ inference engines linked directly — they don't use transformers.js. **No widely-used tool ships transformers.js inside a `bun --compile` / `pkg` / `nexe`-style binary.** We were trying something the upstream stack doesn't support.

**Part 4 — Pivot: npm-format distribution.**

Switched to the standard Node-ecosystem CLI shape:

- Build: `bun build` (without `--compile`) bundles cfcf's TS source into a single `dist/cfcf.js`. `bun pm pack` wraps it + `package.json` into an npm-format `cfcf-X.Y.Z.tgz`.
- Distribution: GitHub Releases tarball asset (private repo for now) → `bun publish @cerefox/cfcf-cli` to npmjs.com when cfcf opens up.
- User install: `bun install -g <tarball-URL>` (or `npm install -g <tarball-URL>` — same package format works with any npm-aware client). A small `install.sh` wrapper provides the curl-bash UX and bootstraps Bun if missing.
- Runtime: Bun ≥ 1.3. Hard requirement. Documented in `package.json`'s `engines.bun` and in README.
- Native deps (custom SQLite + sqlite-vec): per-platform optional npm packages (`@cerefox/cfcf-native-darwin-arm64`, etc.). Pattern Claude Code, sharp, swc, and esbuild all use. npm picks the right one based on `os` + `cpu` fields. `applyCustomSqlite()` resolves the package's path via `require.resolve`.

This adds back complexity in some places (per-platform native packages) but loses much more (no more `--compile` debugging, no more colocated-node_modules-can't-resolve, no more 140 MB tarballs). Net simplification.

**Part 5 — Lessons.**

- **Validate the gnarliest path first.** Our smoke tests proved `cfcf --version` and `cfcf clio embedder list` worked from a compiled binary, but neither imports transformers. We never exercised the actual transformers-loading path until dogfood. **A real smoke must invoke at least one command that hits every external dep.**
- **Be skeptical of "Bun handles this" docs.** Bun's `--compile` docs state externals resolve at runtime "as normal." That's not what happens for our shape. Where docs are vague, run a focused test before committing to a design.
- **Match the upstream stack's model.** transformers.js's docs, examples, and supported deployment targets all assume Node-ecosystem distribution. Trying to shoehorn it into a self-contained binary fights the entire ecosystem's design.
- **Self-contained binaries fit a specific shape.** Bun --compile / pkg / nexe / Deno --compile work great when your code's deps are JS-only, or have native deps that can be statically analysed and bundled. Heavy-native-addon deps with dynamic loading break this model. **Default to npm-format unless you have a strong reason for self-contained.**
- **The `Cannot find module 'X' from '/$bunfs/root/...'` error pattern is a Bun-compile-mode-specific signature.** If a future investigation surfaces it, jump straight to "is this resolver actually walking to disk?" rather than chasing path config.

**Cost of the day.** Significant. Several hours of build-test-debug cycles, a working tarball that doesn't actually run, and a 1600-line design doc that's now mostly obsolete. **Budget tightening for next time:** when a design hits an unexpected wall, time-box the workaround attempts (one hour, two attempts) before stepping back to question the design itself. We hit this in attempt #2 and didn't step back until attempt #5.

**Doc impact.** `docs/research/installer-design.md` rewritten from ~1600 lines to ~250. Plan item 5.5 description shortened correspondingly. New plan items 6.20 (web-UI version notification) + 6.21 (cfcf init reads existing config as defaults). The substantive 5.5 work — `cfcf doctor`, `cfcf self-update`, `applyCustomSqlite`, custom SQLite + sqlite-vec, the version-pin policy, the embedder install flow from 5.7 — all stays. Only the *distribution mechanism* changed.

### 2026-04-25 -- Hybrid search threshold (Cerefox port)

**Symptom that surfaced this:** with a single ingested document in Clio, every irrelevant query returned that one doc as a "match" with a tiny RRF score (`[0.016]` was the user's experience). Vector-only candidates with near-zero cosine were being fused into the result set instead of dropped, so an empty-corpus result set (the right answer) became a one-result noisy set.

**Part 1 — Cerefox precedent (the prior decision being mirrored).**

Cerefox uses `CEREFOX_MIN_SEARCH_SCORE = 0.50` as a cosine-similarity floor on the vector branch of search. Documented in `docs/guides/configuration.md` under *Retrieval*; the live behaviour:

- In **hybrid search**: chunks that matched the FTS keyword operator (`@@`) always pass through regardless of vector score. The threshold filters only vector-only candidates.
- In **semantic search**: every result is filtered by cosine ≥ threshold.
- In **FTS search**: threshold ignored entirely.

The 0.50 default was calibrated for OpenAI `text-embedding-3-small`. Cerefox's published guidance:

| Score | Meaning (text-embedding-3-small) |
|-------|---|
| 0.0 – 0.20 | Noise floor — unrelated content |
| 0.20 – 0.45 | Weak / tangential — same domain, different topic |
| 0.45 – 0.70 | Genuine match — related concepts, paraphrases |
| 0.70 – 1.0  | Near-duplicate / direct answer |

Recommended: 0.50 for general use, 0.40 for wider recall on small corpora, 0.70 for high precision. Disabling (0.0) is explicitly *not* recommended.

**Part 2 — cfcf Clio adaptation (what we actually shipped).**

Same architecture, with the threshold sourced via the standard cfcf precedence chain instead of a single env var:

1. **Per-call**: `--min-score` flag on `cfcf clio search` / `?min_score=` on `/api/clio/search`.
2. **Per-config**: `clio.minSearchScore` in the global config (editable via the web UI's "Clio memory layer" section).
3. **Default**: `0.5` (matching Cerefox's default; plugged in at the server route when neither call nor config sets it).

`SearchRequest.minScore` carries the resolved value into `LocalClio`. `searchSemantic` filters all candidates by raw cosine before slicing to `matchCount`. `searchHybrid` filters only the vector-only branch — FTS-matched chunks always pass the fusion step regardless of cosine, exactly mirroring the Cerefox behaviour.

**Calibration caveat (cfcf-specific):** Cerefox's 0.50 was tuned for `text-embedding-3-small`. cfcf ships with `bge-small-en-v1.5` (Xenova, 384d) and the new default `nomic-embed-text-v1.5` (q8, 768d). Different models produce different cosine-similarity distributions: bge-style models tend to score unrelated content somewhat higher than OpenAI's models do, and nomic's q8-quantized embeddings have their own profile. The 0.5 default may need recalibration once we have empirical data from a non-trivial corpus. The user-tunable knob means we don't have to wait for the recalibration to ship — users can dial `clio.minSearchScore` or pass `--min-score` per call. A future Clio v2 item should add per-embedder default thresholds to the catalogue.

**What this fixes for the user:** noise queries against a one-doc corpus now return zero hits in hybrid mode (the vector candidate gets dropped at the threshold; no FTS match to bypass it). Real queries that share keywords with the doc still hit via the FTS branch, immune to the threshold. Real semantically-close queries that don't share keywords still hit via the vector branch *if* their cosine clears the threshold.

**Part 3 — Why we missed this in the original PR2 port (retrospective).**

Four reasons, in order of weight, captured so future ports don't repeat the mistake:

1. **The threshold lives in Python, not SQL.** PR2 ported the SQL / RPC layer 1:1 — BM25 retrieval, vector cosine, RRF fusion, small-to-big expansion. The threshold is enforced in Cerefox's Python `Searcher` class that *wraps* the RPC call, not in the RPC itself. Copying "the hybrid algorithm" got the engine but missed the post-filter sitting in the wrapper.

2. **Tests used mocks, not realistic noise.** All 16 hybrid/semantic tests use `MockEmbedder` with deterministic token-hash vectors against a hand-curated corpus. There is no "irrelevant query against a small corpus" test — exactly the case that exposes a missing noise floor. One realistic test would have caught this on day one.

3. **Design-doc framing.** Both `docs/design/clio-memory-layer.md` and `docs/research/clio-implementation-decisions.md` emphasize the *fusion algorithm* (RRF k=60, small-to-big radius) as the noteworthy thing about hybrid search. The threshold appears only in Cerefox's `docs/guides/configuration.md` under *Retrieval* — a one-line config knob, easy to read as plumbing rather than algorithm.

4. **RRF's small scores hide the symptom.** RRF outputs look small to a human (best hit ≈ `1/61 ≈ 0.016`), so a stray `[0.016]` next to a noisy hit looks like a low-confidence result, not a bug. Without a threshold to *drop* noise candidates, every irrelevant query's nearest-cosine chunk got that same `0.016` and appeared as a legitimate hit. Only surfaced because the user had a one-document corpus.

**Lesson — port the wrapper-layer invariants too, not just the engine.** When porting from a system that's been used in anger, tightening rules added later (filters, retries, rate limits, validation guards) are usually load-bearing in ways that don't show up in algorithm diagrams. A literal port of the engine misses them.

**Commitment — maintain Cerefox ↔ cfcf-Clio parity at the `MemoryBackend` boundary.** Cerefox is the OSS shared-agent-memory system; cfcf-Clio is the local-only embedded variant. We want the two to remain interchangeable behind the existing `MemoryBackend` interface so a future `CerefoxRemote` adapter can swap in for `LocalClio` with no caller-side change. Concretely:

- **Search semantics** must match (mode names, threshold semantics, FTS-bypass rule, small-to-big expansion). New retrieval features land in both with the same surface — or are explicitly scoped as local-only with a documented rationale.
- **Schema field names** must map 1:1 where possible (e.g. `clio_documents` mirrors `cerefox_documents`; `metadata` is JSONB / TEXT-JSON in both with the same well-known keys: `workspace_id`, `role`, `artifact_type`, `tier`).
- **Defaults must align unless intentionally different**. The 0.5 threshold here is the right call (Cerefox parity); when we deviate (e.g. our chunker's per-embedder `recommendedChunkMaxChars` overrides Cerefox's flat 4000-char default), the deviation is a documented design choice, not drift.
- **Future Cerefox-side improvements should be evaluated for cfcf inclusion.** Items currently mirrored or planned to mirror: audit log (Cerefox `cerefox_log_usage` → Clio v2 6.16), soft-delete + versioning (Cerefox snapshot RPC → Clio v2 6.17), metadata-key discovery (Cerefox `list_metadata_keys` → not yet planned but should be), retention config (Cerefox `cerefox_requestor_enforcement_config` → Clio v2 6.17 retention).

This parity isn't free — every Cerefox change becomes a "should we mirror this?" decision. But the cost of letting them drift is high: when a future user wants to swap in `CerefoxRemote` for cross-machine sharing, every divergence is a behavior surprise. Document the deviations explicitly in this log when they happen.

### 2026-04-25 -- Clio embedders: model-source, version pinning, and platform support

**Findings during dogfooding the Clio embedder install path on Intel Mac (`darwin-x64`). Multiple non-obvious issues had to be resolved before init worked end-to-end. Capturing them here so the same investigations don't get repeated.**

**1. `Xenova/nomic-embed-text-v1.5` is gated (HTTP 401).** The Xenova mirror that we'd been listing in the catalogue went restricted at some point — it returns 401 Unauthorized on every config / model file. The other Xenova mirrors we use (`Xenova/bge-small-en-v1.5`, `Xenova/all-MiniLM-L6-v2`, `Xenova/bge-base-en-v1.5`) are still public; only nomic was affected. **Fix**: catalogue now points at the official upstream `nomic-ai/nomic-embed-text-v1.5`. Same ONNX file layout, `transformers.js` loads it identically. If a future Xenova mirror also goes 401, the established workaround is "find the upstream `<org>/<model>` repo on HF and verify it has the `onnx/` subdirectory + `config.json` + `tokenizer*.json`."

**2. `nomic-ai/nomic-embed-text-v1.5` defaults to the unquantized 522 MB model.** The Xenova mirror baked the quantized variant in as the default `model.onnx`; the official repo publishes both `model.onnx` (522 MB, fp32) and `model_quantized.onnx` (~130 MB, q8) and defaults to the bigger one. Without an explicit hint, `transformers.pipeline()` picks fp32, balloning the install. **Fix**: added a `dtype` field to `EmbedderEntry`; nomic gets `dtype: "q8"` to force the quantized variant. Other catalogue entries (Xenova mirrors) don't need it because their quantized model is the only one published. **Lesson**: when adding a new embedder to the catalogue, check both ONNX variants on the upstream repo and decide explicitly which to download via `dtype`.

**3. `onnxruntime-node` 1.24.x dropped Intel Mac support.** Microsoft stopped publishing `darwin-x64` binaries in npm tarballs starting 1.24.1 (Feb 2026). 1.23.2 (Nov 2025) was the last version with Intel Mac. `@huggingface/transformers` 4.x pins ORT-node 1.24.x — meaning shipping transformers 4.x means dropping Intel Mac users. **Decision**: pinned `@huggingface/transformers@3.8.1` (last 3.x; pins ORT-node 1.21.0, which has full platform coverage). Trade-off: a few minor versions behind latest transformers; cfcf only uses the long-stable `pipeline("feature-extraction", ...)` API so no functional impact today.

**Exit criteria — when we would drop `darwin-x64` (or revisit this pin):** the pin is a load-bearing-but-soft commitment, not permanent. We'll reconsider when *any* of the following becomes true:

- A cfcf feature requires a transformers.js 4.x-only API (e.g. a model architecture not supported by 3.8.1, or a new pipeline type we want to use).
- A security advisory lands against ORT-node 1.21.0 or transformers.js 3.8.1 with no patch backport.
- The Intel-Mac user population genuinely shrinks to "the original developer's daily-driver laptop" and continued darwin-x64 testing isn't paying for itself.
- Microsoft restores Intel-Mac binaries in a future ORT-node release (in which case we just bump versions).

If we do drop, the path is: bump transformers + ORT-node to current, drop `darwin-x64` from the installer's release matrix (`installer-design.md` §6.1), and document the change here + in `installer-design.md` §14a. The graceful-degradation FTS-only fallback already in `LocalClio.getEmbedder()` means existing Intel-Mac users wouldn't get hard-broken — they'd just lose semantic search, with a clear on-screen explanation and the option to switch to the linux-x64 tarball under WSL / Docker / Lima.

**Investigation captured in [`docs/research/installer-design.md`](research/installer-design.md) §14a.**

**4. WASM-via-`onnxruntime-web` (Option D) is not a quick fix.** Probed during the same investigation as a way to support whatever-platform-Microsoft-drops-next without version pinning. Result: `transformers.js` bundles the **browser** ORT-web build, which loads models via `fetch(URL)` — when Node passes it a local file path, it errors `ERR_INVALID_URL`. There's no built-in WASM-on-Node code path. Making it work would require either vendoring/forking transformers.js or rolling our own embedder using `onnxruntime-web/node` + a separate tokenizer (~1-2 weeks). **Decision**: deferred. If Microsoft permanently stays off `darwin-x64` AND staying behind on transformers becomes a real cost, revisit. Until then, the version pin (item 3) is the answer. **Investigation captured in `installer-design.md` §14b.**

**5. Platform support matrix as of 2026-04-25**: `darwin-arm64`, `darwin-x64`, `linux-x64`, `windows-x64` all run native ORT — same code path, no platform-conditional logic, no WASM fallback. Driven by the version pin (item 3). The 5.5 installer's release matrix targets all four; the pinned versions ensure all four legs produce equivalent tarballs.

**6. `embed()` is lazy; `loadNow: true` was a silent no-op.** `installActiveEmbedder({ loadNow: true })` originally only constructed the `OnnxEmbedder` shell; `OnnxEmbedder.ensurePipeline()` (the actual HF download trigger) was deferred to the first `embed()` call. So init's "✓ Clio ready" line printed without anything actually being downloaded — the model only landed on disk when the user later ran a search or ingest. **Fix**: added `Embedder.warmup()` (optional method); `OnnxEmbedder` implements it as `await this.ensurePipeline()`; `installActiveEmbedder` calls `warmup()` after constructing when `loadNow: true`. Now `cfcf init` truly downloads + activates + warms before returning.

**7. `bun --compile` does not resolve externals via `NODE_PATH`.** Bun's compiled binaries resolve `--external` packages from `/$bunfs/root/`, not from the on-disk binary's parent + `NODE_PATH`. This means the dev-mode workaround `NODE_PATH=... ./cfcf-binary` does NOT work; only `bun run dev:cli` does (because that's source-mode resolution, not compile-mode). **Implication for 5.5**: the installer must ship a colocated `node_modules/` next to the binary in the tarball — that's the only mechanism Bun's compile-mode resolver actually uses. Captured in `installer-design.md` §3.3.

### 2026-04-16 -- Web GUI iteration 4: known bugs and next steps

**Completed**: React + Vite web GUI with dashboard, project detail, phase indicator, log viewer, iteration history, judge assessment display, feedback form, loop controls. Served from Hono via serveStatic.

**Known bugs to fix in next session**:
1. **Live log streaming during loop runs**: The SSE log endpoint now tails log files for active iterations (file-based polling). Needs verification — the `--watch` server restart killed the test run before we could confirm it works.
2. **`--watch` mode kills active loops**: Server restart (from `--watch` detecting file changes) orphans agent processes and leaves loop state stuck. **Workaround**: Don't use `--watch` during active runs. **Fix needed**: Either detect orphaned loops on server start and clean up, or warn the user.
3. **Review button not prominent enough**: The "Review" (architect) button exists but is easy to miss as an outline button next to the solid "Start Loop". Consider: reorder buttons to show Review first for un-reviewed projects, or add a hint.
4. **Old config files crash server**: Fixed — config validation now backfills missing `architectAgent`/`documenterAgent`. But users who created projects before iteration 3 may hit the `formatAgent` crash in the CLI binary (needs rebuild).
5. **Stuck loop state after server restart**: Loop state persisted on disk says "judging" but no process is running. Need a mechanism to detect and recover from this on server startup.

**Remaining iteration 4 items** (not started):
- `cfcf log`, `cfcf push`, `cfcf prepare` CLI commands
- Cross-project knowledge
- Tier 3 Strategic Reflection
- Token/cost tracking
- Notification hooks
- Robust error handling / graceful shutdown
- Binary self-hosting

### 2026-04-12 -- Loop state must be persisted to disk

In-memory loop state is lost on server restart. This includes `bun --watch` restarts (triggered by file changes during development), crashes, and manual restarts. Without persistence, `cfcf resume` fails after any restart with "No active loop for this project". Fix: persist `LoopState` to `~/.cfcf/projects/<id>/loop-state.json` on every phase transition, load from disk as fallback in `getLoopState()`.

### 2026-04-12 -- Codex CLI flag ordering matters: global flags before subcommand

Codex CLI requires global flags (like `-a never`) BEFORE the subcommand (`exec`). The command must be `codex -a never exec -s danger-full-access "prompt"`, NOT `codex exec -s danger-full-access -a never "prompt"`. The old `--approval-mode full-auto` flag was also removed in recent Codex versions. We use `-s danger-full-access` (not `--full-auto`) to give the agent full filesystem and network access, equivalent to Claude Code's `--dangerously-skip-permissions`. Discovered during first real judge run -- the judge silently failed with exit code 2.

### 2026-04-12 -- Branch creation must handle stale branches from failed runs

When an iteration fails and the user retries, the iteration branch may already exist from the failed attempt but point to a different base (e.g., off `main` instead of the current feature branch). Checking out the stale branch loses the working directory contents. Fix: delete existing branch and recreate off current HEAD. Also: validate problem-pack BEFORE switching branches.

### 2026-04-12 -- Judge failure should not silently lose dev work

When the judge agent fails (wrong CLI flags, crash, etc.), the loop correctly pauses with "anomaly", but the original implementation gave no clue about the cause. The user saw bare "anomaly" with no log path, no exit code, no hint. Fix: capture `judgeError` with exit code and log path, show in CLI pause output. Also: set `retryJudge` flag so resume retries only the judge on the same branch rather than starting a new full iteration.

### 2026-04-12 -- HTTP request/response model doesn't work for long agent runs

First real agent run (Claude Code) failed because: (1) Bun.serve has a max idleTimeout of 255 seconds, (2) the CLI's fetch() timed out after 10s default. Agent runs can take minutes or hours. The synchronous request/response model (CLI sends POST, server runs agent, returns result when done) fundamentally doesn't work for long-running operations.

**Fix implemented:** Refactored to async pattern. `POST /api/projects/:id/iterate` now returns 202 immediately. The server runs the agent in the background via `iteration-runner.ts`. The CLI polls `GET /api/projects/:id/iterations/:n/status` every 2 seconds, showing real-time progress dots. SSE log streaming available via `/iterations/:n/logs`. No timeout issues regardless of how long the agent runs.

### 2026-04-11 -- bun test --recursive hangs with process-spawning tests

`bun test --recursive` hangs when test files include process manager tests that spawn + kill subprocesses (e.g., `sleep 30` with `kill()`). Running packages sequentially (`bun test packages/core && bun test packages/server && bun test packages/cli`) works reliably. Updated root `package.json` test script accordingly. Likely a Bun v1.3.12 bug with --recursive and concurrent subprocess management in tests.

### 2026-04-11 -- Server stop must use PID file or port scan

The `cfcf server start` spawns a background bun process. Shell job control (`kill %1`) is unreliable across shell contexts. For `cfcf server stop` to work reliably, we need either: (a) store the PID in a file at startup and read it at stop, or (b) scan for the process on the configured port via `lsof -ti :<port>`. Approach (a) is more robust. Will implement in iteration 1.

### 2026-04-11 -- Bun v1.3.12 confirmed on macOS

Bun installed via `curl -fsSL https://bun.sh/install | bash`. Version 1.3.12. Will need to verify Windows and Linux compatibility when cross-platform testing begins.
