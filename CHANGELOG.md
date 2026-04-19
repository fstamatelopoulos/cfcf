# Changelog

All notable changes to cfcf (cf²) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Changes are tracked via git tags. Each release tag corresponds to an entry here.

## [Unreleased]

## [0.7.4] -- 2026-04-20

Ships plan item **6.14** (pulled forward from iteration 6 since 5.9 set the editor pattern and the two pages share structure): the read-only `Config` tab on the project detail page becomes a full editable form, wire-compatible with the CLI-hit `PUT /api/projects/:id`.

### Added
- **Editable per-project config tab in the web UI.** Identity + runtime fields (id, name, repo path, status, iterations completed, process template) render read-only at the top; below that, five editable sections: Remote URL / Agent roles (5) / Iteration defaults (maxIterations, pauseEvery, reflectSafeguardAfter, onStalled, mergeStrategy) / Behaviour flags (autoReviewSpecs / autoDocumenter / readinessGate / cleanupMergedBranches) / Notifications override with an explicit "inherit global" toggle. Save / Cancel buttons track a dirty flag; success message appears briefly after save; errors surface inline.
- **`saveProject()`** helper in `packages/web/src/api.ts`.
- **Validation + identity-preservation on `PUT /api/projects/:id`.** The endpoint now validates bounded numeric fields (`maxIterations >= 1`, `pauseEvery >= 0`, `reflectSafeguardAfter >= 1`), enums (`onStalled`, `mergeStrategy`, `readinessGate`), and agent role objects (`adapter` required when setting an agent role). Identity + runtime fields (`id`, `name`, `repoPath`, `currentIteration`, `status`, `processTemplate`) are stripped from any incoming patch regardless of client input. Sending `notifications: null` clears the per-project override (project re-inherits the global notification settings). +12 tests in `app.test.ts` covering happy path, identity preservation, every rejection, and the null-notifications clear.
- **Banner at the top of the Config tab:** "These override the global defaults for this project only. Global settings live in the top-bar Settings link."

### Changed
- Docs refreshed: `docs/api/server-api.md` expands the `PUT /api/projects/:id` section with the full body shape, response, and error matrix. `docs/plan.md` item 6.14 flipped ❌ → ✅.

## [0.7.3] -- 2026-04-20

Ships plan item **5.9**: the read-only `#/server` page becomes a full editable global-settings form in the web UI, wire-compatible with `cfcf config edit` on the CLI.

### Added
- **`PUT /api/config` endpoint.** Accepts a full `CfcfGlobalConfig` body or a partial patch; merges onto the current config, preserves server-owned fields (`version`, `permissionsAcknowledged`, `availableAgents`), validates through the same `validateConfig` used by `readConfig`, and writes the result. Returns the saved config. Explicit 400 on `maxIterations < 1`, `pauseEvery < 0`, invalid JSON, or required-field violations. Bounded fields with invalid values (e.g. an unknown `readinessGate`) are silently backfilled to their defaults — same behaviour as `readConfig`. +7 tests in `app.test.ts`.
- **Top-bar nav:** `Projects` + `Settings` links added to the web Header next to the logo. Settings routes to `#/server`.
- **Editable global-settings page.** Promotes `ServerInfo` from read-only into a four-section form:
  - **Agent roles** — five roles (dev, judge, architect, documenter, reflection), each with an adapter dropdown (constrained to `availableAgents`) and an optional model text input.
  - **Iteration defaults** — `maxIterations`, `pauseEvery`, `reflectSafeguardAfter`.
  - **Behaviour flags (item 5.1)** — `autoReviewSpecs`, `autoDocumenter`, `cleanupMergedBranches` as checkboxes. `readinessGate` appears as a 3-option dropdown only when `autoReviewSpecs` is on.
  - **Notifications** — master `enabled` toggle + a 3 events × 4 channels matrix of checkboxes.
  - Save / Cancel buttons; dirty indicator; success confirmation. Server-owned read-only rows (version, port, PID, uptime, available agents) stay at the top.
- **Explicit scope banner on the Settings page:** "This edits the global defaults. Per-project overrides live in each project's Config tab, which is read-only today and becomes editable in plan item 6.14."
- Exposed `validateConfig` from `@cfcf/core` so the server's PUT handler can reuse the same validation/backfill rules as the client-side read path.

### Changed
- `GlobalConfig` interface on the web client widened to reflect the editable surface (`autoReviewSpecs`, `autoDocumenter`, `readinessGate`, typed `notifications`).
- Docs refreshed: `docs/guides/workflow.md` mentions the new Settings link; `docs/guides/cli-usage.md` points to the editable web UI as the wire-compatible mirror of `cfcf config edit`; `docs/api/server-api.md` documents `PUT /api/config` with sample body, response, and error matrix.

### Fixed
- **Web project detail's Config tab was missing several fields** (mirror of the `cfcf project show` gap fixed in 0.7.1). `ConfigDisplay` now renders `status`, `reflectionAgent`, `reflectSafeguardAfter`, `cleanupMergedBranches`, and all three 5.1 flags (`autoReviewSpecs`, `autoDocumenter`, `readinessGate`), plus `processTemplate`. Still read-only -- the editable version lands in plan item 6.14.

## [0.7.2] -- 2026-04-20

Small but meaningful follow-up pass after first real-world autoReviewSpecs testing: one regression fix surfaced mid-test, one UX consistency improvement, plus a UX protection against a gotcha the user hit.

### Fixed
- **User feedback was dropped on pre-loop-review resume.** When the loop paused at the pre-loop review phase (architect returned `NEEDS_REFINEMENT` + readiness gate rejected) and the user provided guidance on Resume (web FeedbackForm or `cfcf resume --feedback "..."`), the feedback was stored on `state.userFeedback` but `runReviewSync` built its own `IterationContext` without the field, so `cfcf-docs/user-feedback.md` was written as the default "No user feedback yet." on the next architect spawn. User feedback now plumbs through correctly on both the web and CLI resume paths (they share the server's `resumeLoop`).

### Added
- **`trigger` field on `ReviewHistoryEvent`.** `"loop"` for pre-loop reviews triggered by the iteration loop; `"manual"` for user-invoked `cfcf review` / web Review button / `POST /api/projects/:id/review`. Web History tab now labels loop-triggered reviews as "Pre-loop review" instead of the plain "Review" used for manual runs. Older events without the field are treated as `"manual"` for backward compat.
- **Generated-copy banner on `cfcf-docs/` files sourced from `problem-pack/`.** `cfcf-docs/problem.md`, `success.md`, `constraints.md`, `hints.md`, `style-guide.md`, and `context/*` all get an HTML-comment banner prepended at write time saying "this file is generated from problem-pack/..., do not edit here — your changes will be lost, edit the source". Banner renders invisibly in markdown viewers, is idempotent (won't stack on re-runs), and explains the filepath to edit instead. Addresses a real user-experienced gotcha where an edit to `cfcf-docs/problem.md` was silently clobbered on the next `writeContextToRepo`.
- **`docs/guides/workflow.md`** gains a new "Files you edit vs. files cfcf regenerates" table covering every user-facing file in `problem-pack/` and `cfcf-docs/` with edit-safe vs. not indicators, plus the `CLAUDE.md` / `AGENTS.md` sentinel rule for completeness.

## [0.7.1] -- 2026-04-19

Ships plan item **5.1** end-to-end plus two small polish fixes surfaced during smoke-testing.

### Added
- **`autoReviewSpecs` + `autoDocumenter` + `readinessGate` config keys (item 5.1).** Three tiers (global / project / per-run) following the same priority order as existing keys, with backfill on pre-5.1 configs + projects so nothing breaks. Defaults: `autoReviewSpecs=false`, `autoDocumenter=true`, `readinessGate="blocked"`.
  - When `autoReviewSpecs=true`, Start Loop first runs the Solution Architect as a pre-loop phase. The standalone Review button is hidden in the web UI (a muted hint "Review is part of the Loop (autoReviewSpecs is on). Change in Settings." appears under the button row). A leading `Review (agent)` step appears in the `PhaseIndicator`. Review output commits to main (not an iteration branch -- it's a deterministic input to the loop, not iteration work). If the `readinessGate` rejects the architect's readiness signal, the loop pauses with the architect's gaps as `pendingQuestions`.
  - When `autoDocumenter=false`, the loop reaches SUCCESS and skips the Documenter entirely; the `Document (agent)` step disappears from the phase indicator. `cfcf document` continues to work manually.
  - `readinessGate` levels: `"never"` (always proceed), `"blocked"` (default; stop only on `BLOCKED`), `"needs_refinement_or_blocked"` (strictest; stop on anything but `READY`).
- **`cfcf run` CLI flags:** `--auto-review` / `--no-auto-review`, `--auto-document` / `--no-auto-document`, `--readiness-gate <level>`. Per-run overrides persisted on `loop-state.json` so pause + resume keep the same behaviour.
- **`cfcf init` prompts** for the three new keys (with contextual explanation, including that `readinessGate` is only asked when auto-review is on) + the reflection safeguard (`reflectSafeguardAfter`).
- **`cfcf config show` + `cfcf project show`** now print the full current config, including the three new keys and the pre-existing `reflectionAgent`, `reflectSafeguardAfter`, and `cleanupMergedBranches` fields that were previously hidden from the text output.
- **New `pre_loop_reviewing` loop phase.** Surfaced in `/api/activity`, the top-bar pulsing indicator, history-polling cadence, and the web `PhaseIndicator`.
- **Shared `resolveLoopConfig` + `readinessGateBlocks` helpers** in `iteration-loop.ts` / `architect-runner.ts` implementing the priority + gate rules. +11 tests in `auto-flags.test.ts`.
- **`runReviewSync`** in `architect-runner.ts`, mirroring the `runDocumentSync` / `runReflectionSync` shape so the loop can run the architect in-line (same re-review detection + non-destructive plan validation as the async entry).

### Fixed
- **`(item 5.1)` tag leaking into `cfcf run --help`.** The `.option()` descriptions for the three new flags referenced the internal plan item -- harmless but noisy for end users. Tags stripped from user-facing strings; code comments still reference items for maintainer context.
- **`cfcf project show` was missing several fields.** Didn't list `reflectionAgent`, `reflectSafeguardAfter`, `cleanupMergedBranches`, or any of the three 5.1 keys. All now rendered, with `readinessGate` conditionally shown when auto-review is on (consistent with `cfcf config show`).

### Changed
- **Docs** refreshed for 5.1: `docs/guides/workflow.md` gains a pre-loop review block in the flow diagram and a new "Behaviour flags" subsection; `docs/guides/cli-usage.md` documents the new `cfcf init` prompts and `cfcf run` flags; `docs/api/server-api.md` updates the `/api/config` response sample, the loop-phase table (`pre_loop_reviewing`), and the `/loop/start` body sample.

## [0.7.0] -- 2026-04-18

Post-0.6.0 hardening and UX refinement pass driven by first real-world testing of the Reflection role against an existing repo ("cfcf-calc"). Two small features (architect re-review, CLAUDE.md sentinel merge), a behavior-changing bug fix (iteration-row status during reflection), and a pass of UI polish on the History tab.

### Added

- **Architect re-review mode.** When `cfcf review` is invoked on a project whose `cfcf-docs/plan.md` already has completed items (`[x]`), cfcf now treats it as a re-review rather than a first-run scaffold. `architect-runner` snapshots `plan.md`, sends a re-review prompt that tells the agent to read the full history (iteration logs, decision log, reflection reviews), and enforces the same non-destructive rule the reflection role uses -- any rewrite that removes a completed item or an iteration header is automatically reverted. Template [cfcf-architect-instructions.md](packages/core/src/templates/cfcf-architect-instructions.md) gains a "Two modes" section documenting first-run vs. re-review, with explicit "append new iterations" / "leave plan untouched and say so" / "skip scaffolding docs/*.md" rules.
- **Sentinel-based `CLAUDE.md` / `AGENTS.md` merge.** cfcf no longer overwrites the dev agent's instruction file unconditionally. The file is now carved into a cfcf-owned section delimited by `<!-- cfcf:begin --> ... <!-- cfcf:end -->` markers; anything outside those markers (user notes, team conventions, skills the user added) is preserved across iterations. First-run: if the file exists without markers, cfcf prepends the sentinel block and keeps user content below. Subsequent runs: only the content between markers is refreshed. Markers missing after a user edit: cfcf falls back to the "prepend" branch on the next iteration. Idempotent when inputs are unchanged.
- **Shared `plan-validation.ts` module.** `validatePlanRewrite`, `extractCompletedItems`, `extractIterationHeaders`, `planHasCompletedItems` extracted from `reflection-runner.ts` so both the Reflection role and the Architect re-review path use one implementation (backward compatible: `reflection-runner` still re-exports `validatePlanRewrite`).
- **PhaseIndicator labels distinguish harness vs agent steps.** Across all three workflows -- loop, review, document -- phase labels now read `Prepare (cf²)` / `Dev (agent)` / `Judge (agent)` / `Reflect (agent)` / `Decide (cf²)` / `Document (agent)` (for loop) and `Prepare (cf²)` / `Execute (agent)` / `Collect (cf²)` (for review + document). Makes it obvious at a glance which phases are cfcf plumbing vs LLM invocations.
- **Richer expanded History rows.**
  - Collapsed judge pill now includes test counts alongside quality, e.g. `PROGRESS (8/10 · 5/5) ▸`.
  - Expanded panel now surfaces judge `user_input_needed` (warning-styled auto-open section when true), `should_continue`, and the iteration's branch name in a "Decision flags" footer.
  - `planRejectionReason` (new on `ReflectionHistoryEvent`) is shown in the expanded reflection detail when the non-destructive validator reverts a plan rewrite -- you can see *why* it was rejected.
  - Happy-path dev self-assessment collapses to a single muted inline line (`Dev self-reported high quality · status: completed · no blockers, no user input needed.`) instead of a click-to-expand with an effectively-empty body.

### Changed

- **Iteration history row flips to `completed` as soon as the judge commits**, not after reflection finishes. Reflection has its own row in the History tab; making the iteration wait for it made the tab look stuck for the duration of the reflection phase. `devSignals` / `judgeSignals` / exit codes / determination are all persisted in this earlier update; the separate `merged` flip in the DECIDE block is unchanged.

### Fixed

- (Retroactive -- also in the 0.6.0 polish commit [db9ceff](https://github.com/fstamatelopoulos/cfcf/commit/db9ceff) that merged as part of PR #6) `LoopPhase` in the web types and the `LOOP_ACTIVE_PHASES` constant in `ProjectDetail.tsx` didn't include `reflecting`, so the UI showed "Decide" during the reflection phase and the history polling dropped from 3s back to 10s. Both fixed in 0.6.0.

## [0.6.0] -- 2026-04-18

Iteration 5 loop-quality phase. Ships item **5.6 Tier 3 Strategic Reflection + iterative planning** end-to-end. cfcf now has a fifth role — **Reflection** — that runs after the judge on every iteration (unless the judge opts out), reviews the full cross-iteration history, and may non-destructively rewrite the pending part of `plan.md`. Full design: [`docs/research/reflection-role-and-iterative-planning.md`](docs/research/reflection-role-and-iterative-planning.md).

### Added
- **Reflection role (item 5.6).** New `reflection-runner.ts` (sync entry for loop + async entry for ad-hoc). Reads decision-log, per-iteration changelogs, prior reflections, a compact per-iteration-branch git log (`cfcf-docs/cfcf-reflection-context.md`), and the tail (~500 lines) of the last dev log. Produces `reflection-analysis.md` + `cfcf-reflection-signals.json` + (optionally) a rewritten `plan.md`. Non-destructive validation: completed items and iteration-header numbers must survive any plan rewrite or cfcf reverts `plan.md` to the prior version. `recommend_stop` pauses the loop (never auto-stops).
- **`cfcf reflect` CLI.** `cfcf reflect --project <name> [--prompt "<focus hint>"]` runs the Reflection role ad-hoc against the current state. Does not mutate `loop-state.json` or write an `iteration-log`. Web parity: `POST /api/projects/:id/reflect`, `GET .../reflect/status`, `POST .../reflect/stop`.
- **Judge opt-out signal.** `JudgeSignals` gains `reflection_needed` and `reflection_reason`. When the judge sets `reflection_needed: false`, cfcf skips reflection for that iteration, up to `reflectSafeguardAfter` consecutive skips (default 3) — on the (N+1)th, cfcf forces reflection regardless.
- **Iteration-log artifact.** The dev agent now writes `cfcf-docs/iteration-logs/iteration-N.md` at the end of each iteration (backward-looking changelog of changes, tests, commits, plan items closed). Complements `iteration-handoff.md` (forward-looking). cfcf rebuilds `iteration-history.md` from these files each iteration, so history survives loop restarts.
- **Decision-log multi-role charter.** `decision-log.md` is now the shared append-only journal for dev, judge, architect, reflection, and user. Entries use the tagged format `## <ISO-UTC>  [role: X]  [iter: N]  [category: decision|lesson|observation|strategy|risk|resolved-question]`. All four role-instruction templates updated with per-role appending guidance.
- **Three-commit discipline per iteration.** Each iteration now produces up to three commits: `cfcf iteration N dev (<adapter>)`, `cfcf iteration N judge (<adapter>)`, and (when reflection ran) `cfcf iteration N reflect (<health>): <key_observation>`.
- **New config fields.** `reflectionAgent` and `reflectSafeguardAfter` on both `CfcfGlobalConfig` and `ProjectConfig`. Existing configs are backfilled on read (reflection defaults to the architect agent's adapter, safeguard defaults to 3).
- **Web UI: reflection row in History tab.** Color-coded `iteration_health` (converging=green, stable=blue, stalled=yellow, diverging=red, inconclusive=grey), `✎ plan edited` badge when `plan_modified`, `! stop` badge when `recommend_stop`, and `key_observation` underneath.
- **New templates.** `cfcf-reflection-instructions.md`, `cfcf-reflection-signals.json`, `iteration-log.md` (format reference for the dev agent).
- **Expandable judge + reflection detail rows** (`JudgeDetail.tsx` + `ReflectionDetail.tsx`), mirroring the `ArchitectReview` expansion pattern. Iteration rows expand to show dev + judge signals together (quality, tests, concern, blockers, reflection opt-out); reflection rows expand to show health rationale + plan-modified / rejected state + `recommend_stop` banner.
- **Full parsed `devSignals` + `judgeSignals` persisted inline on iteration history events**, so rows stay expandable even after the on-disk signal files are overwritten next iteration.
- **Cross-project activity endpoint + pulsing top-bar indicator.** New `GET /api/activity` returns currently-running agent runs across all projects (reads each project's `history.json` + `loop-state.json`; loop state has priority for finer-grained phase info). Header polls /activity (3s active, 10s idle) and shows a pulsing blue dot + label (`project-name: reflect #3` or `N agents running`) whenever anything is in flight.
- **Read-only server + config page.** New route `#/server` rendered via `ServerInfo.tsx`: server status (version, port, PID, uptime, available agents, configured) and global config defaults (per-role agent + model, max iterations, pause cadence, `reflectSafeguardAfter`, `cleanupMergedBranches`). Linked from a new `server & config →` button on the Dashboard header.

### Changed
- **`makeDecision` accepts reflection signals.** Reflection's `recommend_stop` takes precedence over the judge's determination (research doc Q6): when reflection flags the loop as fundamentally stuck, cfcf pauses for the user even if the judge said PROGRESS. `max_iterations` and dev `user_input_needed` still short-circuit first.
- **New `reflecting` phase** in `LoopPhase`. Iteration flow: `preparing → dev_executing → judging → reflecting (conditional) → deciding → documenting (on success)`.
- **Decision-log size warning.** Once iteration count crosses 50, cfcf fires a single informational notification per loop run. No auto-trim — the user owns the log.
- **Docs:** full markdown sweep aligning every user + design + API doc with the reflection role and 0.7.0 features — `workflow.md`, `cli-usage.md`, top-level `README.md`, `CLAUDE.md`, `docs/README.md`, `docs/api/server-api.md`, `docs/design/technical-design.md`, `docs/design/agent-process-and-context.md`, `docs/design/cfcf-requirements-vision.md`. `docs/plan.md` item 5.6 marked ✅; `docs/research/reflection-role-and-iterative-planning.md` §10 stamped "Shipped 2026-04-18".

### Fixed
- **`iteration-history.md` loop-restart bug.** The file is now rebuilt each iteration from the committed `cfcf-docs/iteration-logs/iteration-*.md` files instead of relying on the in-memory `LoopState.iterations`, so it survives `cfcf stop` / restart cycles.

## [0.5.0] -- 2026-04-18

Iteration 5 distribution phase. Single self-contained `cfcf-binary` with no Bun runtime, no repo checkout, and no external assets on the user's disk. Finalized design for the upcoming Reflection role (item 5.6) now lives under `docs/research/`.

### Added
- **Binary self-hosting (item 5.3):** compiled `cfcf-binary` hosts the server itself. `cfcf server start` detects whether the server source file exists on disk; if not (compiled binary), it re-spawns itself with `CFCF_INTERNAL_SERVE=1`, and the CLI entry point dispatches straight to `startServer()`. Dev mode (`bun run dev:cli`) keeps the original `bun run packages/server/src/index.ts` spawn path. Verified end-to-end: a fresh 64 MiB `cfcf-binary` copied to `/tmp` with no repo and no Bun runtime starts the server, serves the API, serves the web GUI, and shuts down cleanly.
- **Embedded runtime assets (item 5.4):** templates (13 `.md` / `.json` files) and the web dist bundle (222 KB JS + 14 KB CSS + HTML, ~237 KB total) are now compiled into the binary, so the compiled artifact is self-contained.
  - `packages/core/src/templates.ts` — embedded template registry + resolver. Lookup order: `<repoPath>/cfcf-templates/<name>` (project-local override) → `<CFCF_CONFIG_DIR>/templates/<name>` (user-global override) → embedded default. All four template consumers (`architect-runner`, `judge-runner`, `documenter-runner`, `context-assembler`) migrated to `getTemplate()`. 12 unit tests cover embedded resolution, override precedence, and `writeTemplateIfMissing` non-clobbering behavior.
  - `scripts/embed-web-dist.ts` — runs as part of `bun run build:web`; reads `packages/web/dist/**` and writes a gitignored `packages/server/src/web-assets.generated.ts` whose exported `WEB_ASSETS` map is served by Hono. Dev fallback reads from disk when the generated file is absent.
- **`cleanupMergedBranches` flag (item 5.2):** new optional config field on both `CfcfGlobalConfig` (default for new projects) and `ProjectConfig` (per-project override). When `true`, the iteration loop deletes the `cfcf/iteration-N` branch after a successful auto-merge to main. Default `false` so the audit trail is preserved by default. Non-fatal on delete failure (logged warning, loop continues). Tests added: `git-manager` round-trip (create → merge → delete) and `projects.createProject` default verification.
- **Finalized design for Reflection role (item 5.6, implementation deferred):** `docs/research/reflection-role-and-iterative-planning.md` captures the full flow — per-iteration reflection with judge opt-out + `reflectSafeguardAfter` ceiling, non-destructive plan rewrites, single `decision-log.md` as multi-role journal with tagged entries, new `cfcf-docs/iteration-logs/iteration-N.md` changelog artifact (dev-agent authored), `cfcf reflect` CLI for ad-hoc reflection, three-PR implementation plan. All open questions resolved. Ready for a dedicated implementation session.

### Changed
- `bun run build:web` now runs both the Vite build and `scripts/embed-web-dist.ts` so the generated server-side asset bundle stays in sync with the Vite output.
- `bun run build` now depends on `build:web` so the compiled binary always carries a fresh embedded web bundle.
- `tsconfig.json` `include` extended to cover `packages/core/src/templates/*.json` (so the `with { type: "text" }` import resolution is well-typed). An ambient `packages/core/src/templates.d.ts` declares `*.md` and `*/templates/*.json` as string modules so the `type: "text"` imports type-check cleanly without disabling `resolveJsonModule`.
- `docs/plan.md`: item 5.6 marked "designing" and linked to the research doc; item 6.12 added for CLI ↔ web-GUI parity audit (surfaced by the `cfcf reflect` work).
- Doc sanity pass across `CLAUDE.md`, `README.md`, `docs/design/cfcf-stack.md`, `docs/design/technical-design.md`, `docs/design/cfcf-requirements-vision.md`, `docs/design/agent-process-and-context.md` to reflect shipped 0.4.0, in-flight 0.5.0, and the upcoming Reflection role.

## [0.4.0] -- 2026-04-18

Iteration 4: Web GUI + operational robustness + notifications + architect-review UI + live timer + per-iteration scope discipline.

### Added

**Web GUI (`packages/web`, React + Vite):**
- Dashboard with project list and status badges
- Project detail page with Status / History / Logs / Config tabs
- PhaseIndicator for loop / review / document runs
- LoopControls with Start / Stop / Resume / Review / Document buttons; Stop Review and Stop Document while running
- FeedbackForm for resuming paused loops with user direction
- Real-time log streaming via SSE; persists across tab switches
- Unified ProjectHistory timeline (reviews + iterations + documents) with per-entry log link
- Hono serves built assets via `serveStatic`; CORS for `/api/*` during dev

**Server API:**
- `GET /api/projects/:id/history` — persistent history of all agent runs
- `GET /api/projects/:id/logs/:filename` — generic log streaming by filename (with path-traversal safety)
- `GET /api/projects/:id/loop/events` — SSE stream of loop phase transitions
- `POST /api/projects/:id/review/stop` — kill a running review
- `POST /api/projects/:id/document/stop` — kill a running documenter

**Persistence and state:**
- `loop-state.json` per project persists across server restarts
- `history.json` per project tracks every agent run (review, iteration, document) across loop restarts
- Sequence-numbered logs for architect and documenter (`architect-001.log`, `documenter-001.log`, etc.) so re-runs preserve history
- `documenting` phase added to `LoopPhase` (loop stays active while docs are generated post-SUCCESS)

**Operational robustness (item 4.16):**
- Central active-processes registry (`packages/core/src/active-processes.ts`) tracks all running agent processes
- Graceful shutdown on SIGINT/SIGTERM: kills all tracked processes, marks history events + loop states as failed, removes PID file
- Startup recovery: stale "running" history events and stale active loop states are marked failed (recovers from crashes)
- `--watch` mode warning at startup so users know file changes will kill active agents
- `process.on('unhandledRejection')` and `process.on('uncaughtException')` handlers trigger graceful shutdown
- Fire-and-forget `.catch()` handlers in runners now try/catch themselves so recording failures don't silently swallow the original error

**Notifications (item 4.18):**
- 3 event types: `loop.paused`, `loop.completed`, `agent.failed`
- 4 channels: `terminal-bell` (BEL to stderr), `macos` (osascript), `linux` (notify-send), `log` (JSON Lines audit trail)
- Fire-and-forget dispatcher with 5s per-channel timeout
- Global + per-project config; configured during `cfcf init`
- Webhook channel and additional events (iteration.completed, review.completed, etc.) deferred to iteration 5

**Architect review presentation (item 4.23):**
- Full parsed `ArchitectSignals` now persisted inline on `ReviewHistoryEvent.signals` (the repo file `cfcf-docs/cfcf-architect-signals.json` is overwritten by every review run, so inline persistence is what makes prior reviews viewable)
- New `ArchitectReview` React component renders readiness + guidance banner keyed to readiness (e.g. "Edit files under `problem-pack/` and rerun Review" for `NEEDS_REFINEMENT`) + collapsible gaps / suggestions / risks / recommended_approach sections
- Integrated into Status tab (latest review) and History tab (clickable readiness pill expands an inline detail row in compact mode)
- Backward-compatible: pre-4.23 review events without `signals` still render their readiness label as plain text

**Per-iteration plan execution discipline (item 4.24):**
- One-phase-per-iteration discipline injected at three levels: (1) `context-assembler.generateInstructionContent()` embeds an "Iteration Scope" section in the Tier-1 instruction file regenerated fresh every iteration — reaches existing projects whose static `process.md` was copied before this change; (2) one-line dev-agent CLI prompt spells out "execute only the next pending chunk from `plan.md`"; (3) static `process.md` and architect `plan.md` templates model the same phases-as-iterations structure for new projects
- Agent-agnostic — same generated content is written to whichever filename each adapter specifies (Claude Code: `CLAUDE.md`; Codex: `AGENTS.md`)
- Discovered empirically via a user-authored hint while running the tracker example, promoted into the core prompts so every project gets checkpointed iterations by default

**Live elapsed-time counter (item 4.25):**
- Shared `formatDuration` util + `useElapsed` hook (1s local tick, no server calls) renders the active agent-run's elapsed time next to the title row (e.g. "Iteration 2 · 2m 14s")
- Same format used by the History tab Duration column (now sourced from the shared util)
- Hides on completed/failed/stopped; freezes on paused
- First web-package test suite added (9 tests for `formatDuration`); `test:web` script added at the root

**Other:**
- `git merge --no-ff` for iteration merges — preserves iteration boundaries in `git log --graph`
- Claude Code adapter: added `--verbose` flag (note: `-p` print mode still emits final-only; `--verbose` helps in mixed modes)
- `docsFileCount` / `committed` / `exitCode` fields on Document history events, shown in the History tab
- Test repo setup/cleanup scripts (`scripts/setup-test-repos.sh`, `scripts/cleanup-test-repos.sh`)
- Tabular iteration plan format in `docs/plan.md`
- 205 tests total (170 core + 24 server + 2 cli + 9 web)

### Changed
- `ReviewHistoryEvent` now persists full `signals` inline (`packages/core/src/project-history.ts`). Backward-compatible with pre-4.23 entries.

### Fixed
- Log viewer performance on large logs (50K+ lines) — single `<pre>` block with all lines
- Review / Document buttons: auto-switch to Logs tab and stream the log on click
- History tab correctly shows completion status for reviews and documents (previously could get stuck at "running" when polling was disabled)
- Review / Document / Start Loop buttons remain visible (disabled) while another agent is running — no longer disappear
- Configuration validation backfills `architectAgent` and `documenterAgent` in older config files

## [0.3.0] -- 2026-04-15

Iteration 3: Iteration loop, judge agent, Solution Architect, human-on-the-loop. **This is the MVP.**

### Added
- **Iteration loop controller**: full dark factory loop (dev → judge → decide → repeat)
- **Decision engine**: maps judge signals to deterministic actions (continue/pause/stop)
- **Judge runner**: spawns judge agent, parses assessment + signal file, archives reviews
- **Solution Architect**: `cfcf review --project <name>` for pre-iteration Problem Pack review
  - Readiness assessment (READY / NEEDS_REFINEMENT / BLOCKED)
  - Gap analysis, security review, solution options
  - **Initial plan outline** written to `cfcf-docs/plan.md` for dev agents to build on
- **Human-on-the-loop controls**:
  - `cfcf resume --project <name> [--feedback "..."]` to resume paused loops
  - `cfcf stop --project <name>` to halt running loops
  - Pause-every-N cadence with user review
  - Signal-driven pause when agents need user input
- **Model selection per role**: `cfcf init` asks for model per agent role (dev, judge, architect)
- **Architect agent config**: `architectAgent` in global and project config
- **Enhanced `cfcf status --project <name>`**: shows loop phase, iteration history, judge determinations
- Server endpoints: `POST .../loop/start`, `GET .../loop/status`, `POST .../loop/resume`, `POST .../loop/stop`, `POST .../review`, `GET .../review/status`
- Templates: judge instructions, judge signal file, architect instructions, architect signal file
- Auto-merge to main on PROGRESS/SUCCESS (configurable: auto vs PR-based)
- Push to remote on success
- **Documenter role**: runs automatically post-SUCCESS to produce polished final documentation
  - `cfcf document --project <name>` for on-demand documentation generation
  - Produces: `docs/architecture.md`, `docs/api-reference.md`, `docs/setup-guide.md`, `docs/README.md`
  - Server endpoints: `POST .../document`, `GET .../document/status`
- **Three-layer documentation strategy**: Architect creates doc stubs → Dev agent maintains them each iteration → Documenter polishes post-SUCCESS
- **Loop state persistence**: loop state saved to disk on every phase transition, survives server restarts
- Elapsed time counter in CLI polling (replaces dots)
- 172 tests (335 assertions) -- 52 new tests covering all new components

### Changed
- `cfcf run --project <name>` now starts the full iteration loop (dark factory mode) by default
- Manual mode preserved with `cfcf run --project <name> -- <cmd>`
- `ProjectConfig` now includes `architectAgent`, `documenterAgent`, `status` fields
- `AgentAdapter.buildCommand()` accepts optional `model` parameter
- Log storage supports architect role alongside dev and judge
- Codex adapter updated to use `codex -a never exec -s danger-full-access` (headless exec mode, full access)

### Fixed
- Codex adapter: updated CLI flags for current Codex CLI (was using removed `--approval-mode` flag)
- Codex adapter: global flag `-a` must precede `exec` subcommand
- Judge failure now shows helpful error message with log file path (was showing bare "anomaly")
- Judge retry on resume: when dev succeeds but judge fails, resume retries only the judge on the same branch
- Problem Pack validated before branch switch (was switching to empty branch first, losing access to files)
- Stale iteration branches from failed runs are deleted and recreated off current HEAD

## [0.2.0] -- 2026-04-12

Iteration 2: Problem Pack, context assembly, agent-mode run. First successful end-to-end agent iteration.

### Added
- Problem Pack parser: reads problem.md, success.md, constraints.md, hints.md, context/
- Context assembler: generates CLAUDE.md (or AGENTS.md for Codex) with tiered context (Tier 1 embedded, Tier 2 files, Tier 3 reference)
- Agent-mode `cfcf run --project <name>`: launches configured dev agent with assembled context
- Manual mode `cfcf run --project <name> -- <cmd>` preserved for testing/debugging
- cfcf-docs/ templates: process.md, iteration-handoff.md, cfcf-iteration-signals.json, decision-log.md, plan.md, iteration-history.md, judge-assessment.md, user-feedback.md
- `cfcf project init` scaffolds problem-pack/ directory with problem.md and success.md templates
- Post-iteration parsing of handoff document and signal file
- `instructionFilename` on AgentAdapter interface (CLAUDE.md for Claude Code, AGENTS.md for Codex)
- Async iteration runner: server runs agent in background, CLI polls for status
- Real-time log streaming: agent output written to disk incrementally with flush
- Iteration status endpoint: `GET /api/projects/:id/iterations/:n/status`
- Latest iteration endpoint: `GET /api/projects/:id/iterations/latest`
- Example Problem Pack: calculator module (problem-packs/example/)
- 120 tests (227 assertions) covering all new components

### Changed
- `POST /api/projects/:id/iterate` now returns 202 (async) instead of blocking until agent completes
- Process manager streams logs to disk in real-time instead of buffering in memory

### Fixed
- HTTP timeout on long agent runs: refactored from synchronous request/response to async pattern with status polling

## [0.1.0] -- 2026-04-12

Iteration 1: Project management, process manager, git manager, CI pipeline.

### Added
- Project management: `cfcf project init/list/show/delete` with per-project config stored under `~/.cfcf/projects/`
- Global config commands: `cfcf config show`, `cfcf config edit`
- Process manager: spawn commands, stream logs, capture output to disk, kill/timeout support
- Git manager: feature branch creation (`cfcf/iteration-N`), commit, diff, reset, push, merge
- `cfcf run --project <name> -- <command>` executes the next iteration (creates branch, runs command, captures logs, commits)
- Server endpoints: project CRUD, `POST /api/projects/:id/iterate`, `GET /api/projects/:id/iterations/:n/logs` (SSE), `POST /api/shutdown`
- Reliable `cfcf server stop` using PID file and `/api/shutdown` endpoint
- Log storage at `~/.cfcf/logs/<project>/iteration-NNN-dev.log`
- GitHub Actions CI: test + typecheck on Ubuntu and macOS, cross-platform binary builds
- `bun run build` compiles a self-contained 64MB binary
- CLI usage guide: `docs/guides/cli-usage.md`
- 90 tests (169 assertions) covering all new components

### Changed
- Simplified execution model: removed "run" concept. Iterations are monotonically numbered per project (project → iteration, not project → run → iteration)
- `ProjectConfig` now tracks `currentIteration` counter
- SSE events renamed: `project.paused`, `project.completed` (was `run.*`)

## [0.0.0] -- 2026-04-11

Iteration 0: Project scaffolding, server skeleton, CLI, first-run configuration.

### Added
- Bun monorepo with `@cfcf/core`, `@cfcf/server`, `@cfcf/cli` workspace packages
- Hono-based HTTP server with `/api/health`, `/api/status`, `/api/config` endpoints
- Commander.js CLI with `cfcf init`, `cfcf status`, `cfcf server start/stop/status`
- First-run interactive configuration: agent detection, user prompts, permission acknowledgment
- Agent adapter interface with Claude Code and Codex CLI adapters
- Platform-specific config storage (XDG on Linux, Application Support on macOS, AppData on Windows)
- 35 tests (74 assertions) covering core config, adapters, server API, and CLI client
- Project documentation suite: requirements & vision (v0.4), tech stack, technical design, agent process & context, development plan, server API reference
- CLAUDE.md with project principles for AI coding agents
- docs/ structure: design/, api/, research/, guides/

[Unreleased]: https://github.com/fstamatelopoulos/cfcf/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/fstamatelopoulos/cfcf/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/fstamatelopoulos/cfcf/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/fstamatelopoulos/cfcf/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/fstamatelopoulos/cfcf/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/fstamatelopoulos/cfcf/compare/v0.0.0...v0.1.0
[0.0.0]: https://github.com/fstamatelopoulos/cfcf/releases/tag/v0.0.0
