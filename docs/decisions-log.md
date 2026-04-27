# cfcf Decisions Log

**Purpose:** Living record of every significant technical, architectural, and process decision made on the cfcf project. Consulted before making new decisions to avoid re-litigating settled questions. Updated every session.

**Format:** Reverse chronological. Each entry has:
- a date and short title,
- the **context** that prompted the decision,
- the **options considered** (where multiple were on the table),
- what was **decided**,
- the **outcome or lessons** (where applicable).

Entries describe *why we picked the path we did*, not *what shipped when* — the latter belongs in `CHANGELOG.md` and git history.

---

## 2026-04-27 — Clio CLI verbs: namespaced surface with a three-clause rule

**Context.** The Clio CLI accreted across three iterations (5.7 → 5.11 → 5.12 → 5.13) without revisiting the overall shape. Iter-5 dogfood produced repeated "where do I do X?" friction (rename a doc, move it between projects, edit metadata) — same root cause: doc operations were scattered between top-level (`get`, `delete`, `restore`, `versions`, `ingest`) and a `docs` namespace (`docs list`, `docs edit`). Plan item 5.8 promoted this to a normalisation pass before writing the user manual.

**Options considered.**

1. **Literal Cerefox CLI parity.** Audit of `../cerefox/src/cerefox/cli.py` showed Cerefox's CLI is internally inconsistent (`list-docs` plural vs `delete-doc` singular; `metadata-search` flips noun-verb ordering vs `list-docs`). Inheriting that mess would import the wrong shape.
2. **Both `search` and `ingest` under `docs`.** Maximally rule-bound. Forces `metadata search` / `metadata keys` into either `docs metadata search` (3-deep nesting) or `docs metadata-search` (hyphen rebirth). Rejected.
3. **Mode flag (`search --content` / `search --metadata`).** Collapses two operations with different ranking semantics (BM25/cosine vs `updated_at desc`) and parameter shapes (string vs JSON filter). Orphans `metadata keys` with no good home. Rejected.
4. **Both `search` + `ingest` top-level (no namespacing for either).** Returns to the pre-cleanup scattered state. Rejected.
5. **`search` top-level + `ingest` under `docs`** (with corresponding `metadata.search/keys`, `projects.list/create/show`, `embedder.list/active/install/set` namespaces). Selected.

**Decision.** Option 5 — namespaced surface with three-clause rule:

> 1. Collection-wide / Clio-wide / headline operations stay top-level (`search`, `audit`, `reindex`, `stats`).
> 2. Verbs that operate on a specific noun-instance go under that noun's namespace (`docs ingest/get/edit/delete/restore/versions`, `projects create/show`, `embedder install/set`).
> 3. A sub-concept with multiple operations of its own gets its own namespace (`metadata search/keys`).

Search and ingest sit on opposite sides of the rule because they play different roles: search produces a *ranking from the whole collection* (clause 1), ingest creates *a specific doc-instance* (clause 2). The asymmetry has a real reason. Option 5 is also the only shape where `metadata` reads as a clean sibling namespace next to `docs`/`projects`/`embedder` — the killed alternatives all force `metadata` into awkward nesting or hyphen-rebirth.

**No deprecation aliases.** Single user, pre-OSS-launch. Rename cleanly, no legacy verbs.

**Out of scope** (this round): top-level cfcf verbs (`workspace`, `run`, `review`, `reflect`, `document`, `server`, `config`, `init`, `doctor`, `self-update`, `status`, `resume`, `stop`). Iter 6 will audit those with the same lens.

**Why this matters for parity.** Cerefox parity is at the *abstraction layer* — every Cerefox MCP tool maps to a `MemoryBackend` method, and every cfcf CLI verb maps to a `MemoryBackend` method. The CLI surface itself can be cleaner than Cerefox's CLI without breaking that mapping. The user noted that cfcf's clean shape can serve as a reference for a future Cerefox CLI cleanup at the Cerefox-OSS level.

**Reference.** Full audit, killed-alternatives analysis, and locked surface in [`docs/research/cli-verb-normalisation.md`](research/cli-verb-normalisation.md).

---

## 2026-04-27 — Embedder-recommended chunk size as a safety ceiling, plus pre-flight warnings on switch + reindex

**Context.** Each embedder in the catalogue declares a `recommendedChunkMaxChars` calibrated for its tokenizer's `model_max_length` minus a safety margin (e.g. 1800 chars ≈ 4 chars/token × 0.9 × 512 tokens for a `bge-small-en-v1.5`-class context). Two related risks emerged once `clio.maxChunkChars` became user-configurable:

1. User sets `clio.maxChunkChars` larger than the active embedder's `recommendedChunkMaxChars`. Inputs above that ceiling get silently truncated by transformers.js / ORT to `model_max_length`, degrading embedding quality with no error path.
2. User runs `cfcf clio embedder set <new>` to switch to a model with a smaller ceiling. Existing chunks now exceed the new model's context window AND existing embeddings live in the old model's vector space.

**Decisions.**

1. **Treat `recommendedChunkMaxChars` as a ceiling, not a fixed override.** Smaller user values are honoured (smaller-is-safe; sometimes better for retrieval precision). Larger user values get capped at the embedder's ceiling with one stderr warning per ingest call. Without an active embedder there's no ceiling.
2. **Pre-flight warnings on `cfcf clio embedder set`.** New `GET /api/clio/embedders/:name/switch-impact` returns three counts: `embeddedChunkCount` (existing-embedding mismatch), `chunksOverNewCeiling` (truncation risk), `configMaxOverCeiling` (config setting will be capped). The CLI prompts y/N when any signal fires, requires `--yes` for non-interactive use. The existing `--force` (recovery, no checks) and `--reindex` (switch + re-embed atomically) remain.
3. **Pre-flight confirmation on `cfcf clio reindex`.** Reindex re-embeds many chunks under the active embedder; non-trivial cost. CLI prints active embedder + scope + cost hint, prompts y/N. `--yes` skips for non-interactive use; `--force` already skipped by historical contract.
4. **Web UI Server Info page surfaces all of these.** The new chunk-size input shows the cap warning inline when its value exceeds the active embedder's ceiling. The preferred-embedder line includes guidance on switching safely (`--reindex` recommended, `--force` for recovery only).

**Why warning-and-prompt instead of auto-correct.** Same principle as on-demand version retention (item 6.22): silent rewrites of corpus state surprise users in unattended-agent workflows. The user sees the impact and explicitly opts in.

**Out of scope (tracked).** The `--rechunk` capability (re-run the chunker per doc when switching to a model with a smaller ceiling) is plan item 6.23. Until then, the warning text recommends `cfcf clio reindex --rechunk` (planned).

---

## 2026-04-27 — Hybrid search algorithm: alpha-weighted score blending over RRF

**Context.** The Clio hybrid-search engine fuses an FTS (keyword) candidate set with a vector (semantic) candidate set into a single ranked list. The original implementation used Reciprocal Rank Fusion (RRF) with `k=60`; a side-by-side audit against Cerefox surfaced that Cerefox uses **alpha-weighted score blending** (`α × cosine + (1−α) × ts_rank_cd`, default `α=0.7`) and exposes `α` as a tunable per-call. cfcf had no equivalent knob.

**Options considered.**
1. Keep RRF, add a weight knob: `α/(k+vec_rank) + (1−α)/(k+fts_rank)` — same user-visible α, different math.
2. Switch to Cerefox-style score blending — same user-visible α and same underlying math.

**Decision.** Option 2: score blending. Tunable per-call (`alpha` query param / `--alpha` CLI flag) with `clio.hybridAlpha` global default of `0.7`. FTS-bypass-on-threshold semantics preserved (FTS-matched chunks always pass the `minScore` floor regardless of cosine).

**Implementation note — BM25 renormalisation.** SQLite FTS5's `bm25()` returns values in `[-∞, 0]` where more-negative = more relevant; not directly comparable to cosine `[0, 1]`. The fix is min-max normalisation within the candidate pool: `(maxRank − bm25) / (maxRank − minRank)` produces a `[0, 1]` higher-better score. Trade-off: absolute blended scores depend on candidate-pool composition (different filter combos can produce different absolute scores) but **relative ranking is preserved** — which is what hybrid cares about. Cerefox doesn't need this step because Postgres' `ts_rank_cd` is already roughly `[0, 1]`.

**Lesson.** Choose hybrid-fusion algorithm to match what the upstream system exposes — even when an alternative (RRF) is mathematically defensible, missing the user-visible knob is a real interop gap.

---

## 2026-04-27 — Search defaults to document-level, not chunk-level

**Context.** `cfcf clio search <query>` was returning chunk-level results (one row per matching chunk). Same document with multiple matching chunks produced multiple visually-redundant rows; an unrelated document that mentioned the keyword in passing wedged itself between chunks of the right document. Bad UX for the "what docs match X?" question agents and humans actually ask.

**Options considered.**
1. Keep chunk-level as default; add `--by-doc` flag for dedup.
2. Make doc-level the default; keep chunk-level as `--by-chunk` for raw inspection.

**Decision.** Option 2. Cerefox precedent: their primary `cerefox_search` MCP tool returns one row per matching document; the chunk-level engine `cerefox_hybrid_search` is internal-only.

**Implementation.** New `LocalClio.searchDocuments` fetches `matchCount × 5` chunk candidates via the existing engine, dedups by `document_id` keeping best score, decorates each hit with `versionCount` + `matchingChunks` + the best chunk's content. HTTP `GET /api/clio/search?by=doc` (default) / `?by=chunk` (raw).

**Why surface `versionCount` + `matchingChunks` on hits.** `versionCount` mirrors Cerefox's `cerefox_search_docs.version_count` — agents reasoning about doc maturity ("evolved" vs "fresh") avoid a follow-up `cfcf clio docs versions` call. `matchingChunks` is cfcf-specific — "matched 5 chunks" vs "matched 1 chunk" is a useful breadth signal, near-free given dedup already pools the candidates.

---

## 2026-04-27 — Small-to-big retrieval is per-document, not per-chunk

**Context.** The original Clio implementation expanded each search hit's content with a fixed-radius window of neighbour chunks (radius=1 if embedding dim>768, else 2). Cerefox's `cerefox_search_docs` makes a different per-document decision: documents whose `total_chars` is at most `p_small_to_big_threshold` (default 20000) return the **full document content** as the hit; larger documents return matched chunk + `p_context_window` (default 1) neighbours. Returns `is_partial: bool` so the caller knows which path was taken.

**Decision.** Adopt Cerefox's per-doc logic in the doc-level search path (`searchDocuments`). Configurable via `clio.smallDocThreshold` (default 20000) + `clio.contextWindow` (default 1) globally; per-call overrides via `?small_doc_threshold=` / `--small-doc-threshold` and `?context_window=` / `--context-window`. New result field `DocumentSearchHit.isPartial`.

**Outcome.** Small documents (typed-up notes, design briefs, cheat-sheets) come back in one piece — agents read them inline from the search hit instead of round-tripping to `cfcf clio docs get`. Large documents still return a focused window. Bypasses the chunk-level engine's expansion entirely (`contextWindow=0` actually means "bare chunk", not "chunk + hardcoded radius").

**Lesson.** Retrieval features land at the layer the caller experiences. Per-chunk tricks are right for the chunk-level engine but wrong for the doc-level surface; mirror the right layer's behaviour.

---

## 2026-04-27 — Migration runner: explicit `@migration-flags: disable-foreign-keys` marker

**Context.** SQLite migrations that drop+rebuild a parent table (the canonical "alter constraint" pattern: `CREATE new → INSERT FROM old → DROP old → RENAME new`) trigger `ON DELETE CASCADE` referential actions on child tables for every row in the parent — silently destroying child data. `PRAGMA defer_foreign_keys = ON` postpones FK constraint *checks* but does NOT defer referential *actions*; CASCADE fires immediately. The only working solution is `PRAGMA foreign_keys = OFF` set **outside** the wrapping transaction (the pragma is a no-op inside an active transaction).

**Decision.** The migration runner scans each migration's first 4 lines for a `-- @migration-flags: disable-foreign-keys` marker. When present, it brackets the migration's `BEGIN IMMEDIATE / COMMIT` with `PRAGMA foreign_keys = OFF / ON` outside the transaction. Migrations that drop+rebuild a parent with CASCADE children must declare the flag.

**Lesson.** Read the SQLite docs for pragma semantics carefully: `defer_foreign_keys` and `foreign_keys = OFF` solve different problems and are not interchangeable. Migration tests must run against a populated database, not a fresh one — `defer_foreign_keys` happens to "work" on an empty schema (no cascade target → no observable bug) but fails on real data.

---

## 2026-04-27 — Cerefox-parity gap: version retention deferred (on-demand cleanup over lazy)

**Context.** Cerefox runs lazy version retention on every snapshot: deletes versions older than `CEREFOX_VERSION_RETENTION_HOURS` (default 48), always keeps the most-recent version, skips `archived=true` versions. cfcf's `clio_document_versions` accumulate forever; the schema has the `archived` column but nothing reads it.

**Options considered.**
1. Match Cerefox: lazy auto-cleanup on every snapshot.
2. Explicit on-demand: `cfcf clio cleanup-versions [--older-than 168h] [--keep-last 1] [--dry-run]`.
3. Both: opt-in lazy via config + always-available on-demand.

**Decision.** Option 3, with on-demand as the default. Silent automatic deletion of historical content surprises users in an agent-driven workflow; the trust story for unattended runs is "nothing disappears unless I ask". Auto-cleanup is gated on `clio.versionRetentionHours` config so users who do want Cerefox's behaviour can opt in.

**Status.** Tracked as plan item 6.22; not implemented in iter-5. Default thresholds will match Cerefox's. Respects `archived=true`.

---

## 2026-04-26 — Clio data-model conventions

**Context.** Several small, related Clio schema choices baked into the implementation. Consolidated here so they're discoverable.

**Decisions.**

1. **`version_id IS NULL` = live; FTS triggers gate on it.** The `clio_chunks_fts_au` trigger fires on UPDATE with predicate `WHEN old.version_id IS NULL OR new.version_id IS NULL` — so the snapshot path's `UPDATE clio_chunks SET version_id = <new>` automatically removes prior chunks from the FTS index, and the subsequent INSERT of new chunks adds them back. Schema-level invariant; zero application code needed to keep search and versions in sync.

2. **`author` is a typed first-class column on `clio_documents`.** Cerefox keeps author only on the audit log. cfcf promotes it to a column because (a) search hits and listings render it inline without a JOIN, (b) future audit/retention queries filter heavily on author, (c) the storage cost is negligible vs. the query simplicity. Default `'agent'` so legacy records backfill cleanly.

3. **Version row's `source` carries the OUTGOING author, not the trigger label.** Cerefox's `cerefox_document_versions.source` stores the snapshot trigger (`"file"` / `"agent"` / etc.). cfcf's same column instead stores `target.author` at update time — i.e. who wrote the content being archived. Different read-model: `cfcf clio docs versions <id>` answers "who wrote v3?" with `versions[0].source` directly, no audit-log JOIN needed.

4. **Audit log is write-only.** The `clio_audit_log` schema (from initial schema) reserves `event_type` values for `'search'` and `'get'` but the live writer skips them. Reasons: (a) volume — every preload-context read in the iteration loop would write a row, dwarfing actual mutation entries; (b) the trust story is "who changed what", not "who saw what"; (c) Cerefox's `cerefox_audit_log` is also write-only in practice. The columns stay (no migration churn) so a future "verbose mode" could turn read-logging back on without schema work.

5. **Audit writes are best-effort, outside the mutation transaction.** A failure in `writeAudit` warns to stderr and returns; the mutation still succeeds. Wrapping audit + mutation in one transaction would mean a stuck audit could roll back successful ingests — wrong failure mode for an observability layer. Symmetric to Cerefox's `cerefox_create_audit_entry` (`PERFORM`-ed at the bottom of ingest RPCs, return value not checked). Idempotent no-op delete/restore (already-deleted / already-live) intentionally do NOT write audit rows.

6. **`IngestResult.action` enum is the source of truth; legacy `created` boolean kept one release.** With three outcomes (`"created"`, `"updated"`, `"skipped"`) a boolean stops carrying signal. `created` is preserved (`true` iff `action === "created"`) so existing callers keep working; the field is `@deprecated` and will be removed once dependent code (notably `iteration-loop`'s auto-ingest hooks) migrates. Same pattern as Cerefox's `IngestResult.action`.

7. **`--document-id` updates preserve title/author when not explicitly passed.** Cerefox always rewrites title/author from RPC parameters because their MCP layer requires them. cfcf's CLI ingests files where `title` defaults to the file basename — silently overwriting an existing doc's deliberately-named title was a footgun. Updates by ID now preserve the existing values when the caller omits them; explicit `--title` / `--author` still override. Documented divergence from Cerefox at the API layer.

---

## 2026-04-26 — Installer architecture: npm-format CLI, not self-contained binary

**Context.** Initial plan: ship cfcf as a `bun --compile` self-contained native binary in a tarball with colocated `node_modules/` for externalised heavy native deps (`@huggingface/transformers`, `onnxruntime-node`, `sharp`) plus pinned native libraries (custom-built libsqlite3 with `loadExtension` enabled, sqlite-vec). Curl-bash installs to `~/.cfcf/bin/`. Phase-0 smoke passed. Then the first real `cfcf init` against the binary failed with `Cannot find module '@huggingface/transformers' from '/$bunfs/root/cfcf'`.

**The wall: Bun `--compile` doesn't resolve heavy native deps from disk.**

`bun build --compile --external <pkg>` is supposed to produce a binary where `<pkg>` resolves at runtime via standard Node module resolution. In practice, Bun's compile-mode runtime resolver searches only the embedded `/$bunfs/root/` filesystem; it does not walk to disk for `--external` modules. Verified: `cfcf-binary` with deps colocated at `~/.cfcf/bin/node_modules/@huggingface/transformers/` — direct invocation errors `Cannot find module '@huggingface/transformers' from '/$bunfs/root/cfcf'`. Same with `NODE_PATH=...` set explicitly (Bun ignores it in compile mode).

**Workarounds attempted, none of which worked:**
1. Static absolute path in `import()` — Bun treats it as a bare specifier.
2. `file://` URL in `import()` — top-level loads, transitive imports re-enter the same broken resolver.
3. Static top-level `import * as Transformers from "@huggingface/transformers"` to force compiler analysis — Bun's compile-mode bundler quietly externalises packages with native `.node` addons or dynamic `require()` patterns regardless of the `--external` flag. Binary stays the same size; no transformers-related strings embedded.
4. `createRequire(process.execPath)` — transformers is ESM, `createRequire` is CJS-only.
5. Wrapper shell script that sets up env before exec — symptoms suggested env tweaks wouldn't help (the issue is internal to Bun's resolver path-walking).

**Why this isn't fixable in our codebase.** Bun's `--compile` is designed for the case "JS that I can fully bundle." Heavy native-addon deps with dynamic `require()` patterns (which `onnxruntime-node` does to load its `.node` binary based on `process.platform`/`arch`) sit outside that model. Hugging Face's own docs explicitly recommend `serverComponentsExternalPackages: ['onnxruntime-node']` for Next.js — their idiomatic stance is "don't bundle this, expect the runtime to resolve it." Tools that DO ship self-contained AI inference (Ollama, LM Studio) are written in Go/Rust with C++ inference engines linked directly; they don't use transformers.js. **No widely-used tool ships transformers.js inside a `bun --compile` / `pkg` / `nexe`-style binary.**

**Decision: pivot to npm-format distribution.**
- Build: `bun build` (without `--compile`) bundles the TypeScript source into a single `dist/cfcf.js`. `bun pm pack` wraps it + `package.json` into an npm-format `cfcf-X.Y.Z.tgz`.
- Distribution: GitHub Releases tarball asset (private repo) → `bun publish` to npmjs.com when the project goes public.
- User install: `bun install -g <tarball-URL>` (or `npm install -g <tarball-URL>`). A small `install.sh` wrapper provides curl-bash UX and bootstraps Bun if missing.
- Runtime: Bun ≥ 1.3 is a hard requirement (declared in `package.json`'s `engines.bun` and in the README).
- Native deps: per-platform optional npm packages (`@cerefox/cfcf-native-darwin-arm64`, etc.) declared in the CLI's `optionalDependencies`. npm picks the right one based on `os` + `cpu` fields. `applyCustomSqlite()` resolves the package path via `require.resolve`. Same pattern Claude Code, sharp, swc, and esbuild use.

**Lessons.**
- **Validate the gnarliest path first.** Smoke tests proved `cfcf --version` and `cfcf clio embedder list` worked from a compiled binary, but neither imports transformers. The actual transformers-loading path was not exercised until end-to-end install. **A real smoke must invoke at least one command that hits every external dep.**
- **Be skeptical of "just works at runtime" docs.** Bun's `--compile` docs state externals resolve at runtime "as normal." That's not what happens for our shape. Where docs are vague, run a focused test before committing to a design.
- **Match the upstream stack's distribution model.** transformers.js's docs, examples, and supported deployment targets all assume Node-ecosystem distribution. Trying to shoehorn it into a self-contained binary fights the entire ecosystem's design.
- **Self-contained binaries fit a specific shape.** Bun `--compile` / `pkg` / `nexe` / Deno `--compile` work great when deps are JS-only or have native deps that statically analyse. Heavy-native-addon deps with dynamic loading break this model. **Default to npm-format unless there's a strong reason for self-contained.**
- **Time-box workaround attempts.** When a design hits an unexpected wall, time-box the workarounds (one hour, two attempts) before stepping back to question the design itself.
- **Diagnostic signature.** `Cannot find module 'X' from '/$bunfs/root/...'` is a Bun-compile-mode-specific signature. If a future investigation surfaces it, jump straight to "is this resolver actually walking to disk?" rather than chasing path config.

---

## 2026-04-26 — `process.execPath` is the runtime, not the script, in npm-format installs

**Context.** A "re-spawn self with env var" pattern (used to host the cfcf server in the same binary as the CLI: `Bun.spawn([process.execPath], { env: { CFCF_INTERNAL_SERVE: "1" } })`) worked under the old `bun --compile` binary because `process.execPath` *was* the cfcf entry. Under the new npm-format install, `process.execPath` is the **bun runtime**; re-spawning bare bun with no script argument launches a Bun REPL. The server never starts.

**Decision.** Derive the bundled JS path from `import.meta.url` and spawn `bun run <bundle>` with the env var set. The bundled JS is the entry; bun runs it.

**Lesson.** Any "re-spawn self" pattern needs to know whether `process.execPath` is the entry or the runtime. They're the same thing for a `--compile` binary and different for everything else. Generalising: be explicit about which artifact you're invoking when re-spawning.

---

## 2026-04-25 — Hybrid search vector threshold (Cerefox parity + the wrapper-layer-invariants lesson)

**Context.** A single-document Clio corpus + an irrelevant query was returning that one document as a "match" — vector candidates with near-zero cosine were being fused into the result set rather than dropped. The fusion algorithm was correct; the missing piece was a noise-floor filter.

**Cerefox precedent.** Cerefox uses `CEREFOX_MIN_SEARCH_SCORE = 0.50` as a cosine-similarity floor on the vector branch:
- In hybrid search: chunks that matched the FTS keyword operator pass through regardless. The threshold filters only vector-only candidates.
- In semantic search: every result is filtered by cosine ≥ threshold.
- In FTS search: threshold ignored entirely.

The 0.50 default was calibrated for OpenAI `text-embedding-3-small`. Cerefox's published guidance:

| Score | Meaning (text-embedding-3-small) |
|-------|---|
| 0.0 – 0.20 | Noise floor — unrelated content |
| 0.20 – 0.45 | Weak / tangential — same domain, different topic |
| 0.45 – 0.70 | Genuine match — related concepts, paraphrases |
| 0.70 – 1.0  | Near-duplicate / direct answer |

**Decision.** Mirror the architecture exactly. Threshold sourced via cfcf's standard precedence chain: per-call (`--min-score` / `?min_score=`) → per-config (`clio.minSearchScore`) → built-in default 0.5. `searchSemantic` filters all candidates by raw cosine; `searchHybrid` filters only the vector-only branch (FTS-matched chunks always pass).

**Calibration caveat.** Cerefox's 0.50 was tuned for `text-embedding-3-small`. cfcf ships with `bge-small-en-v1.5` (Xenova, 384d) and the default `nomic-embed-text-v1.5` (q8, 768d). Different models produce different cosine distributions. The 0.5 default may need recalibration with empirical data from a non-trivial corpus. The user-tunable knob means recalibration doesn't have to ship in code — users dial `clio.minSearchScore` per their corpus. A future Clio v2 item should add per-embedder default thresholds to the catalogue.

**Lesson — port the wrapper-layer invariants too, not just the engine.** When porting from a system that's been used in anger, tightening rules added later (filters, retries, rate limits, validation guards) are usually load-bearing in ways that don't show up in algorithm diagrams. cfcf's PR2 ported Cerefox's SQL/RPC layer 1:1 — BM25, vector cosine, RRF fusion, small-to-big — but missed this threshold because it lives in Cerefox's Python `Searcher` wrapper, not in the RPC. **A literal port of the engine misses wrapper-layer invariants.**

---

## 2026-04-25 — Cerefox ↔ cfcf-Clio parity at the `MemoryBackend` boundary

**Context.** Cerefox is the OSS shared-agent-memory system; cfcf-Clio is the local-only embedded variant. The current architecture has `LocalClio` as the default `MemoryBackend` implementation; a future `CerefoxRemote` adapter should swap in for cross-machine sharing without caller-side changes.

**Decision (architectural commitment).** Maintain parity at the `MemoryBackend` boundary:
- **Search semantics** must match (mode names, threshold semantics, FTS-bypass rule, small-to-big behaviour, hybrid blending). New retrieval features land in both surfaces with the same shape — or are explicitly scoped as local-only with documented rationale.
- **Schema field names** must map 1:1 where possible (e.g. `clio_documents` ↔ `cerefox_documents`; `metadata` is JSONB on Cerefox / TEXT-JSON on Clio with the same well-known keys: `workspace_id`, `role`, `artifact_type`, `tier`).
- **Defaults must align unless intentionally different.** When deviations exist (e.g. cfcf's per-embedder `recommendedChunkMaxChars` overrides a flat global default), the deviation is a documented design choice, not drift.
- **Future Cerefox changes are evaluated for cfcf inclusion.** Currently mirrored or planned: audit log, soft-delete + versioning, metadata-key discovery, retention config.

**Trade-off.** Every Cerefox change becomes a "should we mirror this?" decision. The cost of letting them drift is high: every divergence becomes a behaviour surprise when a future user swaps in `CerefoxRemote`. **Document deviations explicitly in this log when they happen.**

---

## 2026-04-25 — Embedder version pin: `transformers@3.8.1` + `onnxruntime-node@1.21.0` for Intel Mac support

**Context.** `onnxruntime-node` 1.24.x dropped `darwin-x64` (Intel Mac) binaries. `@huggingface/transformers` 4.x pins ORT-node 1.24.x — meaning shipping transformers 4.x means dropping Intel Mac users.

**Options considered.**
1. Drop Intel Mac. Use the latest transformers + ORT-node.
2. Pin transformers + ORT-node to the last pair with darwin-x64 binaries.
3. WASM-via-`onnxruntime-web` (browser ORT-web) on Node. Avoids platform-specific native binaries entirely.

**Decision.** Option 2: pin `@huggingface/transformers@3.8.1` + `onnxruntime-node@1.21.0`. cfcf only uses the long-stable `pipeline("feature-extraction", ...)` API, so being a few minor versions behind has no functional impact today.

**Why not Option 3 (WASM).** Probed and deferred. `transformers.js` bundles the **browser** ORT-web build, which loads models via `fetch(URL)`; when Node passes it a local file path, it errors `ERR_INVALID_URL`. There's no built-in WASM-on-Node code path. Making it work requires either vendoring/forking transformers.js or rolling our own embedder using `onnxruntime-web/node` + a separate tokeniser (~1–2 weeks). Revisit if Microsoft permanently stays off `darwin-x64` AND staying behind on transformers becomes a real cost.

**Exit criteria for revisiting the pin.** The pin is a load-bearing-but-soft commitment, not permanent. Reconsider when *any* of these becomes true:
- A cfcf feature requires a transformers.js 4.x-only API.
- A security advisory lands against ORT-node 1.21.0 or transformers.js 3.8.1 with no patch backport.
- The Intel-Mac user population shrinks below the threshold where continued darwin-x64 testing pays for itself.
- Microsoft restores Intel-Mac binaries in a future ORT-node release (in which case we just bump versions).

If we drop Intel Mac later, the path is: bump transformers + ORT-node to current; drop `darwin-x64` from the installer's release matrix; document the change here. The graceful FTS-only fallback in `LocalClio.getEmbedder()` means existing Intel-Mac users wouldn't be hard-broken — they'd lose semantic search, with a clear on-screen explanation and the option to switch to the linux-x64 tarball under WSL / Docker / Lima.

---

## 2026-04-22 — Default embedder: `nomic-embed-text-v1.5` q8 over bge-small

**Context.** The Clio implementation initially defaulted to `bge-small-en-v1.5` (~120 MB, 384d, ~512 token context). Long design documents and iteration logs ended up split into many small chunks because the embedder's context window forced the chunker to slice aggressively.

**Decision.** Default to `nomic-embed-text-v1.5` (q8 quantised, ~130 MB, 768d, ~8k token context). Comfortably fits the chunker's 4k-token effective window so long docs embed as one coherent passage. `DEFAULT_EMBEDDER_NAME` in the catalogue is the single source of truth — `cfcf init`'s `★` marker, the no-arg `cfcf clio embedder install` fallback, the FTS-only "next steps" hint all read from it.

**Lessons (when adding a new embedder to the catalogue).**
- **Check upstream for ONNX dtype variants.** `nomic-ai/nomic-embed-text-v1.5` publishes both `model.onnx` (522 MB fp32) and `model_quantized.onnx` (~130 MB q8). Without an explicit hint, `transformers.pipeline()` picks fp32, ballooning the install. The catalogue's `dtype` field forces the right variant.
- **Mirrors can go restricted.** The `Xenova/nomic-embed-text-v1.5` mirror went 401-gated at some point; the official `nomic-ai/nomic-embed-text-v1.5` repo has the same ONNX layout and `transformers.js` loads it identically. Workaround when a future Xenova mirror also goes 401: find the upstream `<org>/<model>` repo on HF and verify it has the `onnx/` subdirectory + `config.json` + `tokenizer*.json`.

---

## 2026-04-12 — Async iteration: server runs in background, CLI polls

**Context.** First real agent run failed because `Bun.serve` has a max idleTimeout of 255 seconds and the CLI's `fetch()` has a 10-second default. Agent runs can take minutes or hours. The synchronous request/response model (CLI sends POST, server runs agent, returns result when done) fundamentally doesn't work for long-running operations.

**Decision.** Refactor to async. `POST /api/projects/:id/iterate` returns 202 immediately; the server runs the agent in the background via `iteration-runner.ts`. The CLI polls `GET /api/projects/:id/iterations/:n/status` every 2 seconds, showing real-time progress dots. SSE log streaming via `/iterations/:n/logs`. No timeout issues regardless of how long the agent runs.

---

## 2026-04-12 — Loop state persisted to disk on every phase transition

**Context.** In-memory loop state is lost on server restart. This includes `bun --watch` restarts (file changes during development), crashes, and manual restarts. Without persistence, `cfcf resume` fails after any restart with "No active loop for this workspace".

**Decision.** Persist `LoopState` to `<workspace-config-dir>/loop-state.json` on every phase transition. Load from disk as fallback in `getLoopState()`. The on-disk file is the source of truth; in-memory state is a cache.

---

## 2026-04-12 — Judge failure: capture exit code, log path, and retry-only-judge

**Context.** When a judge agent fails (wrong CLI flags, crash, etc.), the loop correctly pauses with `anomaly`, but the original implementation gave no clue about the cause — `anomaly` displayed alone with no log path, no exit code, no hint.

**Decision.** Capture `judgeError` with exit code and log path; show in CLI pause output. Set a `retryJudge` flag so `cfcf resume` retries only the judge on the same branch rather than starting a full new iteration (and discarding completed dev work).

**Principle.** For unattended runs, every failure path needs a self-explaining hint. Bare states like `anomaly` without context shift the diagnostic burden onto the user.

---

## 2026-04-12 — Iteration branch recovery: delete + recreate from HEAD

**Context.** When an iteration fails and the user retries, the iteration branch may already exist from the failed attempt but point to a different base (e.g., off `main` instead of the current feature branch). Naive `checkout` of the stale branch loses the working directory contents.

**Decision.** Delete the existing branch and recreate it off current HEAD. Validate the problem-pack BEFORE switching branches so failures surface before any branch manipulation.

---

## 2026-04-12 — Codex CLI: global flags must precede the subcommand

**Context.** The Codex adapter's first real judge run failed silently with exit code 2.

**Decision (adapter contract).** Codex CLI requires global flags (like `-a never`) BEFORE the subcommand (`exec`): `codex -a never exec -s danger-full-access "prompt"`. NOT `codex exec -s danger-full-access -a never "prompt"`. Recent Codex versions also removed `--approval-mode full-auto`; cfcf uses `-s danger-full-access` (equivalent to Claude Code's `--dangerously-skip-permissions`).

**Lesson.** Adapter integration tests must run the actual external CLI with the actual flag combinations. Reading docs is not enough — flag-ordering is the kind of thing only failing exit codes reveal.

---

## 2026-04-11 — Server stop via PID file, not shell job control

**Context.** `cfcf server start` spawns a background bun process. Shell job control (`kill %1`) is unreliable across shell contexts (different terminal, restart, etc.).

**Options considered.**
1. Store the PID in a file at startup; read at stop.
2. Scan for the process on the configured port via `lsof -ti :<port>`.

**Decision.** Option 1 (PID file). More robust; doesn't depend on platform-specific port-scanning tools.

---

## 2026-04-11 — `bun test --recursive` hangs with subprocess-spawning tests

**Context.** Process-manager tests that spawn + kill subprocesses (e.g., `sleep 30` with `kill()`) cause `bun test --recursive` to hang.

**Decision.** Run packages sequentially in CI and the root `package.json` test script: `bun test packages/core && bun test packages/server && bun test packages/cli`. Reliable. Confirmed Bun-version-specific issue with `--recursive` and concurrent subprocess management in tests.
