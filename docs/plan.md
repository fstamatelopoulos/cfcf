# cf² Development Plan

*cfcf and cf² are used interchangeably. Both are pronounced "cf square." `cfcf` in code; cf² in docs.*

**Status:** Living Document
**Date:** April 2026
**Authors:** Fotis Stamatelopoulos, Claude

---

## Guiding Principles for Iteration Planning

- Each iteration should produce a working, testable artifact.
- We build the simplest version first, then layer complexity.
- Agents run as local processes in the user's dev environment -- no containers.
- Two initial agents: Claude Code (dev) + Codex (judge), both configurable.
- The cfcf server is the backbone from the start -- it manages execution and exposes a CLI API.
- Each agent iteration is a single non-interactive execution: the agent reads context, works, produces a handoff document + signal file, and exits.
- Even failed iterations are committed. The next agent decides whether to backtrack.
- All cfcf-generated files live in the repo (tracked in git). Agent logs backed up to `~/.cfcf/`.
- Feature branch per iteration, merged to main after iteration completes.

---

## Resolved Design Decisions

These were open questions that have been resolved through brainstorming.

### Execution model: Local processes, not containers

Agents run as local processes in the user's normal dev environment. No Docker, no containers. This reuses existing agent authentication, git credentials, and tooling. Isolation is achieved via git branches and agent instructions (guardrails). Containers are a future option.

### Agent interaction: Fire-and-forget with full log capture

cfcf spawns the agent as a single non-interactive process. The agent reads context from files, executes, and exits. cfcf captures all stdout/stderr via streaming. No mid-run interaction for v0.1. Full logs are stored in cfcf's external memory for judge evaluation and user review.

### Context delivery: File-based

All context is delivered via files in the repo: CLAUDE.md (or agent equivalent), a `cfcf-docs/` folder with problem definition, iteration history, process instructions, etc. The agent is instructed which files to read and in what order. No stdin/prompt component for now.

### Iteration state on failure: Commit everything

Failed iterations are committed to the repo. The next iteration's agent analyzes commits and docs and may backtrack using git. cfcf also maintains copies of key files and logs in its external memory (~/.cfcf/).

### Server from the start

cfcf is a server that manages projects, iterations, and agent processes. The CLI (and later web GUI) are clients. The server is always-on, serving a REST/SSE API. Initially supports a single project execution; designed to support multiple projects in parallel later.

### Fresh agent session per iteration

No session continuity between iterations. Each iteration spawns a fresh agent process. Context comes from files, not from agent memory. This avoids carrying forward bad assumptions.

### Git strategy: Feature branch per iteration

Each iteration gets its own feature branch off main. On normal completion, the branch is merged to main (via PR or direct merge). GitHub is the only supported remote for v0.1. This is a "dark factory" model -- cfcf-controlled agents are the primary committers, though human developers can coexist on the same repo using different branches.

### All files in the repo, no external persistent memory (for now)

All cfcf-generated files (assessments, signals, plans, logs summaries) are tracked in git under `cfcf-docs/`. Agent stdout/stderr logs are backed up to `~/.cfcf/` (too large for repo). An external persistent memory layer is deferred -- it will appear organically when needed.

### First-run interactive configuration

On first execution (no config file found), cfcf runs agent detection (Claude Code, Codex), asks user for defaults (dev agent, judge agent, max iterations, etc.), explains `--dangerously-skip-permissions`, and stores config in the platform's standard config directory (e.g., `~/.config/cfcf/` on Linux). See `design/technical-design.md` section 4.11.

### Process template: copied into repo, versioned in git

cfcf ships default process templates. On `cfcf init`, the selected template is copied into the repo under `cfcf-docs/`. The user or agents can modify it -- changes are tracked in git. Which template was used is recorded in project config.

---

## Open Design Questions

### Q1: Signal file reliability

Malformed or missing signal files are treated as anomalies -- cfcf alerts the user and does not try to infer from Markdown. Resolved, but worth monitoring in practice.

### Q2: Token bootstrapping cost mitigation

Each iteration re-reads all context. Strategies to manage this:
- Tightly defined process docs with explicit read order
- SLM-compressed summaries of previous iterations
- Clear "must read" vs "reference only" context tiers
- Keeping handoff documents concise

**Decision:** Ongoing -- will validate with real agent iterations in Iteration 2.

---

## Iteration Plan

Status legend: ✅ Done · 🟡 In progress · ❌ Not started · ⏸ Deferred · ⚠️ Blocked

The tables below are the authoritative view of iteration progress. The **Notes** column records the outcome, commit reference, or reason for deferral — read these first when reorienting between sessions.

---

### Iteration 0: Project Scaffolding + Server Skeleton

**Goal:** Monorepo structure, build pipeline, basic server, basic CLI that talks to the server. No agents, no orchestration.

| # | Status | Title | Notes |
|---|--------|-------|-------|
| 0.1 | ✅ | Bun monorepo with `packages/core`, `packages/server`, `packages/cli` | Workspace aliases set up: `@cfcf/core`, `@cfcf/server` |
| 0.2 | ✅ | Hono server with `/api/health`, `/api/status`, `/api/config` | Bun.serve, single process |
| 0.3 | ✅ | Commander.js CLI: `cfcf`, `cfcf init`, `cfcf server start/stop/status` | |
| 0.4 | ✅ | First-run interactive configuration | Agent detection (Claude Code, Codex), dependency check, permission acknowledgment, XDG-compliant config storage |
| 0.5 | ✅ | Agent adapter interface + Claude Code + Codex adapters | Plugin contract defined in `types.ts` |
| 0.6 | ✅ | Test suite structure (Bun test) | Colocated test files |
| 0.7 | ✅ | `decisions-log.md` | Captures non-obvious decisions and failed experiments |

**Tag:** v0.0.0

---

### Iteration 1: Project Management + Process Manager + Git + CI

**Goal:** cfcf can manage projects, spawn local processes, capture logs, manage git branches. No AI agent yet — prove the plumbing.

| # | Status | Title | Notes |
|---|--------|-------|-------|
| 1.1 | ✅ | Project CRUD + storage | `~/.cfcf/projects/<id>/config.json`; `currentIteration` counter |
| 1.2 | ✅ | CLI: `cfcf project init/list/show/delete` | |
| 1.3 | ✅ | CLI: `cfcf config show/edit` | |
| 1.4 | ✅ | Process manager | `Bun.spawn()`, streaming stdout/stderr, kill, timeout |
| 1.5 | ✅ | Log storage | `~/.cfcf/logs/<project-id>/iteration-NNN-<role>.log` |
| 1.6 | ✅ | Git manager | Branch (`cfcf/iteration-N`), commit, diff, reset, push, merge |
| 1.7 | ✅ | Server: project CRUD, `POST /api/projects/:id/iterate`, SSE logs | |
| 1.8 | ✅ | `cfcf run --project <name> -- <command>` (manual mode) | Branch → spawn → capture → commit |
| 1.9 | ✅ | Build script + GitHub Actions CI | `bun build --compile` self-contained binary; darwin-arm64, darwin-x64, linux-x64 |
| 1.10 | ✅ | Reliable `cfcf server stop` via PID file | |

**Tag:** v0.1.0

---

### Iteration 2: Problem Pack + Context Assembly + One-Shot Agent Run

**Goal:** cfcf reads a Problem Pack, assembles context (CLAUDE.md + `cfcf-docs/`), spawns a real AI coding agent, runs one iteration, captures results. First end-to-end useful flow.

| # | Status | Title | Notes |
|---|--------|-------|-------|
| 2.1 | ✅ | Problem Pack parser | Reads problem.md, success.md, constraints.md, hints.md, context/ |
| 2.2 | ✅ | Context assembler | Tiered context; writes CLAUDE.md + cfcf-docs/ templates into repo |
| 2.3 | ✅ | Claude Code adapter: `checkAvailability`, `buildCommand`, `instructionFilename` | `claude --dangerously-skip-permissions -p "..."` (later added `--verbose` in iteration 4) |
| 2.4 | ✅ | Codex adapter | `codex exec -a never -s danger-full-access "..."` (updated in iteration 3 from deprecated `--approval-mode`) |
| 2.5 | ✅ | `cfcf-docs/` file templates | process.md, handoff, signals JSON, plan, decision log |
| 2.6 | ✅ | `cfcf project init` scaffolds `problem-pack/` | |
| 2.7 | ✅ | `cfcf run` agent mode — full end-to-end flow | Context assembly → agent spawn → handoff parse → commit |
| 2.8 | ✅ | Example Problem Pack | `problem-packs/calculator/` (single iteration) |
| 2.9 | ✅ | Async iteration runner | Server returns 202, CLI polls for status. Fixes HTTP timeout on long runs |
| 2.10 | ⏸ | Token measurement | Deferred — agents' token reporting is not standardized |

**Tag:** v0.2.0

---

### Iteration 3: Iteration Loop + Judge + Architect + Documenter + Human-on-the-Loop (MVP)

**Goal:** Multiple iterations in a loop, with a judge evaluating after each, architect reviewing Problem Pack, documenter producing final docs. Pause/resume/stop. This is the MVP.

| # | Status | Title | Notes |
|---|--------|-------|-------|
| 3.1 | ✅ | Iteration loop controller + state machine | prepare → dev → commit → judge → commit → decide cycle; loop state machine |
| 3.2 | ✅ | Judge runner | Spawn, parse signals + assessment, archive to `iteration-reviews/` |
| 3.3 | ✅ | Signal file schemas | `cfcf-iteration-signals.json` (dev), `cfcf-judge-signals.json` (judge); validated by cfcf |
| 3.4 | ✅ | Human-on-the-loop: `pauseEvery`, `cfcf resume`, `cfcf stop` | Pause cadence + signal-driven pause (user_input_needed). Resume with `--feedback` |
| 3.5 | ✅ | Solution Architect + `cfcf review` | Generates architect-review.md, plan.md outline, docs/ stubs |
| 3.6 | ✅ | Documenter role (`cfcf document`, auto post-SUCCESS) | Produces docs/architecture.md, api-reference.md, setup-guide.md, README.md |
| 3.7 | ✅ | Model selection per role | `cfcf init` asks for dev/judge/architect/documenter agent + model |
| 3.8 | ✅ | Loop state persistence to disk | `~/.cfcf/projects/<id>/loop-state.json`; survives server restarts |
| 3.9 | ✅ | `cfcf status --project <name>` | Current loop state + iteration progress |
| 3.10 | ✅ | Three-layer docs strategy (architect stubs → dev maintains → documenter polishes) | |
| 3.11 | ✅ | Elapsed time counter in CLI polling | Replaces dots |
| 3.12 | ✅ | Judge retry on same branch after failure | Fixes "server restart killed judge" scenario |

**Tag:** v0.3.0

---

### Iteration 4: Web GUI + Unified Agent-Run Model

**Goal:** React web GUI for monitoring and control. Unified state machine across review/loop/document. Start preparing for iteration 5 infrastructure.

| # | Status | Title | Notes |
|---|--------|-------|-------|
| 4.1 | ✅ | `packages/web`: React + Vite web GUI | Dashboard, project detail, 4 tabs (Status/History/Logs/Config), dark theme. Served by Hono via serveStatic |
| 4.2 | ✅ | Log viewer: real-time SSE streaming + historical | Handles 50K+ line logs via single `<pre>`. Auto-scroll with top/bottom buttons |
| 4.3 | ✅ | LoopControls + FeedbackForm + PhaseIndicator | Visual state machine, phase transitions, feedback injection on pause |
| 4.4 | ✅ | Loop events SSE endpoint | `GET /api/projects/:id/loop/events` |
| 4.5 | ✅ | Git merge strategy: `--no-ff` | Preserves iteration boundaries in git history. One-line change in `git-manager.ts`. |
| 4.6 | ✅ | Project history + unified log streaming | Persistent `history.json`; sequence-numbered logs (architect-001.log, etc.); generic `/logs/:filename` endpoint; ProjectHistory unified timeline UI |
| 4.7 | ✅ | Unified agent-run state machine | Stop Review/Document buttons; stop endpoints; stale history cleanup on server startup; continuous history polling; unified Status tab for all three agents |
| 4.8 | ✅ | `documenting` phase in LoopPhase | Loop UI remains active during post-SUCCESS documenter run |
| 4.9 | ✅ | Consistent agent display in CLI (`adapter:model`) | `formatAgent()` helper; same format in config show, project show/list, status |
| 4.10 | ✅ | Test repo setup/cleanup scripts | `scripts/setup-test-repos.sh`, `scripts/cleanup-test-repos.sh` (only touches `/tmp/cfcf-*`) |
| 4.11 | ✅ | Claude Code `--verbose` flag | Shows live turn-by-turn progress in logs, matching Codex's verbose default |
| 4.12 | ⏸ | Diff viewer per iteration | Deferred to iteration 6 (item 6.1) |
| 4.13 | ⏸ | `cfcf log <project-name>` CLI | Deferred to iteration 6 (item 6.2). Web History tab covers this for now |
| 4.14 | ⏸ | `cfcf push <project-name>` CLI | Deferred to iteration 6 (item 6.3). Manual `git push` works today |
| 4.15 | ⏸ | `cfcf prepare` dry-run command | Deferred to iteration 6 (item 6.4) |
| 4.16 | ✅ | Robust error handling + graceful shutdown | Active process registry (`active-processes.ts`); SIGINT/SIGTERM kills all tracked processes, marks history events and loop states as failed; on startup, stale active loops + running history events are marked failed; unhandledRejection/uncaughtException handlers trigger graceful shutdown; fire-and-forget error handlers now try/catch their own recording logic; watch-mode warning printed at startup; web UI shows improved error banner with hint. 8 new unit tests for registry. |
| 4.17 | ⏸ | Token/cost tracking | Deferred to iteration 6 (item 6.5). Best-effort per iteration per role |
| 4.18 | ✅ | Notification hooks: extensible event-driven notifications | cfcf emits 3 event types (`loop.paused`, `loop.completed`, `agent.failed`) and an extensible dispatcher routes each to configured channels. v1 channels: `terminal-bell` (BEL char to stderr), `macos` (osascript), `linux` (notify-send), `log` (JSON Lines appended to `<project-logs>/notifications.log`). Fire-and-forget with per-channel 5s timeout; one failing channel never blocks another. Global + per-project config in `notifications.events[eventType] = channels[]`. Asked during `cfcf init`. Webhook channel deferred to iteration 5. |
| 4.19 | ⏸ | Cross-project knowledge | Deferred to iteration 5 (item 5.7) — needs memory layer design first. Agent assessments and lessons learned accumulated across projects, with a query interface for context assembly to pull relevant prior knowledge into new projects |
| 4.20 | ⏸ | Tier 3 Strategic Reflection | Deferred to iteration 5 (item 5.6) — build once loop is battle-tested. Reflection agent that periodically reviews the full iteration history (not just the last iteration) and produces pattern analysis, strategy recommendation, and convergence assessment. Output injected into next iteration's context. Configurable frequency via `--reflect-frequency N` |
| 4.21 | ⏸ | Sandbox / guardrails research | Deferred to iteration 6 (item 6.10). Review Anthropic's sandbox concept and evaluate applicability to cfcf's dark factory loop. Consider filesystem scoping, network restrictions, process sandboxing, permission allow-lists |
| 4.22 | ⏸ | Binary self-hosting | Deferred to iteration 5 (item 5.3), paired with template embedding (5.4) and the installer (5.5) |
| 4.24 | ✅ | Per-iteration plan execution prompt (all surfaces) | The one-phase-per-iteration discipline is now injected at **three levels** so it reaches every run, new or existing project, Claude Code or Codex: (1) `context-assembler.generateInstructionContent()` embeds an "Iteration Scope" section in the Tier-1 `CLAUDE.md` / `AGENTS.md` file generated fresh every iteration (this is the authoritative live channel -- reaches existing projects whose `process.md` was copied before the change); (2) the one-line dev-agent CLI prompt in `iteration-loop.ts` now spells out "execute only the next pending chunk from plan.md"; (3) the static `process.md` template (used on first-time project init) has a new "Iteration Scope -- one phase per iteration" section, and the architect's `plan.md` template maps phases to concrete iterations (`## Iteration 1 -- Foundation`). Agent-agnostic: same generated content is written to whichever filename the adapter specifies. Discovered empirically while running the tracker example with a user hint -- captured and promoted into the core prompts so every project gets checkpointed iterations by default. New context-assembler test asserts the discipline is present in both first-iteration and later-iteration instruction files. All repo docs (workflow.md, agent-process-and-context.md, technical-design.md, CLAUDE.md, README.md) updated to reflect the one-phase-per-iteration architecture. |
| 4.25 | ✅ | Live elapsed-time counter on PhaseIndicator | Shared `formatDuration` + `useElapsed` hook (1s tick, no server calls) renders the active agent-run's elapsed time next to the title row (e.g. "Iteration 2 · 2m 14s"). Uses the same format as the History tab's Duration column (now also sourced from the shared util). Hides on completed/failed/stopped, freezes on paused. 9 new util tests in `packages/web/` (first web-package test suite; `test:web` script added at the root). |
| 4.23 | ✅ | Architect review presentation in web UI | The full parsed `ArchitectSignals` (gaps/suggestions/risks/recommended_approach) is now persisted inline on `ReviewHistoryEvent.signals` — the repo file `cfcf-docs/cfcf-architect-signals.json` is overwritten on every review run, so inline persistence is what makes prior reviews viewable. New `ArchitectReview` React component renders the structured JSON with a readiness badge, guidance banner keyed to readiness (e.g. "Edit problem-pack/ files and rerun Review" for NEEDS_REFINEMENT), and collapsible gaps/suggestions/risks/approach sections. Integrated into Status tab (latest review) and History tab (expandable row via clickable readiness pill). Backward-compatible: pre-4.23 review events without `signals` still render their readiness label as plain text. 4 new unit tests in `project-history.test.ts`. |

**In progress branch:** `iteration-4/web-gui`

**Known issues / lessons**:
- Claude Code's `-p` print mode is silent without `--verbose` (fixed in 4.11)
- Codex CLI flag ordering: `-a never` is global, must precede `exec` subcommand
- `bun --watch` restart during active runs orphans agent processes; loop state persistence (3.8) mitigates
- Each `startLoop` resets `loop-state.json`; historical iterations survive only in git branches. The `history.json` (4.6) solves this for reviews/documents but iterations within a run still reset per run start.

---

### Iteration 5: Distribution + Loop Quality + Reflection

**Goal:** Turn cfcf from a developer checkout into a self-contained installable tool, tighten the loop's default behavior, and add the bigger-picture reflection that individual-iteration judging can't give us. This iteration has two loose themes -- **Distribution** (5.3-5.5) and **Loop quality** (5.1, 5.2, 5.6, 5.7) -- either can be picked up independently; 5.3-5.5 form a tight sequence and should ship together.

| # | Status | Title | Notes |
|---|--------|-------|-------|
| 5.1 | ❌ | `autoDocumenter` + `autoReviewSpecs` config flags | Global + per-project + per-run overrides. CLI and web UI must behave identically. Discoverability in Config tab. Small, self-contained; good warm-up |
| 5.2 | ✅ | Auto-delete merged iteration branches | `cleanupMergedBranches` config flag (default `false` — preserves iteration branches for audit). Lives on both `CfcfGlobalConfig` (as a default for new projects) and `ProjectConfig` (per-project override). When `true`, the iteration loop calls `deleteBranch` after a successful auto-merge. Non-fatal on delete failure (logs a warning). Git-manager test + project-defaults test added. |
| 5.3 | ✅ | Binary self-hosting: `cfcf server start` works from compiled binary without Bun | Compiled binary re-spawns itself with `CFCF_INTERNAL_SERVE=1` when `cfcf server start` is invoked and the server source file is absent on disk. Detection is file-stat-based, no Bun-specific magic. CLI entry point in `packages/cli/src/index.ts` dispatches to `startServer()` directly when the env var is set. Dev mode (bun run) keeps the existing `bun run packages/server/src/index.ts` spawn path. Startup polling extended to 5s with 150ms tick to accommodate compiled cold start. Verified end-to-end with a 64 MiB `cfcf-binary` run from /tmp with no repo or Bun installed. |
| 5.4 | ✅ | Embed all runtime assets (templates + web dist) into binary, with local overrides | (a) **Templates** (`packages/core/src/templates.ts`): all 13 templates imported via `with { type: "text" }` and served through `getTemplate(name, { repoPath? })`. Lookup order: `<repoPath>/cfcf-templates/<name>` → `<CFCF_CONFIG_DIR>/templates/<name>` → embedded. Four runners migrated (`architect`, `judge`, `documenter`, `context-assembler`). 12 unit tests. (b) **Web dist** (`scripts/embed-web-dist.ts` → `packages/server/src/web-assets.generated.ts`, gitignored): builds `packages/web` then produces a generated module exporting a `{ path → { contentType, body } }` map backed by base64. Hono route replaces the prior `serveStatic` call with a handler that serves from the embedded map (SPA fallback to `index.html`). Dev fallback reads from `packages/web/dist/` on disk if the generated file is absent. Verified: running `cfcf-binary` from /tmp with no repo checkout produces a working API + web GUI, asset bytes match the Vite build. |
| 5.5 | ❌ | Installer script | `curl -fsSL https://cerefox.org/install \| bash`. Detects platform, downloads from GitHub Releases, verifies checksum. Depends on 5.3 + 5.4 so the single binary is self-sufficient |
| 5.6 | ✅ | Tier 3 Strategic Reflection + iterative planning | **Detailed design: [`research/reflection-role-and-iterative-planning.md`](../research/reflection-role-and-iterative-planning.md).** Shipped end-to-end across three commits on branch `iteration-5/reflection-pr1` (tags `v5.6-pr1/2/3`). PR1: `cfcf-docs/iteration-logs/iteration-N.md` artifact written by the dev agent each iteration, `iteration-history.md` now rebuilt from those logs (fixes the loop-restart bug), `decision-log.md` charter expanded to cover dev/judge/architect/reflection/user with timestamp + `[role]` + `[iter]` + `[category]` tags, all four role templates updated. PR2: Reflection role runner (`reflection-runner.ts`) with `runReflectionSync` (loop) and `startReflection` (ad-hoc); `cfcf-reflection-instructions.md` + `cfcf-reflection-signals.json` templates; `ReflectionSignals` + `ReflectionHistoryEvent` + `IterationHealth` types; `reflectionAgent` + `reflectSafeguardAfter` on `CfcfGlobalConfig` / `ProjectConfig` with backfill; `cfcf reflect --project <name> [--prompt "…"]` CLI; `POST /api/projects/:id/reflect`. PR3: loop wiring — new `reflecting` phase, `shouldRunReflection()` trigger helper (judge opt-out + safeguard ceiling of 3), separate `cfcf iteration N reflect` commit for the three-commit discipline, `makeDecision` accepts `reflectionSignals` and honours `recommend_stop` (Q6 precedence), judge template + signals gain `reflection_needed` / `reflection_reason`, decision-log size warning at iter 50, web History tab gets a reflection row with color-coded `iteration_health`. 255 tests passing across core + server + cli + web. |
| 5.7 | ❌ | Cross-project knowledge | Agent assessments and lessons learned accumulated across projects, with a query interface for context assembly to pull relevant prior knowledge into new projects. Needs a small memory-layer design doc first. Standalone; could also push to iter 6 if 5.3-5.5 become the whole iteration |

**Dependency map for this iteration:**
- `5.3 → 5.5` and `5.4 → 5.5` (distribution chain)
- All others (`5.1`, `5.2`, `5.6`, `5.7`) are independent and can be picked in any order

**Candidate scope reductions (if we want a small iteration 5):**
- **Distribution-only iter 5**: ship 5.3 + 5.4 + 5.5 and defer the rest to iter 6. Cleanest "0.5.0 is installable" story.
- **Loop-quality-only iter 5**: ship 5.1 + 5.2 + 5.6 and defer distribution. Keeps the tool in developer-checkout mode but makes each run smarter.
- **Full scope**: ship all seven. Larger iteration; acceptable if appetite is there.

---

### Iteration 6: CLI parity + New agents + Multi-project + Isolation + Observability

**Goal:** Bring the CLI back to parity with the web GUI, validate the agent plugin interface with a third adapter, run multiple projects concurrently, research sandboxing, and start on observability (diffs, logs, token/cost).

| # | Status | Title | Notes |
|---|--------|-------|-------|
| 6.1 | ❌ | Diff viewer per iteration | Side-by-side diff of each iteration's branch vs main, viewable in both CLI (text diff) and web UI (syntax-highlighted). Originally part of iteration 4 scope |
| 6.2 | ❌ | `cfcf log <project-name>` CLI | Iteration history viewer from the CLI -- brings the web History tab to parity on the CLI side. Reads `history.json` |
| 6.3 | ❌ | `cfcf push <project-name>` CLI | Push branch to remote on demand. Manual `git push` works today; this wraps it with project awareness and notification hooks |
| 6.4 | ❌ | `cfcf prepare` dry-run command | Show assembled context (CLAUDE.md + cfcf-docs/) without launching an agent. Useful for debugging context assembly and previewing what an agent will see |
| 6.5 | ❌ | Token / cost tracking | Best-effort per iteration per role, stored on `IterationHistoryEvent` and surfaced in History tab. Adapter-specific parsing (Claude Code emits usage in `--verbose`; Codex has its own shape). Aggregate shown on project dashboard |
| 6.6 | ❌ | Third agent adapter (Aider / OpenCode / Goose) | Validates plugin interface with a meaningfully different agent. Pick based on maturity at the time of implementation |
| 6.7 | ❌ | Multi-project support in server | Concurrent execution via worker threads or separate child processes; web GUI already supports per-project views but server currently assumes one active loop at a time |
| 6.8 | ❌ | Process template versioning | Ship default templates, support user customization, track which version was used per project. Migration path when cfcf ships template updates |
| 6.9 | ❌ | Optional Cerefox memory backend | Semantic search across projects. Not required -- file-based memory is fully functional standalone. Depends on 5.7 (cross-project knowledge) |
| 6.10 | ❌ | Sandbox / guardrails research + POC | Review Anthropic's sandbox concept. Evaluate applicability to cfcf's dark factory loop. Consider filesystem scoping, network restrictions, process sandboxing, permission allow-lists. Start with a research doc; POC only if research warrants it |
| 6.12 | ❌ | CLI ↔ web-GUI parity audit | After 5.6 ships `cfcf reflect`, cfcf's CLI surface covers `init`, `server start/stop/status`, `project init/list/show/delete`, `config show/edit`, `run`, `resume`, `stop`, `review`, `document`, `reflect`. Audit every command for a matching web-GUI action; document gaps; plan any missing endpoints. Pairs naturally with 6.2 (`cfcf log`) and 6.3 (`cfcf push`) which surface the same parity issue. Surfaced by §13 of the reflection design doc. |
| 6.11 | ❌ | Generalization research: cfcf for non-coding iterative work | Research and design an extension to cfcf's harness so the same iterate → judge → reflect → re-plan loop can drive non-software tasks: research projects (gather info, analyze, produce a report), content production (outline → draft → revise), data analysis, strategy planning. Questions: Is the Problem Pack shape general enough? Does the dev-agent / judge / reflection role split map to non-coding workers? Do we need a different signal schema (no tests to pass)? What becomes the "success criteria" surrogate when the artifact is a Markdown report rather than a passing test suite? Likely overlaps with the Cerefox Agent v0.1 vision. Output: a research doc under `docs/research/` exploring options, not an implementation. |

---

## Future Iterations (v0.7+)

### Coordinator Agent Pattern
- Main agent that launches and directs sub-agents within each iteration
- Role-based agent assignment (planner, coder, tester, documenter)
- Agent-to-agent communication via cfcf message bus
- Replaces single fire-and-forget with richer inner execution model

### Advanced Orchestration
- Iteration branching (explore multiple approaches in parallel)
- Agent switching mid-run based on reflection output
- Incremental success (partial test pass acceptance)
- Automatic problem decomposition

### Web GUI Enhancements
- Rich diff viewer with annotation
- Agent telemetry and token usage dashboards
- Configuration management UI
- Dependency and call graphs

### Notifications and Integrations
- Slack, WhatsApp, email integrations
- Webhook support for arbitrary integrations

### Distribution and Ecosystem
- Homebrew formula
- npm global package
- Podman support
- Remote execution (SSH to a build server)

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-11 | TypeScript + Bun as the stack | Strong typing, shared types across CLI/server/GUI, single binary compilation, mature ecosystem |
| 2026-04-11 | Deterministic outer loop, agent-driven inner coordination (future) | Outer loop must be predictable. Chief-subagent pattern deferred to v0.4+ |
| 2026-04-11 | Claude Code + Codex as the two initial agent adapters | Both needed from v0.1: one for dev, one for judge. Having two validates the plugin interface |
| 2026-04-11 | Fire-and-forget agent execution for v0.1 | Simplest model. Full log capture for judge/user review |
| 2026-04-11 | Fresh agent session per iteration, repo persists on branch | Context comes from files, not session continuity. Git branch provides state continuity. Iterations are monotonically numbered per project |
| 2026-04-11 | Commit failed iterations, let next agent decide on backtracking | Preserves all history. Agent can git revert if needed. cfcf keeps external copies |
| 2026-04-11 | File-based context delivery (CLAUDE.md + cfcf-docs/) | Simple, debuggable, works with any agent |
| 2026-04-11 | Server from iteration 0, not deferred | Server is the backbone for CLI API and process management |
| 2026-04-11 | Self-contained file-based memory layer | No external dependencies. Cerefox as optional backend, not required |
| 2026-04-11 | Agent-based judge (not API-based) | Uses existing agent subscription (no API cost). Full repo access. Cross-agent review. Minimal cfcf plumbing |
| 2026-04-11 | **Local processes, not containers** | Reuses existing agent auth, git credentials, dev tooling. Zero prerequisites beyond cfcf binary. Git branches provide isolation. Containers deferred as future option |
| 2026-04-11 | Tiered context strategy (3 tiers) | Manages token bootstrapping cost. Tier 1 in CLAUDE.md (~500 words), Tier 2 in separate files (~2000 words), Tier 3 on-demand reference |
| 2026-04-11 | Signal files (cfcf-iteration-signals.json, cfcf-judge-signals.json) | Structured JSON for machine-readable agent→cfcf communication. Complements human-readable Markdown docs |
| 2026-04-11 | Web GUI deferred to Iteration 4 | CLI-only sufficient for MVP. GUI adds value once there's something to visualize |
| 2026-04-11 | Push to remote on success/demand only | Avoids per-iteration push overhead and container auth complexity. Local commits sufficient during run |
| 2026-04-11 | User provides existing repo for v0.1 | cfcf does not create repos. User points cfcf at an existing local repo |
| 2026-04-11 | Feature branch per iteration, merge to main | Each iteration gets its own branch (`cfcf/iteration-N`). Normal completion = merge to main (PR or direct). GitHub as only supported remote for v0.1 |
| 2026-04-11 | Signal files: non-hidden, cfcf- prefixed, tracked in git | `cfcf-iteration-signals.json`, `cfcf-judge-signals.json`. Visible files, part of the repo history |
| 2026-04-11 | All cfcf files in repo, no external persistent memory (for now) | Simpler, more transparent. External memory deferred until need appears organically |
| 2026-04-11 | Malformed signal file = anomaly, alert user | cfcf does not infer from Markdown. Reports error, user reviews docs manually |
| 2026-04-11 | First-run interactive config with agent detection | Detect installed agents, ask user for defaults, explain permission flags, store config |
| 2026-04-11 | Process template copied into repo on init, versioned in git | User/agents can modify. Multiple template flavors planned. Community templates in future |
| 2026-04-11 | Judge assessments archived in repo by cfcf | Previous iterations' assessments moved to `cfcf-docs/iteration-reviews/iteration-N.md`. Latest always at `judge-assessment.md` |
| 2026-04-11 | Name: cfcf (code/packages), cf² (docs, pronounced "cf square") | cf² for human-readable contexts, cfcf for all code and package names |
| 2026-04-11 | Merge strategy: configurable, auto-merge by default | Auto-merge to main = dark factory mode (default). PR-based = for teams with review gates. User's review gate is `--pause-every N`, not git merge. Two-level hierarchy: project -> iteration |
| 2026-04-12 | Solution Architect: advisory, not a gate | User-invoked tool (`cfcf review`), not cf²-invoked. Does not block development. User iterates on feedback and decides when to proceed. Three readiness levels: READY, NEEDS_REFINEMENT, BLOCKED |
| 2026-04-12 | Three agent roles: dev, judge, solution architect | Each independently configurable (agent + model). Encouraged to use different agents for cross-review |
| 2026-04-12 | Model selection per role (planned for iteration 3) | AgentConfig already has `model` field. Init/config/adapters need to use it. Critical for role differentiation (e.g., opus for architect, sonnet for dev) |
| 2026-04-12 | Automated iteration loop with user-on-the-loop | User launches once, cf² takes over. User only involved at configured pause cadence or when agents/judge request input. Dark factory model |
| 2026-04-12 | Solution Architect produces initial plan outline | Forces architect to identify gaps/ambiguities. Dev agents read and expand the plan rather than starting from scratch. Better unattended loop quality |
| 2026-04-12 | `cfcf log` and `cfcf push` deferred to iteration 4 | CLI convenience commands. Not critical for MVP. `git push` works manually. Log viewer more useful with web UI |
| 2026-04-12 | Feature branch naming: `iteration-N/<description>` | Matches existing convention from iterations 1-2. Recorded in CLAUDE.md |
| 2026-04-12 | Three-layer documentation strategy: Architect → Dev → Documenter | Architect creates doc stubs (architecture.md, api-reference.md, setup-guide.md). Dev agent maintains them every iteration. Documenter polishes post-SUCCESS. Docs live in project `docs/`, not `cfcf-docs/` |
| 2026-04-12 | Four agent roles: dev, judge, architect, documenter | Each independently configurable (agent + model). Documenter moved from iteration 4 to iteration 3 |

---

*This plan will evolve. Each iteration may add, modify, or defer items based on what we learn.*
