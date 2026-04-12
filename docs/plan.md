# cfcf Development Plan

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

**Decision:** Ongoing -- will validate with real agent runs in Iteration 2.

---

## Iteration Plan

### Iteration 0: Project Scaffolding + Server Skeleton

**Goal:** Monorepo structure, build pipeline, basic server, basic CLI that talks to the server.

**Deliverables:**
- [ ] Monorepo with `packages/cli`, `packages/server`, `packages/core`
- [ ] Bun workspace configuration
- [ ] Basic Hono server (`cfcf server start`) with health endpoint
- [ ] Basic CLI entry point (`cfcf` command with `--help`) that communicates with server
- [ ] Test suite structure with unit tests for all components (Bun test)
- [ ] README with setup instructions, project structure, and contributor guide
- [ ] decisions-log.md for tracking non-obvious decisions and failed experiments

- [ ] First-run interactive configuration flow:
  - Agent detection (Claude Code, Codex)
  - Dependency check (git)
  - User prompts for defaults (dev agent, judge agent, max iterations)
  - Permission acknowledgment (`--dangerously-skip-permissions` explanation)
  - Config file storage (XDG-compliant location)

**No agents, no orchestration.** Server + CLI + config skeleton. Web GUI deferred to Iteration 4.

---

### Iteration 1: Project Management + Process Manager + Log Capture + Git Branch Management

**Goal:** cfcf can manage projects, spawn local processes, stream & capture logs, and manage git branches. No AI agent yet -- just prove the plumbing works end-to-end.

**Deliverables:**

**Project management:**
- [ ] `packages/core`: Project types (ProjectConfig, project CRUD operations)
- [ ] `packages/core`: Project storage (`~/.cfcf/projects/<project-id>/config.json`)
- [ ] Server endpoints: project CRUD (`POST/GET /api/projects`, `GET/PUT /api/projects/:id`)
- [ ] CLI commands:
  - `cfcf project init --repo <path> --name <name>` (create project, link repo, inherit/override global config)
  - `cfcf project list` (list all projects)
  - `cfcf project show <name>` (show project config)
- [ ] CLI commands for global config:
  - `cfcf config show` (display current global config)
  - `cfcf config edit` (re-run interactive setup, same as `cfcf init --force`)

**Process manager:**
- [ ] `packages/core`: Process manager (spawn, stream logs, wait for exit, kill)
- [ ] `packages/core`: Log capture system -- tee stdout/stderr to terminal + disk file
- [ ] `packages/core`: Log storage directory structure (`~/.cfcf/logs/<project-id>/<run-id>/`)

**Git manager:**
- [ ] `packages/core`: Git manager (create feature branch, commit, diff, reset, push)
- [ ] Branch naming: `cfcf/<run-id>/iteration-<N>`

**Server: process execution + SSE:**
- [ ] Server endpoint: `POST /api/projects/:id/run` triggers a process run
- [ ] Server endpoint: `GET /api/projects/:id/run/:runId/events` streams logs via SSE
- [ ] Server: proper `cfcf server stop` using PID file (fix the placeholder from iteration 0)

**CLI: `cfcf run`:**
- [ ] `cfcf run --project <name> -- <command>` triggers server to:
  - Create a cfcf feature branch in the project's repo
  - Spawn the user-specified command (e.g., `npm test`)
  - Stream stdout/stderr to CLI via SSE
  - Capture exit code and full logs to `~/.cfcf/logs/`
  - Commit results to the feature branch

**Build + CI:**
- [ ] Build script: `bun build --compile` to produce self-contained binary for current platform
- [ ] CI pipeline (GitHub Actions): build, test, and lint on push
- [ ] Cross-platform binary targets: darwin-arm64, darwin-x64, linux-x64 (Windows deferred)

**Tests:**
- [ ] Unit tests for process manager (spawn, log, exit, kill)
- [ ] Unit tests for git manager (branch, commit, diff, reset)
- [ ] Unit tests for project CRUD
- [ ] Integration tests: full `cfcf run` cycle (project init → run command → logs captured → committed)
- [ ] Server API tests for new endpoints
- [ ] Error handling tests: process crash, git conflicts, missing project

**Key decisions to validate:**
- Log storage format and location
- Git branch naming strategy
- Process spawning: Bun.spawn() vs child_process
- Binary size and startup time benchmarks
- PID file location for server stop

---

### Iteration 2: Problem Pack + Context Assembly + One-Shot Agent Run

**Goal:** cfcf reads a Problem Pack, assembles context (CLAUDE.md + cfcf-docs/), writes it into the repo, spawns a real AI coding agent, runs one iteration, and captures results. First end-to-end useful flow.

**Deliverables:**
- [ ] `packages/core`: Problem Pack parser (reads problem.md, success.md, constraints.md, hints.md, context/)
- [ ] `packages/core`: Context assembler -- generates and writes to repo:
  - CLAUDE.md (agent instructions with tiered context pointers)
  - cfcf-docs/ folder contents (problem definition, success criteria, process template, etc.)
  - Iteration-specific handoff template and signal file template
- [ ] `packages/adapters/claude-code`: Claude Code adapter
  - `checkAvailability()`: verify Claude Code is installed and authenticated
  - `generateInstructionFile()`: generates CLAUDE.md from assembled context
  - `buildCommand()`: builds the `claude --dangerously-skip-permissions -p "..."` command
  - `unattendedFlags()`: returns `["--dangerously-skip-permissions"]`
- [ ] `packages/adapters/codex`: Codex CLI adapter
  - `checkAvailability()`: verify Codex is installed and authenticated
  - `generateInstructionFile()`: generates equivalent instruction file for Codex
  - `buildCommand()`: builds the `codex --approval-mode full-auto -q "..."` command
  - `unattendedFlags()`: returns `["--approval-mode", "full-auto"]`
- [ ] cfcf-docs/ file templates (see `design/agent-process-and-context.md` for full spec):
  - process.md (process definition)
  - Handoff document template
  - Signal file template (cfcf-iteration-signals.json)
  - Decision & lessons log template
  - Plan template
- [ ] `cfcf init` command: scaffolds an empty Problem Pack directory with templates
- [ ] `cfcf run` extended: `--agent claude-code`, `--repo <path>`
- [ ] Post-iteration: parse handoff + signal file, commit all changes to cfcf branch
- [ ] Example Problem Pack in `problem-packs/example/`
- [ ] **Token measurement**: Track context file sizes, parse agent token usage from logs where possible

**Key decisions to validate:**
- CLAUDE.md format and content structure (real test with Claude Code)
- Does the agent actually fill in the handoff document and signal file?
- How much context fits before hitting agent context limits (token measurement)
- Claude Code non-interactive execution reliability and exit code semantics

---

### Iteration 3: Iteration Loop + Agent Judge + Human-on-the-Loop

**Goal:** cfcf runs multiple iterations in a loop. After each iteration, a separate judge agent evaluates results and produces guidance for the next iteration. The user can be alerted and provide feedback every N iterations. This is the **MVP**.

**Deliverables:**
- [ ] `packages/core`: Iteration loop controller
  - Manages iteration count, max iterations, stop conditions
  - Orchestrates: prepare → execute dev → commit → execute judge → commit → decide cycle
  - State machine: IDLE → PREPARING → DEV_EXECUTING → JUDGING → DECIDING → loop
- [ ] `packages/core`: Judge runner
  - Spawns a separate agent (configurable, encouraged to be different from dev agent)
  - Judge runs in the same repo directory with read access to everything
  - cfcf generates `cfcf-judge-instructions.md` with judge-specific guidance
  - Parses judge assessment (Markdown) and signal file (JSON)
  - Assessment determines: continue, stop (success), stop (failure/anomaly), request user input
- [ ] `packages/core`: Iteration state manager
  - Updates decision & lessons log after each iteration
  - Generates compressed iteration summary for next iteration's context
  - Maintains the evolving plan across iterations
- [ ] Context assembler extended:
  - Tiered context strategy (Tier 1 in CLAUDE.md, Tier 2 in separate files, Tier 3 on-demand)
  - Includes iteration history, previous judge assessment, decision log
  - Aggressive summarization of older iterations in iteration-history.md
  - Manages context growth: track total context file sizes per iteration
- [ ] Human-on-the-loop:
  - `--pause-every N` implementation
  - At pause: display summary via CLI
  - Notification: terminal notification when user input needed or pause reached
  - Accept user input: resume, provide direction, update hints, stop
  - Signal file detection: cfcf reads `cfcf-iteration-signals.json` for `user_input_needed`, presents questions to user
- [ ] `cfcf status <run-id>`: shows current iteration state
- [ ] `cfcf log <run-id>`: shows iteration history
- [ ] `cfcf push <run-id>`: push cfcf branch to remote on demand
- [ ] `cfcf apply <run-id>`: show diff / merge instructions

**This is the MVP.** After this iteration, cfcf can take a problem, run a dev agent at it iteratively with a separate judge providing feedback, and converge toward a solution with human oversight.

---

### Iteration 4: Web GUI + Memory Layer Polish + Reflection

**Goal:** Web GUI for monitoring and control. Full memory layer with cross-run knowledge. Tier 3 strategic reflection.

**Deliverables:**
- [ ] `packages/web`: React web GUI served by Hono server
  - Project status and configuration view
  - Iteration history with expandable details
  - Log viewer (real-time via SSE and historical)
  - Diff viewer per iteration
  - Judge assessment display
  - User feedback input (for pause/review cycles)
- [ ] `packages/core`: Cross-run knowledge
  - Agent assessments accumulated across runs
  - Lessons learned accumulated across runs
  - Query interface for context assembly to pull relevant prior knowledge
- [ ] `packages/core`: Tier 3 Strategic Reflection
  - Configurable frequency (`--reflect-frequency N`)
  - Spawns a reflection agent that reviews full iteration history across the run
  - Produces: pattern analysis, strategy recommendation, convergence assessment
  - Output injected into next iteration's context
- [ ] Token/cost tracking: best-effort measurement per iteration, per role
- [ ] Notification hooks: extensible system (terminal, webhook placeholder)
- [ ] `cfcf prepare` dry-run command: show assembled context without launching
- [ ] Robust error handling, graceful shutdown, process cleanup on crash

---

### Iteration 5: Third Agent Adapter + Multi-Project

**Goal:** Validate the plugin interface with a third agent (beyond Claude Code and Codex). Support running multiple projects.

**Deliverables:**
- [ ] `packages/adapters/<third-agent>`: Third agent adapter (e.g., Aider, OpenCode, or Goose)
  - Further validates the plugin interface with a meaningfully different agent
- [ ] Multi-project support in the server
  - Project configuration and state management
  - Concurrent execution (multiple projects, each running iterations via worker threads)
  - Web GUI: project list, per-project views
- [ ] Optional Cerefox memory backend integration
  - Sync memory documents to Cerefox for semantic search across runs
  - Not required -- file-based memory is fully functional standalone
- [ ] Process definition template versioning
  - Track which process template version a run used
  - Ship default template, support user customization

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
| 2026-04-11 | Fresh agent session per iteration, repo persists on branch | Context comes from files, not session continuity. Git branch provides state continuity |
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
| 2026-04-11 | Feature branch per iteration, merge to main | Each iteration gets its own branch. Normal completion = merge to main (PR or direct). GitHub as only supported remote for v0.1 |
| 2026-04-11 | Signal files: non-hidden, cfcf- prefixed, tracked in git | `cfcf-iteration-signals.json`, `cfcf-judge-signals.json`. Visible files, part of the repo history |
| 2026-04-11 | All cfcf files in repo, no external persistent memory (for now) | Simpler, more transparent. External memory deferred until need appears organically |
| 2026-04-11 | Malformed signal file = anomaly, alert user | cfcf does not infer from Markdown. Reports error, user reviews docs manually |
| 2026-04-11 | First-run interactive config with agent detection | Detect installed agents, ask user for defaults, explain permission flags, store config |
| 2026-04-11 | Process template copied into repo on init, versioned in git | User/agents can modify. Multiple template flavors planned. Community templates in future |
| 2026-04-11 | Judge assessments archived in repo by cfcf | Previous iterations' assessments moved to `cfcf-docs/iteration-reviews/iteration-N.md`. Latest always at `judge-assessment.md` |
| 2026-04-11 | Name: cfcf (code/packages), cf² (docs, pronounced "cf square") | cf² for human-readable contexts, cfcf for all code and package names |
| 2026-04-11 | Merge strategy: configurable, auto-merge by default | Auto-merge to main = dark factory mode (default). PR-based = for teams with review gates. User's review gate is `--pause-every N`, not git merge |

---

*This plan will evolve. Each iteration may add, modify, or defer items based on what we learn.*
