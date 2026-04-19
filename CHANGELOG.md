# Changelog

All notable changes to cfcf (cf²) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Changes are tracked via git tags. Each release tag corresponds to an entry here.

## [Unreleased]

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
