# cfcf: Technical Design

*cfcf and cf² are used interchangeably. Both are pronounced "cf square." `cfcf` in code; cf² in docs.*

**Status:** Draft
**Date:** April 2026
**Authors:** Fotis Stamatelopoulos, Claude
**Related Documents:** cfcf Requirements & Vision, cfcf Tech Stack, Agent Process & Context, Development Plan

---

## 1. Purpose

This document describes the high-level technical architecture of cfcf: how the components fit together, what the data flows look like, and what the key interfaces are. It bridges the gap between the functional requirements (vision doc) and the implementation plan.

---

## 2. Execution Model: Local Process, Not Containers

### 2.1 The Decision

cfcf v0.1 runs agents as **local processes** in the user's normal development environment -- not inside Docker containers.

### 2.2 Rationale

| Concern | Container approach | Local process approach |
|---------|-------------------|----------------------|
| Agent authentication | Must inject API keys, SSH keys, agent CLI auth into container. Complex setup per agent. | Reuses user's existing authenticated agents. Zero setup. |
| Git credentials | Must inject SSH keys or tokens. User must configure per-project. | Reuses user's existing git auth. |
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
3. **Working directory scoping**: The agent is instructed (via CLAUDE.md / equivalent) to only modify files within the project directory.
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
│  │  (cfcf)  │                 │                                  │  │
│  └──────────┘                 │  ┌────────────┐ ┌─────────────┐  │  │
│                               │  │  Project   │ │  Process    │  │  │
│  ┌──────────┐    HTTP/SSE     │  │  Manager   │ │  Manager    │  │  │
│  │  Web GUI │◄───────────────►│  └─────┬──────┘ └──────┬──────┘  │  │
│  │  (React) │                 │        │               │         │  │
│  └──────────┘                 │  ┌─────┴──────┐ ┌──────┴──────┐  │  │
│                               │  │ Iteration  │ │  Log        │  │  │
│                               │  │ Controller │ │  Collector  │  │  │
│                               │  └─────┬──────┘ └──────┬──────┘  │  │
│                               │        │               │         │  │
│                               │  ┌─────┴──────┐ ┌──────┴──────┐  │  │
│                               │  │  Context   │ │  Judge      │  │  │
│                               │  │  Assembler │ │  Runner     │  │  │
│                               │  └─────┬──────┘ └─────────────┘  │  │
│                               │        │                         │  │
│                               │  ┌─────┴───────┐                 │  │
│                               │  │  Memory     │                 │  │
│                               │  │  Layer      │                 │  │
│                               │  └─────────────┘                 │  │
│                               └──────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Project Working Directory    (git repo, local clone)        │   │
│  │    /path/to/project/                                         │   │
│  │      src/                     (user's source code)           │   │
│  │      cfcf-docs/               (cfcf-managed context files)   │   │
│  │      CLAUDE.md                (agent instructions, generated)│   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  ~/.cfcf/                   (cfcf home - external memory)    │   │
│  │    projects/<id>/iterations/001/agent-logs.txt               │   │
│  │    projects/<id>/knowledge/lessons-learned.md                │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Remote Git Repo (GitHub)   (source of truth, push on commit)│   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. Core Components

### 4.1 cfcf Server

The central process. Always running on localhost. Manages everything.

**Responsibilities:**
- Exposes REST API for CLI (project CRUD, iteration lifecycle, configuration)
- Exposes SSE endpoints for real-time event streaming (logs, status updates, alerts)
- Manages project state and iteration state
- Orchestrates the iteration loop
- Dispatches notifications
- Serves the web GUI (future, not in Iteration 0)

**Framework:** Hono on Bun.

**Key API endpoints (sketch):**

```
# Project management
POST   /api/projects                    # Create/register project
GET    /api/projects                    # List projects
GET    /api/projects/:id                # Get project details
PUT    /api/projects/:id/config         # Update project config

# Iteration lifecycle
POST   /api/projects/:id/iterate               # Execute the next iteration
POST   /api/projects/:id/pause                 # Pause iteration loop
POST   /api/projects/:id/resume                # Resume (with optional feedback)
POST   /api/projects/:id/stop                  # Stop iterating

# Solution Architect review (user-invoked, advisory)
POST   /api/projects/:id/review                # Spawn architect agent (202 Accepted)
GET    /api/projects/:id/review/status          # Review status (poll)

# Iterate (async -- returns immediately, runs in background)
POST   /api/projects/:id/iterate               # Start next iteration (202 Accepted)
GET    /api/projects/:id/iterations/latest      # Latest iteration status
GET    /api/projects/:id/iterations/:n/status   # Iteration status (poll for progress)
GET    /api/projects/:id/iterations/:n/logs     # SSE log stream (live or historical)
```

### 4.2 Project Manager

Manages the lifecycle and configuration of projects.

**Project configuration (config.json):**

```typescript
interface ProjectConfig {
  id: string;
  name: string;
  repoPath: string;                // Local path to the git repo
  repoUrl?: string;                // Remote git repo URL (for push)
  devAgent: AgentConfig;           // Dev agent configuration
  judgeAgent: AgentConfig;         // Judge agent configuration
  architectAgent: AgentConfig;     // Solution Architect (pre-iteration review)
  maxIterations: number;           // Hard cap on iterations per project
  currentIteration: number;        // Current iteration number (monotonically increasing, starts at 0)
  pauseEvery: number;              // 0 = no pauses, N = pause every N iterations
  onStalled: 'continue' | 'stop' | 'alert'; // Behavior when judge says STALLED
  problemPackPath: string;         // Path to the Problem Pack directory
}

interface AgentConfig {
  adapter: string;                 // Plugin name: "claude-code", "codex", etc.
  model?: string;                  // Model override (e.g., "opus", "sonnet", "o3")
  flags?: string[];                // Additional CLI flags
}

// Three agent roles, each independently configurable:
// - devAgent: writes code, runs tests (e.g., claude-code with sonnet)
// - judgeAgent: reviews iterations (e.g., codex)
// - architectAgent: reviews Problem Pack pre-iteration (e.g., claude-code with opus)
```

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
  cwd: string;                     // Project working directory
  env?: Record<string, string>;    // Additional env vars
  logFile: string;                 // Where to write logs
}
```

**Simpler than container management.** No image pulls, no volume mounts, no auth injection. Just `Bun.spawn()` or `child_process.spawn()`.

### 4.4 Iteration Controller

The heart of cfcf. Implements the deterministic iteration loop.

**State machine:**

```
IDLE → PREPARING → EXECUTING_DEV → EXECUTING_JUDGE → DECIDING → PREPARING (loop)
                                                         ↓
                                                    PAUSED (waiting for user)
                                                         ↓
                                                    PREPARING (resume)
                                                         ↓
                                                    COMPLETED / FAILED / STOPPED
```

**Per-iteration flow:**

```typescript
async function runIteration(project: Project, iterationNum: number): Promise<IterationResult> {
  // 1. PREPARE
  const context = await contextAssembler.assemble(project, iterationNum);
  await contextAssembler.writeToRepo(project.repoPath, context);
  // Writes: CLAUDE.md, cfcf-docs/iteration-history.md, cfcf-docs/judge-assessment.md, etc.

  // 2. EXECUTE DEV AGENT
  const devProc = await processManager.spawn({
    command: devAdapter.command,           // e.g., "claude"
    args: devAdapter.buildArgs(context),   // e.g., ["--dangerously-skip-permissions", "-p", "..."]
    cwd: project.repoPath,
    logFile: memoryLayer.logPath(project.id, iterationNum, 'dev'),
  });
  const logStream = processManager.streamLogs(devProc);
  await logCollector.capture(logStream, project.id, iterationNum);
  const devExit = await processManager.waitForExit(devProc);

  // 3. COLLECT RESULTS
  const handoff = await parseHandoffDocument(project.repoPath + '/cfcf-docs/iteration-handoff.md');
  const signals = await parseSignalFile(project.repoPath + '/cfcf-docs/cfcf-iteration-signals.json');
  const diff = await gitManager.getDiff(project.repoPath);

  // 4. COMMIT
  await gitManager.commitAll(project.repoPath, `cfcf iteration ${iterationNum}`);
  // Push to remote deferred -- only on success or on demand

  // 5. EXECUTE JUDGE AGENT
  const judgeProc = await processManager.spawn({
    command: judgeAdapter.command,          // e.g., "codex" (different agent)
    args: judgeAdapter.buildArgs({ handoff, diff, project, iterationNum }),
    cwd: project.repoPath,
    logFile: memoryLayer.logPath(project.id, iterationNum, 'judge'),
  });
  await processManager.waitForExit(judgeProc);
  const judgeResult = await parseJudgeAssessment(
    project.repoPath + '/cfcf-docs/iteration-reviews/iteration-' + iterationNum + '.md'
  );

  // 6. STORE
  await memoryLayer.storeIteration(project.id, iterationNum, {
    handoff, judgeResult, diff, signals,
  });

  return { exitCode: devExit.exitCode, handoff, judgeResult, signals };
}
```

### 4.5 Context Assembler

Builds and writes the context files into the repo before each iteration.

**Inputs:**
- Project Problem Pack (static files from user)
- Iteration history from memory layer
- Previous judge assessment
- User feedback (if any)
- Agent adapter (determines instruction file format)

**Outputs written to repo:**
- CLAUDE.md (or agent equivalent) -- regenerated fresh each iteration
- cfcf-docs/ folder contents -- mix of static (copied) and dynamic (generated) files

**Tiered context strategy:**

```
Tier 1 - MUST READ (~500 words, always included in CLAUDE.md directly):
  - Problem summary (compressed from problem.md)
  - Current plan status (from plan.md, last 5-10 lines)
  - Last judge assessment (compressed)
  - Iteration directive ("this iteration, focus on X")

Tier 2 - SHOULD READ (~2000 words, separate files, agent reads if needed):
  - cfcf-docs/iteration-history.md (aggressively compressed)
  - cfcf-docs/decision-log.md (summarized, recent entries in full)
  - cfcf-docs/user-feedback.md

Tier 3 - REFERENCE ONLY (full files, agent reads on demand):
  - cfcf-docs/problem.md (full problem definition)
  - cfcf-docs/success.md (full success criteria)
  - cfcf-docs/constraints.md, hints.md, style-guide.md
  - cfcf-docs/context/ (architecture docs, API specs)
  - cfcf-docs/iteration-logs/ (detailed per-iteration logs)
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

### 4.7 Signal Files (Machine-Readable Communication)

Agents communicate structured decisions to cfcf via JSON signal files. These complement the human-readable Markdown documents.

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
  "key_concern": "Error handling is incomplete but improving"
}
```

cfcf parses these JSON files for deterministic decision-making. The Markdown documents are for humans and for context in future iterations.

### 4.8 Memory Layer

For v0.1, **all cfcf-generated files live in the repo** under `cfcf-docs/`. This includes iteration history, judge assessments, decision logs, signal files, and the evolving plan. Everything is tracked in git -- the repo IS the memory layer.

cfcf also keeps a **local backup** of agent logs (stdout/stderr) under `~/.cfcf/` since these can be very large and shouldn't bloat the repo. But all structured context is in the repo.

An external persistent memory layer (like `~/.cfcf/projects/...` or Cerefox) is a future extension. The need for it will appear organically as we evolve cfcf. For now, keeping everything in the repo is simpler, more transparent, and avoids premature optimization.

```typescript
// Simplified for v0.1 -- repo is the source of truth
interface MemoryLayer {
  // Log storage (outside repo, under ~/.cfcf/)
  storeAgentLogs(projectId: string, iterationNum: number, role: 'dev' | 'judge', logs: string): Promise<string>;
  getAgentLogs(projectId: string, iterationNum: number, role: 'dev' | 'judge'): Promise<string>;

  // Context assembly reads from repo files directly
  // No separate storage interface needed for v0.1
}
```

### 4.9 Notification System

Alerts the user when attention is needed.

**Trigger events:**
- Iteration completed (configurable)
- Project completed (success or failure)
- User input needed (detected via signal files)
- Pause cadence reached

**Channels (incremental):**
- v0.1: Terminal notification (bell + message), CLI status display
- Future: Web GUI alerts, Slack, email, webhook

### 4.10 Agent Adapters

Plugin interface for different AI coding agents.

```typescript
interface AgentAdapter {
  name: string;                    // "claude-code", "codex", etc.

  // Check if the agent is installed and authenticated
  checkAvailability(): Promise<{ available: boolean; version?: string; error?: string }>;

  // Generate agent-specific instruction file content
  generateInstructionFile(context: AssembledContext): string;

  // Build the command + args to run the agent non-interactively
  buildCommand(workspacePath: string, prompt?: string): { command: string; args: string[] };

  // Parse agent-specific output into structured form (optional)
  parseOutput?(logs: string): AgentOutput;

  // Agent-specific flags for unattended execution
  unattendedFlags(): string[];    // e.g., ["--dangerously-skip-permissions"] for Claude Code
}
```

### 4.11 First-Run Configuration

On first execution (detected by absence of config file), cfcf runs an interactive setup:

1. **Agent detection**: cfcf runs `checkAvailability()` for all supported agent adapters (Claude Code, Codex). Reports which agents are installed and authenticated.
2. **Dependency check**: Verify git is available.
3. **User prompts**: Ask the user to configure defaults:
   - Dev agent and model (from detected available agents)
   - Judge agent and model (encouraged to be different from dev agent)
   - Solution Architect agent and model (recommended: use a frontier model like opus)
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
  │     Read: Problem Pack, memory layer (iteration history, judge assessment, user feedback)
  │     Write to repo: CLAUDE.md, cfcf-docs/ files (history, judge, feedback, signals template)
  │
  ├─► Git Manager: create cfcf branch if needed, ensure clean state
  │
  ├─► Process Manager: spawn dev agent
  │     Command: claude --dangerously-skip-permissions -p "read CLAUDE.md and execute"
  │     CWD: /path/to/project
  │     ├─► Log Collector: stream stdout/stderr → ~/.cfcf/.../agent-logs.txt
  │     └─► Wait for exit
  │
  ├─► Collect results:
  │     Read: cfcf-docs/iteration-handoff.md
  │     Read: cfcf-docs/cfcf-iteration-signals.json
  │     Run:  git diff
  │
  ├─► Git Manager: commit all changes to cfcf branch
  │     (push to remote deferred -- only on success or `cfcf push`)
  │
  ├─► Process Manager: spawn judge agent
  │     Command: codex --approval-mode full-auto "read cfcf-judge-instructions.md and assess"
  │     CWD: /path/to/project (same repo, can inspect everything)
  │     ├─► Log Collector: stream logs → ~/.cfcf/.../judge-logs.txt
  │     └─► Wait for exit
  │
  ├─► Collect judge results:
  │     Read: cfcf-docs/iteration-reviews/iteration-N.md
  │     Read: cfcf-docs/cfcf-judge-signals.json
  │
  ├─► Memory Layer: store iteration data (logs, handoff, judge, diff, signals)
  │
  ├─► Iteration Controller: map signals to decision
  │     ├─ determination=SUCCESS → stop iterating, push to remote, notify user
  │     ├─ determination=PROGRESS → loop to next iteration
  │     ├─ determination=STALLED → apply onStalled policy (continue/stop/alert)
  │     ├─ determination=ANOMALY → alert user, wait
  │     ├─ user_input_needed=true → alert user, wait for responses
  │     └─ pauseEvery reached → alert user, wait for feedback
  │
  └─► SSE: emit events to CLI throughout
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
- Single project execution for v0.1 -- no concurrency concerns

**Graceful degradation:** If the server is not running, `cfcf iterate` can operate in "direct mode" -- running the iteration loop in the foreground CLI process. Useful for development and debugging.

### 6.2 Future: Worker Threads for Multi-Project

Each project's iteration loop could run in a Bun Worker thread. The main thread handles HTTP/SSE.

---

## 7. Git Strategy

### 7.1 Branch Model

```
main (or user's default branch)
  │
  ├── cfcf/iteration-1     (feature branch for iteration 1)
  │     ├── dev work commits
  │     ├── judge assessment commit
  │     └── merged to main via PR or direct merge after iteration completes
  │
  ├── cfcf/iteration-2     (feature branch for iteration 2, branched from updated main)
  │     ├── dev work commits
  │     ├── judge assessment commit
  │     └── merged to main after iteration completes
  │
  └── ...
```

- Each iteration gets its own **feature branch** off main (or the base branch).
- The dev agent works on the feature branch. Multiple commits within an iteration are fine.
- The judge's assessment files are committed on the same branch after the dev commits.
- When an iteration completes normally: the branch is merged to main. **Merge strategy is configurable:**
  - **Auto-merge** (default, "dark factory" mode): cfcf merges directly to main after the judge says PROGRESS or SUCCESS. Fully unattended. The user's review gate is `--pause-every N`, not the git merge step.
  - **PR-based**: cfcf creates a pull request instead of merging. The user (or team) reviews and merges manually. Useful for teams with code review requirements.
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
- **On demand**: `cfcf push` pushes at any time.
- **On failure**: User decides. The branch exists locally and can be pushed, inspected, or deleted.

---

## 8. Key Interfaces and Type Definitions (Sketch)

```typescript
// --- Core types ---

interface Project {
  id: string;
  config: ProjectConfig;
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
  anomalyType?: 'token_exhaustion' | 'user_input_needed' | 'circling' | 'no_changes' | 'regression';
  qualityScore: number;  // 1-10
  shouldContinue: boolean;
  userInputNeeded: boolean;
  keyConcern?: string;
}

// --- Events (SSE) ---

type CfcfEvent =
  | { type: 'iteration.started'; iteration: number }
  | { type: 'iteration.log'; line: string; source: 'dev' | 'judge' }
  | { type: 'iteration.dev_completed'; iteration: number; exitCode: number }
  | { type: 'iteration.judge_completed'; iteration: number; determination: string }
  | { type: 'project.paused'; reason: 'cadence' | 'anomaly' | 'user_input_needed'; questions?: string[] }
  | { type: 'project.completed'; status: 'success' | 'failure' | 'stopped' }
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

**For v0.1:** Parse token info from agent logs where available. Track as best-effort metadata, not a hard dependency.

---

## 10. Chief-Subagent Architecture (Future Vision)

The long-term goal is a coordinator pattern where cfcf's iteration model evolves:

**Current (v0.1):** Single dev agent execution per iteration.

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

**This does not change the v0.1 architecture.** But the process manager, signal file system, and CLI are designed with this evolution in mind.

---

## 11. Open Technical Questions

### 11.1 Agent non-interactive execution

How exactly does each agent run non-interactively? Critical validations needed:
- Claude Code: `claude --dangerously-skip-permissions -p "your prompt"` -- does it work? What are exit codes?
- Codex: `codex --approval-mode full-auto -q "your prompt"` -- equivalent?
- What happens when agents hit token limits? Do they exit cleanly? What's in the logs?

### 11.2 Log streaming and capture

- How much data does a typical agent session produce?
- Can we tee stdout/stderr to CLI display + disk file simultaneously?
- Do we need log rotation for very long iterations?

### 11.3 Web GUI framework

- React served as static files from Hono
- Vite for development, static build for production
- SSE client for real-time updates
- Deferred to Iteration 1+; not in Iteration 0

### 11.4 Process isolation between dev agent and judge

Both run in the same repo directory. The judge runs after the dev agent, so there's no concurrent access issue. But:
- Should the judge be able to modify files? (Probably yes -- it writes its assessment and signals)
- Should cfcf commit the dev agent's work BEFORE running the judge? (Yes -- so the judge sees a clean diff and the judge's own file writes don't pollute the dev commit)

### 11.5 Agent availability detection

cfcf needs to verify that configured agents are installed and authenticated before starting iteration. Each adapter implements `checkAvailability()`. What does this look like for each agent? (e.g., `claude --version`, `codex --version`, checking for API keys in env)

---

*This document will evolve as we validate assumptions and make implementation decisions.*
