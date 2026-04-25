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

### 2026-04-25 -- Clio embedders: model-source, version pinning, and platform support

**Findings during dogfooding the Clio embedder install path on Intel Mac (`darwin-x64`). Multiple non-obvious issues had to be resolved before init worked end-to-end. Capturing them here so the same investigations don't get repeated.**

**1. `Xenova/nomic-embed-text-v1.5` is gated (HTTP 401).** The Xenova mirror that we'd been listing in the catalogue went restricted at some point — it returns 401 Unauthorized on every config / model file. The other Xenova mirrors we use (`Xenova/bge-small-en-v1.5`, `Xenova/all-MiniLM-L6-v2`, `Xenova/bge-base-en-v1.5`) are still public; only nomic was affected. **Fix**: catalogue now points at the official upstream `nomic-ai/nomic-embed-text-v1.5`. Same ONNX file layout, `transformers.js` loads it identically. If a future Xenova mirror also goes 401, the established workaround is "find the upstream `<org>/<model>` repo on HF and verify it has the `onnx/` subdirectory + `config.json` + `tokenizer*.json`."

**2. `nomic-ai/nomic-embed-text-v1.5` defaults to the unquantized 522 MB model.** The Xenova mirror baked the quantized variant in as the default `model.onnx`; the official repo publishes both `model.onnx` (522 MB, fp32) and `model_quantized.onnx` (~130 MB, q8) and defaults to the bigger one. Without an explicit hint, `transformers.pipeline()` picks fp32, balloning the install. **Fix**: added a `dtype` field to `EmbedderEntry`; nomic gets `dtype: "q8"` to force the quantized variant. Other catalogue entries (Xenova mirrors) don't need it because their quantized model is the only one published. **Lesson**: when adding a new embedder to the catalogue, check both ONNX variants on the upstream repo and decide explicitly which to download via `dtype`.

**3. `onnxruntime-node` 1.24.x dropped Intel Mac support.** Microsoft stopped publishing `darwin-x64` binaries in npm tarballs starting 1.24.1 (Feb 2026). 1.23.2 (Nov 2025) was the last version with Intel Mac. `@huggingface/transformers` 4.x pins ORT-node 1.24.x — meaning shipping transformers 4.x means dropping Intel Mac users. **Decision**: pinned `@huggingface/transformers@3.8.1` (last 3.x; pins ORT-node 1.21.0, which has full platform coverage). Trade-off: a few minor versions behind latest transformers; cfcf only uses the long-stable `pipeline("feature-extraction", ...)` API so no functional impact. We'll re-evaluate the pin if a future cfcf feature requires 4.x specifically. **Investigation captured in [`docs/research/installer-design.md`](research/installer-design.md) §14a.**

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
