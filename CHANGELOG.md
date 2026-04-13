# Changelog

All notable changes to cfcf (cf²) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Changes are tracked via git tags. Each release tag corresponds to an entry here.

## [Unreleased]

## [0.3.0] -- 2026-04-12

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
- **Loop state persistence**: loop state saved to disk on every phase transition, survives server restarts
- Elapsed time counter in CLI polling (replaces dots)
- 168 tests (323 assertions) -- 48 new tests covering decision engine, judge runner, architect runner, API endpoints, persistence

### Changed
- `cfcf run --project <name>` now starts the full iteration loop (dark factory mode) by default
- Manual mode preserved with `cfcf run --project <name> -- <cmd>`
- `ProjectConfig` now includes `architectAgent`, `status` fields
- `AgentAdapter.buildCommand()` accepts optional `model` parameter
- Log storage supports architect role alongside dev and judge
- Codex adapter updated to use `codex -a never exec --full-auto` (headless exec mode)

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

[Unreleased]: https://github.com/fstamatelopoulos/cfcf/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/fstamatelopoulos/cfcf/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/fstamatelopoulos/cfcf/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/fstamatelopoulos/cfcf/compare/v0.0.0...v0.1.0
[0.0.0]: https://github.com/fstamatelopoulos/cfcf/releases/tag/v0.0.0
