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
| 4.12 | ❌ | Diff viewer per iteration | Part of original scope; not started |
| 4.13 | ❌ | `cfcf log <project-name>` CLI | Iteration history viewer from the CLI (the web History tab covers this now, but CLI parity is still useful) |
| 4.14 | ❌ | `cfcf push <project-name>` CLI | Push branch to remote on demand |
| 4.15 | ❌ | `cfcf prepare` dry-run command | Show assembled context without launching |
| 4.16 | ✅ | Robust error handling + graceful shutdown | Active process registry (`active-processes.ts`); SIGINT/SIGTERM kills all tracked processes, marks history events and loop states as failed; on startup, stale active loops + running history events are marked failed; unhandledRejection/uncaughtException handlers trigger graceful shutdown; fire-and-forget error handlers now try/catch their own recording logic; watch-mode warning printed at startup; web UI shows improved error banner with hint. 8 new unit tests for registry. |
| 4.17 | ❌ | Token/cost tracking | Best-effort per iteration per role |
| 4.18 | ❌ | Notification hooks: extensible event-driven notifications | cfcf emits events (loop paused for cadence, agent needs user input, loop completed, iteration failed, anomaly detected) and an extensible notification system dispatches them through configurable channels. v1 channels: terminal bell + desktop notification (macOS `osascript`, Linux `notify-send`). Stub out a webhook channel for iteration 5 (Slack, email, custom URLs). The goal is "dark factory" operation — user launches a long-running loop, walks away, gets pinged only when cfcf needs them. Configurable per event type (e.g., "only notify me on user_input_needed and completion, not on cadence pauses") |
| 4.19 | ⏸ | Cross-project knowledge | Agent assessments and lessons learned accumulated across projects, with a query interface for context assembly to pull relevant prior knowledge into new projects. Deferred to iteration 5 (item 5.11) — needs memory layer design first |
| 4.20 | ⏸ | Tier 3 Strategic Reflection | A reflection agent that periodically reviews the full iteration history of a project (not just the last iteration) and produces pattern analysis, strategy recommendation, and convergence assessment. Output is injected into the next iteration's context. Complements the judge (Tier 2, per-iteration) with bigger-picture analysis. Configurable frequency via `--reflect-frequency N`. Deferred to iteration 5 (item 5.12) — build once loop is battle-tested |
| 4.21 | ⏸ | Sandbox / guardrails research | Deferred to iteration 5 (item 5.10). Review Anthropic's sandbox concept and evaluate applicability to cfcf's dark factory loop. Consider filesystem scoping, network restrictions, process sandboxing, permission allow-lists |
| 4.22 | ⏸ | Binary self-hosting | Deferred to iteration 5 (item 5.6), paired with template embedding (5.7) and the installer (5.8) |

**In progress branch:** `iteration-4/web-gui`

**Known issues / lessons**:
- Claude Code's `-p` print mode is silent without `--verbose` (fixed in 4.11)
- Codex CLI flag ordering: `-a never` is global, must precede `exec` subcommand
- `bun --watch` restart during active runs orphans agent processes; loop state persistence (3.8) mitigates
- Each `startLoop` resets `loop-state.json`; historical iterations survive only in git branches. The `history.json` (4.6) solves this for reviews/documents but iterations within a run still reset per run start.

---

### Iteration 5: Third Agent + Multi-Project + Distribution

**Goal:** Validate the plugin interface with a third agent. Multi-project concurrent execution. Self-contained binary and installer.

| # | Status | Title | Notes |
|---|--------|-------|-------|
| 5.1 | ❌ | Third agent adapter (Aider / OpenCode / Goose) | Validates plugin interface with meaningfully different agent |
| 5.2 | ❌ | Multi-project support in server | Concurrent execution via worker threads; web GUI per-project views |
| 5.3 | ❌ | Process template versioning | Ship default, support customization, track version used |
| 5.4 | ❌ | `autoDocumenter` + `autoReviewSpecs` config flags | Global + per-project + per-run overrides. CLI and web UI must behave identically. Discoverability in Config tab. |
| 5.5 | ❌ | Auto-delete merged iteration branches | Configurable `cleanupMergedBranches` (default false — preserve for audit) |
| 5.6 | ❌ | Binary self-hosting: `cfcf server start` works from compiled binary without Bun | Today `cfcf server start` requires a Bun runtime (it invokes `bun run packages/server/src/index.ts`). The compiled binary should spawn itself with a `--serve` flag to run the server in-process. Enables true zero-dependency distribution |
| 5.7 | ❌ | Embed templates into binary | Import .md/.json as string constants at build time. Prerequisite for the installer (so users don't need to separately download templates) |
| 5.8 | ❌ | Installer script | `curl -fsSL https://cerefox.org/install \| bash`. Detects platform, downloads from GitHub Releases, verifies checksum. Depends on 5.6 + 5.7 so the binary alone is self-sufficient |
| 5.9 | ❌ | Optional Cerefox memory backend | Semantic search across projects. Not required — file-based memory is fully functional standalone |
| 5.10 | ❌ | Sandbox / guardrails research + POC | Filesystem scoping, network restrictions, process sandboxing, permission allow-lists. Review Anthropic's sandbox concept. |
| 5.11 | ❌ | Cross-project knowledge (carried from iter 4) | Agent assessments + lessons learned accumulated across projects |
| 5.12 | ❌ | Tier 3 Strategic Reflection (carried from iter 4) | Reflection agent reviews full iteration history at configurable cadence (`--reflect-frequency N`). Produces pattern analysis, strategy recommendation, convergence assessment. Output injected into next iteration's context. Complements the per-iteration judge (Tier 2) with bigger-picture analysis across many iterations |

---

## Future Iterations (v0.4+)

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
