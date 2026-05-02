# cfcf: Technical Design

*cfcf and cf² are used interchangeably. Both are pronounced "cf square." `cfcf` in code; cf² in docs.*

**Status:** Living document — refreshed against shipped state at v0.17.0
**Date:** May 2026
**Authors:** Fotis Stamatelopoulos, Claude
**Related Documents:** cfcf Requirements & Vision, cfcf Tech Stack, Agent Process & Context, Development Plan, Clio Memory Layer

---

## 1. Purpose

This document describes the high-level technical architecture of cfcf: how the components fit together, what the data flows look like, and what the key interfaces are. It bridges the gap between the functional requirements (vision doc) and the implementation plan.

---

## 2. Execution Model: Local Process, Not Containers

### 2.1 The Decision

cfcf runs agents as **local processes** in the user's normal development environment -- not inside Docker containers.

### 2.2 Rationale

| Concern | Container approach | Local process approach |
|---------|-------------------|----------------------|
| Agent authentication | Must inject API keys, SSH keys, agent CLI auth into container. Complex setup per agent. | Reuses user's existing authenticated agents. Zero setup. |
| Git credentials | Must inject SSH keys or tokens. User must configure per-workspace repo. | Reuses user's existing git auth. |
| Docker dependency | Hard prerequisite. User must install and run Docker. | No dependency. Works immediately. |
| Agent permissions | Container isolation means `--dangerously-skip-permissions` is safe. | Must use `--dangerously-skip-permissions` (or equivalent) with guardrails. |
| Iteration speed | Container create/clone/teardown adds 10-30s per iteration. | Process start is near-instant. |
| Environment parity | Container may differ from user's real dev env (missing tools, wrong versions). | Agent runs in the exact environment the user develops in. |
| Isolation between iterations | Fresh container = clean state. | Must use git (branches, reset) for state management between iterations. |
| Setup complexity for users | Significant: Docker install, image builds, auth injection, volume management. | Minimal: install cfcf, point it at a repo, go. |

### 2.3 Guardrails Without Containers

Without container isolation, cfcf relies on:

1. **Agent permission flags**: `--dangerously-skip-permissions` for Claude Code, equivalent flags for other agents. This is required for unattended execution.
2. **Git-based isolation**: cfcf works on a dedicated branch. If an iteration goes wrong, git reset/revert restores the previous state.
3. **Working directory scoping**: The agent is instructed (via CLAUDE.md / equivalent) to only modify files within the workspace directory.
4. **cfcf-managed files**: Files in `cfcf-docs/` that are marked read-only are protected by convention (agent instructions say "do not modify"). cfcf can verify post-iteration that read-only files weren't changed and warn/revert if they were.
5. **User acknowledgment**: When starting to iterate, cfcf explicitly tells the user that the agent will run with elevated permissions and asks for confirmation.

### 2.4 Future: Optional Container Mode

Containers remain a future option for users who want stronger isolation:
- CI/CD environments where the local dev environment doesn't exist
- Paranoid mode: user doesn't trust the agent with local filesystem access
- Reproducible environments: ensure the same tooling across machines

The execution interface is designed so that swapping in a container backend doesn't change the iteration controller or any other component.

---

## 3. System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         User's Machine                              │
│                                                                     │
│  ┌──────────┐    HTTP/SSE     ┌──────────────────────────────────┐  │
│  │  CLI     │◄───────────────►│         cfcf Server              │  │
│  │  (cfcf)  │                 │         (Hono on Bun)            │  │
│  └──────────┘                 │                                  │  │
│                               │  Workspace| Iteration | Process  │  │
│  ┌──────────┐    HTTP/SSE     │  Manager | Controller | Manager  │  │
│  │  Web GUI │◄───────────────►│  ─────────────────────────────── │  │
│  │  (React) │  (embedded in   │  Review   | Document  | Judge    │  │
│  │  served  │   binary at     │  Runner   | Runner    | Runner   │  │
│  │  by Hono)│   build time)   │  ─────────────────────────────── │  │
│  └──────────┘                 │  Architect| Reflection| Context  │  │
│                               │  Runner   | Runner    | Assembler│  │
│                               │  ─────────────────────────────── │  │
│                               │  Active   | Notif.    | History  │  │
│                               │  Processes| Dispatcher| Store    │  │
│                               │  ─────────────────────────────── │  │
│                               │  Clio     | Log       | Graceful │  │
│                               │  Backend  | Collector | Shutdown │  │
│                               └──────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Workspace Working Directory    (git repo, local clone)        │   │
│  │    /path/to/workspace/                                       │   │
│  │      src/                     (user's source code)           │   │
│  │      cfcf-docs/               (cfcf-managed context files)   │   │
│  │      docs/                    (project docs: arch, api, etc.)│   │
│  │      CLAUDE.md / AGENTS.md    (agent instructions, generated)│   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  <cfcf config dir>                                           │   │
│  │    config.json               (global config, from cfcf init) │   │
│  │    workspaces/<id>/config.json (per-workspace config)          │   │
│  │    workspaces/<id>/loop-state.json   (persists across restarts)│   │
│  │    workspaces/<id>/history.json      (all agent-run events)    │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  ~/.cfcf/logs/                (agent logs, too large for repo)│   │
│  │    <workspace-id>/                                           │   │
│  │      iteration-NNN-dev.log                                   │   │
│  │      iteration-NNN-judge.log                                 │   │
│  │      iteration-NNN-reflection.log                            │   │
│  │      architect-NNN.log        (sequence-numbered per workspace)│   │
│  │      documenter-NNN.log                                      │   │
│  │      notifications.log        (JSON Lines audit trail)       │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  ~/.cfcf/clio.db              (cross-workspace memory layer) │   │
│  │    SQLite + sqlite-vec + FTS5; shared across all workspaces  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Remote Git Repo (GitHub)   (source of truth, push on success)│  │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. Core Components

### 4.1 cfcf Server

The central process. Always running on localhost. Manages everything.

**Responsibilities:**
- Exposes REST API for CLI (workspace CRUD, iteration lifecycle, configuration, Clio memory)
- Exposes SSE endpoints for real-time event streaming (logs, status updates, alerts)
- Manages workspace state and iteration state
- Orchestrates the iteration loop
- Dispatches notifications
- Serves the web GUI (React+Vite bundle embedded into the compiled binary at build time)

**Framework:** Hono on Bun.

**Key API endpoints (sketch):**

```
# Workspace management
POST   /api/workspaces                  # Create/register workspace
GET    /api/workspaces                  # List workspaces
GET    /api/workspaces/:id              # Get workspace details
PUT    /api/workspaces/:id/config       # Update workspace config (editable from web UI)

# Loop lifecycle
POST   /api/workspaces/:id/run                   # Start iteration loop (202 Accepted, async)
POST   /api/workspaces/:id/pause                 # Pause iteration loop
POST   /api/workspaces/:id/resume                # Resume — body: { action: ResumeAction, feedback?: string }
POST   /api/workspaces/:id/stop                  # Stop iterating

# Solution Architect review (user-invoked, advisory)
POST   /api/workspaces/:id/review                # Spawn architect agent (202 Accepted)
GET    /api/workspaces/:id/review/status         # Review status (poll)

# Reflection (ad-hoc, item 5.6)
POST   /api/workspaces/:id/reflect               # Spawn reflection agent off-loop (202 Accepted)

# Documenter (post-SUCCESS final docs)
POST   /api/workspaces/:id/document              # Spawn documenter agent (202 Accepted)

# Iteration introspection
GET    /api/workspaces/:id/iterations/latest     # Latest iteration status
GET    /api/workspaces/:id/iterations/:n/status  # Iteration status (poll for progress)
GET    /api/workspaces/:id/iterations/:n/logs    # SSE log stream (live or historical)
GET    /api/workspaces/:id/activity              # Activity feed (history events)

# Global config (editable from the web UI Server Info page, item 5.9)
GET    /api/config
PUT    /api/config

# Clio cross-workspace memory (item 5.7+, see clio-memory-layer.md)
GET    /api/clio/search                          # Hybrid / FTS / semantic search
POST   /api/clio/ingest                          # Ingest a document
GET    /api/clio/documents/:id                   # ... and other Clio routes
```

**Structured pause/resume (item 6.25).** When the loop pauses, the user resumes with one of five `ResumeAction` values: `continue`, `finish_loop`, `stop_loop_now`, `refine_plan`, `consult_reflection`. The applicable subset is computed per pause-reason; the web UI shows only the applicable buttons and the CLI rejects inapplicable values with a clear error. A `loop-stopped` history event is emitted on `stop_loop_now`.

### 4.2 Workspace Manager

Manages the lifecycle and configuration of workspaces.

**Workspace configuration (config.json):**

```typescript
interface WorkspaceConfig {
  id: string;
  name: string;
  repoPath: string;                // Local path to the git repo
  // Five iteration-loop agent roles, each independently configurable:
  devAgent: AgentConfig;           // Dev agent configuration
  judgeAgent: AgentConfig;         // Judge agent configuration
  architectAgent: AgentConfig;     // Solution Architect (pre-iteration review)
  documenterAgent: AgentConfig;    // Documenter (post-SUCCESS documentation)
  reflectionAgent?: AgentConfig;   // Reflection (cross-iteration; defaults to architect adapter)
  reflectSafeguardAfter?: number;  // Max consecutive judge opt-outs before reflection is forced (default 3)
  maxIterations: number;           // Hard cap on iterations per workspace
  currentIteration: number;        // Current iteration number (monotonically increasing, starts at 0)
  pauseEvery: number;              // 0 = no pauses, N = pause every N iterations
  onStalled: 'continue' | 'stop' | 'alert'; // Behavior when judge says STALLED
  mergeStrategy: 'auto' | 'pr';    // Auto-merge to main vs. PR-based gating
  cleanupMergedBranches?: boolean; // Delete cfcf/iteration-N after auto-merge (default false)
  autoReviewSpecs?: boolean;       // Auto-run architect on workspace init (item 5.1)
  autoDocumenter?: boolean;        // Auto-run documenter on SUCCESS (item 5.1)
  readinessGate?: ReadinessGate;   // How architect READINESS values gate the loop
  processTemplate: string;         // Process template name (e.g., "default")
  status?: WorkspaceStatus;
  notifications?: NotificationConfig;
  // Clio cross-workspace memory (item 5.7+)
  clioProject?: string;            // Clio Project assignment for this workspace
  clio?: ClioWorkspaceConfig;      // Per-workspace Clio policy override
}

interface AgentConfig {
  adapter: string;                 // Plugin name: "claude-code", "codex"
  model?: string;                  // Model override (e.g., "opus", "sonnet", "o3")
  flags?: string[];                // Additional CLI flags
}
```

**Seven agent roles in cfcf today**, each independently configurable per workspace (with a global default in `CfcfGlobalConfig`):

*Iteration-loop roles* (non-interactive, fire-and-forget per iteration):
- **devAgent** — writes code, runs tests
- **judgeAgent** — reviews each iteration + opts in/out of reflection
- **architectAgent** — Solution Architect: reviews Problem Pack pre-iteration (READY / NEEDS_REFINEMENT / BLOCKED / SCOPE_COMPLETE) and runs re-review mode mid-loop
- **reflectionAgent** — cross-iteration strategic review after every iteration unless the judge opts out and the safeguard ceiling has not been hit; may non-destructively rewrite pending plan items
- **documenterAgent** — produces final polished docs post-SUCCESS

*Interactive roles* (TUI takes over the user's shell):
- **helpAssistantAgent** (item 5.8) — `cfcf help assistant` opens a cf²-expert support session with curated system prompt + embedded help bundle + Clio memory access
- **productArchitectAgent** (item 6.x) — `cfcf spec` interactive Problem Pack authoring session (peer to dev/judge/architect/reflection/documenter; sits at the START of the development flow)

Defaults: `reflectionAgent` falls back to the architect adapter when unset; `helpAssistantAgent` and `productArchitectAgent` fall back to `devAgent`.

### 4.3 Process Manager

Manages agent processes (replaces Container Manager from earlier design).

**Responsibilities:**
- Spawn agent CLI processes with correct working directory, env vars, and flags
- Capture stdout/stderr streams
- Monitor process health (is it still running? exit code?)
- Kill processes on timeout or user request

```typescript
interface ProcessManager {
  spawn(opts: ProcessOptions): Promise<AgentProcess>;
  streamLogs(proc: AgentProcess): AsyncIterable<LogLine>;
  waitForExit(proc: AgentProcess): Promise<{ exitCode: number }>;
  kill(proc: AgentProcess): Promise<void>;
}

interface ProcessOptions {
  command: string;                 // e.g., "claude"
  args: string[];                  // e.g., ["--dangerously-skip-permissions", "-p", "..."]
  cwd: string;                     // Workspace working directory
  env?: Record<string, string>;    // Additional env vars
  logFile: string;                 // Where to write logs
}
```

**Simpler than container management.** No image pulls, no volume mounts, no auth injection. Just `Bun.spawn()` or `child_process.spawn()`.

### 4.4 Iteration Controller

The heart of cfcf. Implements the deterministic iteration loop. Lives in `packages/core/src/iteration-loop.ts`.

**State machine:**

```
IDLE → PREPARING → EXECUTING_DEV → EXECUTING_JUDGE → REFLECTING? → DECIDING → PREPARING (loop)
                                                                       ↓
                                                                  PAUSED (waiting for user)
                                                                       ↓
                                                              (ResumeAction: continue / finish_loop /
                                                               stop_loop_now / refine_plan /
                                                               consult_reflection)
                                                                       ↓
                                                              COMPLETED / FAILED / STOPPED
```

REFLECTING is conditional: skipped when the judge sets `reflection_needed: false` AND the consecutive-skip count is below `reflectSafeguardAfter` (default 3). Reflection always runs otherwise.

**Per-iteration flow** (sketch — actual implementation in `iteration-loop.ts`):

```typescript
async function runIteration(workspace: Workspace, iterationNum: number): Promise<IterationResult> {
  // 1. PREPARE
  const context = await contextAssembler.assemble(workspace, iterationNum);
  await contextAssembler.writeToRepo(workspace.repoPath, context);
  // Writes (sentinel-merged): CLAUDE.md / AGENTS.md
  // Writes (full regen): cfcf-docs/iteration-history.md, judge-assessment.md,
  //                      clio-relevant.md, clio-guide.md, etc.

  // 2. EXECUTE DEV AGENT
  const devProc = await processManager.spawn({ ...devAdapter.buildCommand(...) });
  await processManager.waitForExit(devProc);

  // 3. COLLECT + COMMIT (commit #1: "cfcf iteration N dev (...)")
  const handoff = await parseHandoffDocument(...);
  const signals = await parseSignalFile('cfcf-docs/cfcf-iteration-signals.json');
  await gitManager.commitAll(`cfcf iteration ${iterationNum} dev (${summary})`);

  // 4. EXECUTE JUDGE AGENT
  await judgeRunner.run(workspace, iterationNum);
  const judgeSignals = await parseSignalFile('cfcf-docs/cfcf-judge-signals.json');
  // Commit #2: "cfcf iteration N judge (<determination>)"
  await gitManager.commitAll(`cfcf iteration ${iterationNum} judge (${judgeSignals.determination})`);

  // 5. (CONDITIONAL) EXECUTE REFLECTION AGENT
  if (shouldReflect(judgeSignals, consecutiveSkips, workspace.reflectSafeguardAfter ?? 3)) {
    await reflectionRunner.run(workspace, iterationNum);
    const reflectionSignals = await parseSignalFile('cfcf-docs/cfcf-reflection-signals.json');
    // Commit #3 (optional): "cfcf iteration N reflect (<health>): <key_observation>"
    await gitManager.commitAll(`cfcf iteration ${iterationNum} reflect (${reflectionSignals.iteration_health}): ${reflectionSignals.key_observation}`);
    // Reflection may have non-destructively rewritten cfcf-docs/plan.md;
    // plan-validation.ts enforces that completed [x] items + iteration headers
    // survive any rewrite. Invalid rewrites are reverted to the pre-spawn snapshot.
  }

  // 6. AUTO-INGEST INTO CLIO (gated by workspace.clio.ingestPolicy)
  await clio.ingestIterationArtifacts(workspace, iterationNum);

  return { devSignals: signals, judgeSignals, reflectionSignals };
}
```

Each iteration produces up to **three commits** when reflection runs (`dev`, `judge`, `reflect`) so `git log --oneline` reads as a clean per-iteration story.

### 4.5 Context Assembler

Builds and writes the context files into the repo before each iteration.

**Inputs:**
- Workspace Problem Pack (static files from user)
- Iteration history from memory layer
- Previous judge assessment
- User feedback (if any)
- Agent adapter (determines instruction file format)

**Outputs written to repo:**
- CLAUDE.md / AGENTS.md — sentinel-merged each iteration. Only content inside the `<!-- cfcf:begin --> ... <!-- cfcf:end -->` block is regenerated; user content outside the markers is preserved byte-for-byte.
- cfcf-docs/ folder contents — mix of static (copied from the Problem Pack) and dynamic (generated each iteration) files.

**Per-iteration archive directories under `cfcf-docs/`** (full audit trail; safe to commit because they are small, human-curated, no PII risk):
- `cfcf-docs/iteration-logs/iteration-N.md` — backward-looking dev changelog
- `cfcf-docs/iteration-handoffs/iteration-N.md` — forward-looking dev handoff (v0.7.6+)
- `cfcf-docs/iteration-reviews/iteration-N.md` — judge verdict
- `cfcf-docs/reflection-reviews/iteration-N.md` — reflection analysis

`cfcf-docs/iteration-history.md` is rebuilt from `iteration-logs/` each iteration so it survives server restarts.

**Tiered context strategy:**

```
Tier 1 - MUST READ (~500 words, always included in CLAUDE.md / AGENTS.md directly):
  - Problem summary (compressed from problem.md)
  - Current plan status (from plan.md, last 5-10 lines)
  - Last judge assessment (compressed)
  - Iteration directive ("this iteration, focus on X")
  - **Iteration Scope discipline** (injected every run by
    context-assembler.generateInstructionContent()): "each iteration is a
    separate, clean process; read plan.md, execute only the next pending
    chunk, mark [x] with a brief note, exit." This reaches both Claude
    Code and Codex adapters uniformly because both receive the same
    generated content, written to whichever instruction filename the
    adapter specifies.

Tier 2 - SHOULD READ (~2000 words, separate files, agent reads if needed):
  - cfcf-docs/iteration-history.md (aggressively compressed)
  - cfcf-docs/decisions-log.md (summarized, recent entries in full)
  - cfcf-docs/user-feedback.md
  - cfcf-docs/clio-relevant.md (top-k Clio hits matched against problem.md)
  - cfcf-docs/clio-guide.md (cue card pointing the agent at `cfcf clio` verbs)

Tier 3 - REFERENCE ONLY (full files, agent reads on demand):
  - cfcf-docs/problem.md (full problem definition)
  - cfcf-docs/success.md (full success criteria)
  - cfcf-docs/constraints.md, hints.md, style-guide.md
  - cfcf-docs/context/ (architecture docs, API specs)
  - cfcf-docs/iteration-logs/ + iteration-handoffs/ + iteration-reviews/ +
    reflection-reviews/ (full per-iteration archives)
```

### 4.6 Judge Runner

Runs a **separate agent** (not an API call) to evaluate the iteration.

**Key design: the judge runs in the same repo directory as the dev agent.** This means the judge can:
- Read all source code, not just the diff
- Run tests itself if needed
- Inspect build output
- Access the full cfcf-docs/ context

**Why agent-based, not API-based:**
- **No API cost**: Uses the user's existing agent subscription (e.g., Claude Code subscription, Codex access)
- **Full repo access**: The judge can inspect code, run tests, look at files -- not limited to what cfcf passes in a prompt
- **Minimal cfcf plumbing**: cfcf just spawns the judge agent with instructions and reads its output file
- **Encouraged to use a different agent than the dev agent**: e.g., Codex judges Claude Code's work, or vice versa. Cross-agent review catches different types of issues.

**Judge workflow:**
1. cfcf spawns the judge agent in the same repo directory
2. The judge reads its instructions from a judge-specific instruction file (e.g., `cfcf-docs/cfcf-judge-instructions.md`, generated by cfcf)
3. The judge reviews the handoff doc, diff, code, test results
4. The judge writes its assessment to `cfcf-docs/iteration-reviews/iteration-N.md`
5. The judge also writes a machine-parseable signal file: `cfcf-docs/cfcf-judge-signals.json`
6. The judge agent exits
7. cfcf reads the assessment and signal file

> **Reflection role (item 5.6, shipped):** A fifth iteration-loop agent role — **Reflection** — runs after the judge on every iteration unless the judge opts out via `reflection_needed: false`, capped by the `reflectSafeguardAfter` ceiling (default 3 consecutive opt-outs, at which point reflection is forced). Reflection reads the full workspace history: the decisions log, per-iteration changelogs under `cfcf-docs/iteration-logs/`, prior reflection analyses under `cfcf-docs/reflection-reviews/`, a compact per-iteration-branch git log assembled by cfcf into `cfcf-docs/cfcf-reflection-context.md`, and the tail of the last dev log. It may non-destructively rewrite the pending part of `plan.md` (completed items and iteration headers are preserved; cfcf validates and reverts invalid rewrites via `plan-validation.ts`). The judge signal schema includes `reflection_needed` / `reflection_reason`; `reflection-runner.ts` mirrors `architect-runner.ts` and `documenter-runner.ts`, with both a sync entry point (loop) and an async entry point (`cfcf reflect` CLI + `POST /api/workspaces/:id/reflect`). Each iteration produces up to three commits — `dev`, `judge`, and (when reflection runs) `reflect`. The reflection role is also the only role that may set `recommend_stop` to pause the loop; that signal takes precedence over the judge's `should_continue`. Full design, flow diagrams, signal schemas, and non-destructive plan rules: **[`docs/research/reflection-role-and-iterative-planning.md`](../research/reflection-role-and-iterative-planning.md)**.

### 4.7 Signal Files (Machine-Readable Communication)

Agents communicate structured decisions to cfcf via JSON signal files. These complement the human-readable Markdown documents. Four signal files exist today:

| File | Written by | Read by |
|---|---|---|
| `cfcf-docs/cfcf-iteration-signals.json` | dev agent | iteration loop |
| `cfcf-docs/cfcf-judge-signals.json` | judge agent | iteration loop, reflection runner |
| `cfcf-docs/cfcf-architect-signals.json` | architect agent | iteration loop, web UI |
| `cfcf-docs/cfcf-reflection-signals.json` | reflection agent | iteration loop, web UI, plan-validation |

**Dev agent signal file: `cfcf-docs/cfcf-iteration-signals.json`**

```json
{
  "iteration": 3,
  "agent": "claude-code",
  "status": "completed",
  "user_input_needed": true,
  "questions": [
    "Should the API use REST or GraphQL?",
    "Is the auth service on port 3001 or 4001?"
  ],
  "tests_run": true,
  "tests_passed": 14,
  "tests_failed": 2,
  "tests_total": 16,
  "self_assessment": "medium",
  "blockers": ["missing API spec for the payment endpoint"]
}
```

**Judge signal file: `cfcf-docs/cfcf-judge-signals.json`**

```json
{
  "iteration": 3,
  "determination": "PROGRESS",
  "anomaly_type": null,
  "quality_score": 7,
  "tests_verified": true,
  "should_continue": true,
  "user_input_needed": false,
  "key_concern": "Error handling is incomplete but improving",
  "reflection_needed": true,
  "reflection_reason": "drift across last two iterations"
}
```

**Architect signal file: `cfcf-docs/cfcf-architect-signals.json`**

```json
{
  "readiness": "READY",
  "gaps": [],
  "suggestions": ["consider splitting the auth module into two iterations"],
  "risks": ["payment-gateway integration is untested"],
  "recommended_approach": "..."
}
```

`readiness` is one of `READY` | `NEEDS_REFINEMENT` | `BLOCKED` | `SCOPE_COMPLETE`. `SCOPE_COMPLETE` was added 2026-05-02 (item 6.25 follow-up): the spec describes work already implemented in the source tree, so there is nothing left for the loop to build. It always blocks the loop regardless of the workspace's `readinessGate` setting.

**Reflection signal file: `cfcf-docs/cfcf-reflection-signals.json`**

```json
{
  "iteration": 3,
  "plan_modified": true,
  "iteration_health": "converging",
  "key_observation": "auth flow stabilised; now tackling rate-limiting",
  "recommend_stop": false
}
```

`iteration_health` is one of `converging` | `stable` | `stalled` | `diverging` | `inconclusive`. When invoked via the `consult_reflection` resume action (item 6.25), reflection may also set `harness_action_recommendation` to `continue` | `finish_loop` | `stop_loop_now` | `pause_for_user`.

cfcf parses these JSON files for deterministic decision-making. The Markdown documents are for humans and for context in future iterations.

### 4.8 Memory Layer (two tiers)

cfcf has **two persistent memory tiers**:

**Tier 1 — Per-workspace, in the repo (`cfcf-docs/`).** Iteration history, judge assessments, reflection analyses, architect reviews, decisions log, signal files, and the evolving plan. Everything is tracked in git — the repo is the per-workspace memory of record. Agent stdout/stderr logs live outside the repo under `~/.cfcf/logs/<workspace-id>/` because they are too large and may contain PII / secrets.

**Tier 2 — Cross-workspace Clio (`~/.cfcf/clio.db`).** A SQLite knowledge layer shared across all workspaces and scoped by named **Clio Project**. FTS5 keyword search out of the box; install an embedder via `cfcf clio embedder install` to enable hybrid (alpha-blended cosine + normalised BM25, default α = 0.7) and semantic search. Auto-ingests reflection analyses, architect reviews, decision-log entries, and iteration summaries at iteration boundaries (gated by `workspace.clio.ingestPolicy`). Agents read Clio at context-assembly time via `cfcf-docs/clio-relevant.md` (top-k hits matched against `problem.md`) and on-demand during a run via the `cfcf clio` CLI verbs. Backend code lives behind a `MemoryBackend` interface so a future remote-Cerefox adapter can swap in cleanly. Full design: [`docs/design/clio-memory-layer.md`](./clio-memory-layer.md).

```typescript
// Two-tier memory access
interface PerWorkspaceMemory {
  // Repo-anchored — context-assembler reads cfcf-docs/ files directly
  // and writes per-iteration archives back into the repo.
  storeAgentLogs(workspaceId: string, iterationNum: number, role: AgentRole, logs: string): Promise<string>;
  getAgentLogs(workspaceId: string, iterationNum: number, role: AgentRole): Promise<string>;
}

interface MemoryBackend {
  // Cross-workspace Clio. v1: LocalClio (SQLite). Future: CerefoxRemote.
  search(req: SearchRequest): Promise<SearchResponse>;
  ingest(doc: IngestRequest): Promise<IngestResult>;
  getDocument(id: string): Promise<ClioDocument>;
  listProjects(): Promise<ClioProject[]>;
  // ... versions, restore, audit, metadata-search
}
```

### 4.9 Notification System

Alerts the user when attention is needed.

**Trigger events:**
- Iteration completed (configurable)
- Workspace completed (success or failure)
- User input needed (detected via signal files)
- Pause cadence reached

**Channels:**
- Terminal notification (bell + message), CLI status display
- Web GUI activity feed (shipped iter-4)
- macOS / Linux desktop notifications (via per-OS hooks where available)
- Future: Slack, email, webhook

### 4.10 Agent Adapters

Plugin interface for different AI coding agents. Two adapters ship today: `claude-code` and `codex`. Source of truth: `packages/core/src/types.ts`.

```typescript
interface AgentAdapter {
  /** Unique identifier: "claude-code", "codex", etc. */
  name: string;

  /** Human-readable display name */
  displayName: string;

  /** Check if the agent CLI is installed and authenticated */
  checkAvailability(): Promise<AgentAvailability>;

  /** Agent-specific flags for unattended execution */
  unattendedFlags(): string[];

  /** Build the command + args to run the agent non-interactively */
  buildCommand(workspacePath: string, prompt: string, model?: string): { command: string; args: string[] };

  /** The filename this agent uses for its instruction file (e.g., "CLAUDE.md") */
  instructionFilename: string;
}

interface AgentAvailability {
  available: boolean;
  version?: string;
  error?: string;
}
```

The instruction-file content is generated centrally by `context-assembler.generateInstructionContent()` and written to whatever filename the adapter declares — Claude Code reads `CLAUDE.md`, Codex reads `AGENTS.md`. Both receive the same content. A third adapter is on the F.1 backlog but not shipped.

### 4.11 First-Run Configuration

On first execution (detected by absence of config file), cfcf runs an interactive setup:

1. **Agent detection**: cfcf runs `checkAvailability()` for all supported agent adapters (Claude Code, Codex). Reports which agents are installed and authenticated.
2. **Dependency check**: Verify git is available.
3. **User prompts**: Ask the user to configure defaults for each role:
   - Dev agent and model (from detected available agents)
   - Judge agent and model (encouraged to be different from dev agent)
   - Solution Architect agent and model (recommended: a frontier model like opus)
   - Reflection agent and model (defaults to the architect adapter)
   - Documenter agent and model (recommended: strong writing model)
   - Help Assistant agent and model (defaults to dev)
   - Product Architect agent and model (defaults to dev)
   - Clio embedder pick (with inline HuggingFace download + progress bar)
   - Default max iterations
   - Default pause cadence
4. **Permission acknowledgment**: cfcf explains that agents will run with `--dangerously-skip-permissions` (or equivalent) for unattended operation. Lists the default guardrails (working directory scoping, read-only file enforcement, git branch isolation). User must acknowledge.
5. **Store config**: Write cfcf's own config file to the platform-standard config directory. No sudo required.

If the user deletes the config file, cfcf treats it as a fresh installation and reruns setup.

**Config file location**: cfcf stores its config in a `cfcf/` subdirectory under the platform's standard config path:
- Linux: `~/.config/cfcf/config.json` (per XDG Base Directory Specification)
- macOS: `~/Library/Application Support/cfcf/config.json`
- Windows: `%APPDATA%/cfcf/config.json`
- Override: `CFCF_CONFIG_DIR` env var

This is cfcf's own directory -- not shared with any other application.

---

## 5. Data Flow: One Complete Iteration

```
Iteration N starts
      │
      ▼
cfcf Server (Iteration Controller)
  │
  ├─► Context Assembler:
  │     Read: Problem Pack, per-iteration archives, judge assessment, user feedback,
  │           Clio top-k for problem.md
  │     Write to repo: CLAUDE.md / AGENTS.md (sentinel-merged), cfcf-docs/ files
  │           (iteration-history, judge-assessment, clio-relevant, clio-guide, …)
  │
  ├─► Git Manager: create cfcf/iteration-N branch if needed, ensure clean state
  │
  ├─► Process Manager: spawn dev agent
  │     Command: per AgentAdapter.buildCommand(...)
  │     CWD: /path/to/workspace
  │     ├─► Log Collector: stream stdout/stderr → ~/.cfcf/logs/<ws>/iteration-N-dev.log
  │     └─► Wait for exit
  │
  ├─► Collect dev results:
  │     Read: cfcf-docs/iteration-handoff.md
  │     Read: cfcf-docs/cfcf-iteration-signals.json
  │     Run:  git diff
  │
  ├─► Git Manager: commit #1 — "cfcf iteration N dev (<summary>)"
  │
  ├─► Process Manager: spawn judge agent
  │     CWD: /path/to/workspace (same repo, can inspect everything)
  │     ├─► Log Collector: stream → ~/.cfcf/logs/<ws>/iteration-N-judge.log
  │     └─► Wait for exit
  │
  ├─► Collect judge results:
  │     Read: cfcf-docs/iteration-reviews/iteration-N.md
  │     Read: cfcf-docs/cfcf-judge-signals.json
  │
  ├─► Git Manager: commit #2 — "cfcf iteration N judge (<determination>)"
  │
  ├─► (Conditional) Process Manager: spawn reflection agent
  │     Skipped when judge sets reflection_needed=false AND consecutive
  │     skip count < workspace.reflectSafeguardAfter (default 3).
  │     ├─► Log Collector: stream → ~/.cfcf/logs/<ws>/iteration-N-reflection.log
  │     └─► Wait for exit
  │
  ├─► (Conditional) Collect reflection results:
  │     Read: cfcf-docs/reflection-reviews/iteration-N.md
  │     Read: cfcf-docs/cfcf-reflection-signals.json
  │     plan-validation: revert plan.md rewrite if completed [x] or
  │     iteration headers were lost.
  │
  ├─► (Conditional) Git Manager: commit #3 —
  │     "cfcf iteration N reflect (<health>): <key_observation>"
  │
  ├─► Clio: auto-ingest reflection-analysis, architect-review,
  │     tagged decision-log entries, iteration-summary
  │     (per workspace.clio.ingestPolicy; default "summaries-only")
  │
  ├─► Iteration Controller: map signals to decision
  │     ├─ reflection.recommend_stop=true → pause, notify user
  │     ├─ judge.determination=SUCCESS → stop iterating, run documenter (if configured), notify
  │     ├─ judge.determination=PROGRESS → loop to next iteration
  │     ├─ judge.determination=STALLED → apply onStalled policy (continue/stop/alert)
  │     ├─ judge.determination=ANOMALY → alert user, wait
  │     ├─ user_input_needed=true → pause, wait for responses
  │     └─ pauseEvery reached → pause, wait for ResumeAction
  │
  └─► SSE: emit events to CLI + web UI throughout
```

---

## 6. Server Architecture

### 6.1 Single-Process Event-Driven

The cfcf server is a single Bun/Hono process. Agent processes are spawned as child processes. Everything is async.

**Why this works:**
- Spawning child processes is non-blocking in Bun
- Log streaming from child processes is natively async
- Hono handles concurrent HTTP requests efficiently
- SSE streaming is natively supported
- Single-workspace-at-a-time execution today — no concurrency concerns within the iteration loop

The CLI auto-starts the server on first command if it isn't already running (`cfcf server start` for explicit control). The server writes a PID file at `~/.cfcf/server.pid` for graceful shutdown.

### 6.2 Future: Worker Threads for Multi-Workspace

Each workspace's iteration loop could run in a Bun Worker thread. The main thread handles HTTP/SSE.

---

## 7. Git Strategy

### 7.1 Branch Model

```
main (or user's default branch)
  │
  ├── cfcf/iteration-1     (feature branch for iteration 1)
  │     ├── cfcf iteration 1 dev (<summary>)
  │     ├── cfcf iteration 1 judge (<determination>)
  │     ├── cfcf iteration 1 reflect (<health>): <key_observation>   ← optional
  │     └── merged to main via PR or direct merge after iteration completes
  │
  ├── cfcf/iteration-2     (feature branch for iteration 2, branched from updated main)
  │     ├── cfcf iteration 2 dev (...)
  │     ├── cfcf iteration 2 judge (...)
  │     ├── cfcf iteration 2 reflect (...)                            ← optional
  │     └── merged to main after iteration completes
  │
  └── ...
```

- Each iteration gets its own **feature branch** off main (or the base branch).
- Up to **three commits per iteration**: `dev`, `judge`, `reflect`. Reflection only commits when it ran (i.e. judge did not set `reflection_needed: false`, or the safeguard ceiling was reached).
- When an iteration completes normally: the branch is merged to main. **Merge strategy is configurable per workspace** (`mergeStrategy: 'auto' | 'pr'`):
  - **Auto-merge** (default, "dark factory" mode): cfcf merges directly to main after the judge says PROGRESS or SUCCESS. Fully unattended. The user's review gate is `pauseEvery`, not the git merge step. Optional `cleanupMergedBranches` deletes `cfcf/iteration-N` after auto-merge.
  - **PR-based**: cfcf creates a pull request instead of merging. The user (or team) reviews and merges manually.
- On success (all iterations complete): the final merge to main represents the completed work.
- On failure/anomaly: the feature branch remains unmerged. The user can inspect, continue, or discard.

### 7.2 Between Iterations

- After iteration N completes and its branch is merged to main, iteration N+1 branches off the updated main.
- cfcf regenerates CLAUDE.md and cfcf-docs/ managed files at the start of each iteration.
- If an iteration exits abnormally (anomaly, user stop), the next iteration can continue on the same branch or start a new one (cfcf decides based on the situation).

### 7.3 Judge Assessment Archiving

cfcf mission control manages judge assessment files in the repo:
- After each iteration, the current judge assessment is moved to `cfcf-docs/iteration-reviews/iteration-N.md` (archived with iteration number).
- The latest assessment is also available at `cfcf-docs/judge-assessment.md` for the next dev agent to read.
- All signal files (`cfcf-iteration-signals.json`, `cfcf-judge-signals.json`) are tracked in git -- they are part of the iteration record.

### 7.4 Push Strategy

- **During run**: Commits are local only. No push overhead per iteration.
- **On success**: cfcf pushes the cfcf branch to remote.
- **On demand**: the user pushes at any time using their normal git workflow.
- **On failure**: User decides. The branch exists locally and can be pushed, inspected, or deleted.

---

## 8. Key Interfaces and Type Definitions (Sketch)

```typescript
// --- Core types ---

interface Workspace {
  id: string;
  config: WorkspaceConfig;
  status: 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped';
  currentIteration: number;
  maxIterations: number;
  iterations: IterationRecord[];
  startedAt?: Date;
  completedAt?: Date;
}

interface IterationRecord {
  number: number;
  status: 'preparing' | 'dev_executing' | 'judging' | 'completed';
  startedAt: Date;
  completedAt?: Date;
  devExitCode?: number;
  judgeExitCode?: number;
  signals?: DevSignals;
  judgeSignals?: JudgeSignals;
  summary?: string;
}

interface DevSignals {
  status: 'completed' | 'partial' | 'blocked';
  userInputNeeded: boolean;
  questions?: string[];
  testsPassed?: number;
  testsFailed?: number;
  testsTotal?: number;
  selfAssessment: 'high' | 'medium' | 'low';
  blockers?: string[];
}

interface JudgeSignals {
  determination: 'SUCCESS' | 'PROGRESS' | 'STALLED' | 'ANOMALY';
  anomaly_type?: 'token_exhaustion' | 'user_input_needed' | 'circling' | 'no_changes' | 'regression';
  quality_score: number;  // 1-10
  should_continue: boolean;
  user_input_needed: boolean;
  key_concern?: string;
  reflection_needed?: boolean;     // judge opt-out for reflection
  reflection_reason?: string;
}

interface ArchitectSignals {
  readiness: 'READY' | 'NEEDS_REFINEMENT' | 'BLOCKED' | 'SCOPE_COMPLETE';
  gaps: string[];
  suggestions: string[];
  risks: string[];
  recommended_approach?: string;
}

interface ReflectionSignals {
  iteration: number;
  plan_modified: boolean;
  iteration_health: 'converging' | 'stable' | 'stalled' | 'diverging' | 'inconclusive';
  key_observation: string;
  recommend_stop?: boolean;
  // Set ONLY when invoked via the consult_reflection resume action (item 6.25)
  harness_action_recommendation?: 'continue' | 'finish_loop' | 'stop_loop_now' | 'pause_for_user';
}

type ResumeAction =
  | 'continue'
  | 'finish_loop'
  | 'stop_loop_now'
  | 'refine_plan'
  | 'consult_reflection';

// --- Events (SSE) ---

type CfcfEvent =
  | { type: 'iteration.started'; iteration: number }
  | { type: 'iteration.log'; line: string; source: 'dev' | 'judge' | 'reflection' }
  | { type: 'iteration.dev_completed'; iteration: number; exitCode: number }
  | { type: 'iteration.judge_completed'; iteration: number; determination: string }
  | { type: 'iteration.reflection_completed'; iteration: number; health: string }
  | { type: 'workspace.paused'; reason: 'cadence' | 'anomaly' | 'user_input_needed' | 'recommend_stop'; questions?: string[] }
  | { type: 'workspace.resumed'; action: ResumeAction }
  | { type: 'workspace.completed'; status: 'success' | 'failure' | 'stopped' }
  | { type: 'workspace.loop_stopped'; reason: string }
  | { type: 'alert'; message: string };
```

---

## 9. Token Tracking

cfcf does not call LLM APIs directly -- it spawns agent CLI processes. This makes token tracking challenging.

**Approaches to explore:**

1. **Agent-reported**: Some agents (Claude Code, Codex) display token usage in their output or session summary. cfcf can parse this from agent logs. Fragile but free.
2. **Cost estimation**: cfcf knows which model is configured and can estimate based on the size of context files + generated output. Very approximate.
3. **Agent telemetry APIs**: If agents expose usage data (e.g., via a file, env var, or API after session ends), cfcf can read it. Agent-specific.
4. **Provider dashboard**: The user checks their Anthropic/OpenAI dashboard. Not automated but always accurate.

**Today:** Parse token info from agent logs where available. Track as best-effort metadata, not a hard dependency.

---

## 10. Chief-Subagent Architecture (Future Vision)

The long-term goal is a coordinator pattern where cfcf's iteration model evolves:

**Today:** Single dev agent execution per iteration, followed by judge and (conditional) reflection.

```
cfcf → spawn dev agent → agent works → agent exits → cfcf spawns judge → done
```

**Future:** Chief agent orchestrates sub-agents within an iteration.

```
cfcf → spawn chief agent
         ├─► chief reads context, formulates plan
         ├─► chief invokes cfcf CLI to spawn sub-agent A (coder)
         │     └─► sub-agent A works on task 1, reports back to chief
         ├─► chief invokes cfcf CLI to spawn sub-agent B (coder)
         │     └─► sub-agent B works on task 2, reports back to chief
         ├─► chief reviews results, runs e2e tests
         ├─► chief decides: spawn more sub-agents or finish
         ├─► chief produces handoff document
         └─► chief exits
cfcf → spawn judge → done
```

**Key implications for current design:**
- cfcf CLI must support sub-commands that the chief agent can invoke (e.g., `cfcf spawn-sub-agent --role coder --task "implement module X"`)
- Communication between chief and sub-agents: via files in the repo (structured message files) or via cfcf's API
- cfcf manages sub-agent process lifecycles on behalf of the chief
- The iteration is still a single unit from cfcf's perspective -- it just takes longer and involves multiple agents internally
- Token window problem is solved: chief holds the big picture, sub-agents get focused tasks with minimal context

**This does not change today's architecture.** But the process manager, signal file system, and CLI are designed with this evolution in mind.

---

## 11. Open Technical Questions

### 11.1 Agent non-interactive execution

How exactly does each agent run non-interactively? Critical validations needed:
- Claude Code: `claude --dangerously-skip-permissions -p "your prompt"` -- does it work? What are exit codes?
- Codex: `codex -a never exec -s danger-full-access "your prompt"` -- headless exec mode with full access
- What happens when agents hit token limits? Do they exit cleanly? What's in the logs?

### 11.2 Log streaming and capture

- How much data does a typical agent session produce?
- Can we tee stdout/stderr to CLI display + disk file simultaneously?
- Do we need log rotation for very long iterations?

### 11.3 Web GUI framework

- React served as static files from Hono (bundle embedded into the compiled binary at build time)
- Vite for development, static build for production
- SSE client for real-time updates
- Shipped in iteration 4. Editable global settings shipped in 5.9. Editable per-workspace settings shipped in 6.14. Contextual pause-action button matrix shipped in 6.25.

### 11.4 Process isolation between dev agent and judge

Both run in the same repo directory. The judge runs after the dev agent, so there's no concurrent access issue. But:
- Should the judge be able to modify files? (Probably yes -- it writes its assessment and signals)
- Should cfcf commit the dev agent's work BEFORE running the judge? (Yes -- so the judge sees a clean diff and the judge's own file writes don't pollute the dev commit)

### 11.5 Agent availability detection

cfcf needs to verify that configured agents are installed and authenticated before starting iteration. Each adapter implements `checkAvailability()`. What does this look like for each agent? (e.g., `claude --version`, `codex --version`, checking for API keys in env)

---

*This document will evolve as we validate assumptions and make implementation decisions.*
