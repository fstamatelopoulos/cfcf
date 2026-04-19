# cf² Server API Reference

*cfcf and cf² are used interchangeably. Both are pronounced "cf square." `cfcf` in code; cf² in docs.*

**Base URL:** `http://localhost:7233` (configurable via `CFCF_PORT` env var)

**Format:** All responses are JSON. Errors include an `error` field with a human-readable message.

---

## Health & Status

### GET /api/health

Lightweight health check. Use this to verify the server is running.

**Response:** `200 OK`

```json
{
  "status": "ok",
  "version": "0.0.0",
  "uptime": 42
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | Always `"ok"` |
| `version` | string | cfcf version |
| `uptime` | number | Seconds since server started |

---

### GET /api/status

Detailed server status including configuration state.

**Response:** `200 OK`

```json
{
  "status": "running",
  "version": "0.0.0",
  "uptime": 42,
  "pid": 12345,
  "port": 7233,
  "configured": true,
  "availableAgents": ["claude-code", "codex"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | Always `"running"` (if you got a response, the server is running) |
| `version` | string | cfcf version |
| `uptime` | number | Seconds since server started |
| `pid` | number | Server process ID |
| `port` | number | Port the server is listening on |
| `configured` | boolean | Whether `cfcf init` has been run |
| `availableAgents` | string[] | Agent adapters detected during init (empty if not configured) |

### GET /api/activity

Returns a cross-project list of agent runs that are currently in flight.
Used by the web header to drive the pulsing blue activity indicator and
the "project: phase" label. Added in v0.6.0.

**Response:** `200 OK`

```json
{
  "active": [
    {
      "projectId": "calc-849371",
      "projectName": "calc",
      "type": "iteration",
      "phase": "reflecting",
      "iteration": 3,
      "startedAt": "2026-04-19T01:43:32.931Z"
    },
    {
      "projectId": "other-xyz",
      "projectName": "other",
      "type": "review",
      "startedAt": "2026-04-19T01:44:10.000Z"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `projectId` / `projectName` | string | Project that owns the run |
| `type` | `"iteration" \| "review" \| "document" \| "reflection"` | Kind of run |
| `phase` | `LoopPhase` | Only for `type: "iteration"` — current phase (preparing, dev_executing, judging, reflecting, deciding, documenting) |
| `iteration` | number | Iteration number when applicable |
| `startedAt` | ISO string | When the run started |

Loop-state has priority over raw history.json events: if a project has an
active loop, we emit a single entry for it (with the finer-grained
`phase`) instead of the raw iteration / reflection "running" history rows.

---

## Configuration

### GET /api/config

Returns the current global configuration.

**Response:** `200 OK` (when configured)

```json
{
  "version": 1,
  "devAgent": { "adapter": "claude-code" },
  "judgeAgent": { "adapter": "codex" },
  "architectAgent": { "adapter": "claude-code" },
  "documenterAgent": { "adapter": "claude-code" },
  "reflectionAgent": { "adapter": "claude-code", "model": "opus" },
  "reflectSafeguardAfter": 3,
  "autoReviewSpecs": false,
  "autoDocumenter": true,
  "readinessGate": "blocked",
  "maxIterations": 10,
  "pauseEvery": 0,
  "availableAgents": ["claude-code", "codex"],
  "permissionsAcknowledged": true,
  "notifications": {
    "enabled": true,
    "events": {
      "loop.paused": ["terminal-bell", "macos", "log"],
      "loop.completed": ["terminal-bell", "macos", "log"],
      "agent.failed": ["terminal-bell", "macos", "log"]
    }
  }
}
```

The `notifications` field controls how cfcf notifies the user when
long-running loops need attention. See `docs/guides/cli-usage.md` for
details on channels and events.

**Response:** `404 Not Found` (when not configured)

```json
{
  "error": "Not configured. Run 'cfcf init' to set up."
}
```

---

## Projects

### POST /api/projects

Create a new project.

**Request body:**

```json
{
  "name": "my-web-app",
  "repoPath": "/Users/fotis/src/my-web-app",
  "repoUrl": "https://github.com/user/my-web-app.git"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Project name |
| `repoPath` | Yes | Absolute path to a local git repository |
| `repoUrl` | No | Remote git URL (for push) |
| `devAgent` | No | Override dev agent config (defaults from global config) |
| `judgeAgent` | No | Override judge agent config |
| `maxIterations` | No | Override max iterations |
| `pauseEvery` | No | Override pause cadence |

**Response:** `201 Created`

```json
{
  "id": "my-web-app-a1b2c3",
  "name": "my-web-app",
  "repoPath": "/Users/fotis/src/my-web-app",
  "devAgent": { "adapter": "claude-code" },
  "judgeAgent": { "adapter": "codex" },
  "maxIterations": 10,
  "pauseEvery": 0,
  "onStalled": "alert",
  "mergeStrategy": "auto",
  "processTemplate": "default"
}
```

**Error:** `400` if name/repoPath missing or repoPath is not a git repo.

---

### GET /api/projects

List all projects.

**Response:** `200 OK` -- Array of project configs, sorted by name.

---

### GET /api/projects/:id

Get a project by ID or name (case-insensitive name match supported).

**Response:** `200 OK` -- Project config object.

**Error:** `404` if not found.

---

### PUT /api/projects/:id

Update project configuration fields (partial update).

**Response:** `200 OK` -- Updated project config.

---

### DELETE /api/projects/:id

Delete a project (removes config only, does not touch the repo).

**Response:** `200 OK` -- `{ "deleted": true }`

---

## Iterate

### POST /api/projects/:id/iterate

Execute the next iteration within a project. Two modes:

**Agent mode** (no `command` field): reads Problem Pack, assembles context (CLAUDE.md + cfcf-docs/), launches configured dev agent, parses handoff + signal file.

**Manual mode** (`command` field provided): runs the specified command directly (for testing/debugging).

**Request body (agent mode):**

```json
{}
```

Or with custom Problem Pack path:

```json
{
  "problemPackPath": "/path/to/custom/problem-pack"
}
```

**Request body (manual mode):**

```json
{
  "command": "npm",
  "args": ["test"]
}
```

**Response:** `202 Accepted` -- Iteration starts asynchronously.

```json
{
  "iteration": 1,
  "branch": "cfcf/iteration-1",
  "mode": "agent",
  "status": "preparing",
  "logFile": "/Users/fotis/.cfcf/logs/my-web-app-a1b2c3/iteration-001-dev.log",
  "message": "Iteration started. Poll GET /api/projects/:id/iterations/:n/status for progress."
}
```

The iteration runs in the background. Use the status and logs endpoints to track progress.

---

### GET /api/projects/:id/iterations/:n/status

Get the current status of an iteration.

**Response:** `200 OK`

```json
{
  "iteration": 1,
  "projectId": "my-web-app-a1b2c3",
  "projectName": "my-web-app",
  "branch": "cfcf/iteration-1",
  "mode": "agent",
  "status": "completed",
  "startedAt": "2026-04-12T05:16:00.000Z",
  "completedAt": "2026-04-12T05:17:30.000Z",
  "exitCode": 0,
  "durationMs": 90000,
  "logFile": "/Users/fotis/.cfcf/logs/my-web-app-a1b2c3/iteration-001-dev.log",
  "committed": true,
  "killed": false,
  "handoffReceived": true,
  "signalsReceived": true,
  "signals": {
    "iteration": 1,
    "agent": "claude-code",
    "status": "completed",
    "self_assessment": "high",
    "tests_passed": 7,
    "tests_failed": 0,
    "tests_total": 7
  }
}
```

| Status | Description |
|--------|-------------|
| `preparing` | Context assembly, writing files |
| `executing` | Agent process is running |
| `collecting` | Agent finished, parsing results |
| `completed` | Iteration done successfully |
| `failed` | Iteration failed (see `error` field) |

---

### GET /api/projects/:id/iterations/latest

Get the status of the most recent iteration for a project.

Same response format as `/iterations/:n/status`.

---

### GET /api/projects/:id/iterations/:n/logs

SSE stream of log events for a completed iteration (the dev agent log). Tails the file if the iteration is still active.

**Events:**
- `event: log` -- Log line from agent output
- `event: done` -- Stream complete
- `event: error` -- Error reading logs

---

### GET /api/projects/:id/logs/:filename

Generic SSE log streaming by filename. Used for architect / documenter / judge logs and any other file under the project's log directory.

The server detects if the log belongs to a live agent run (iteration in progress, review in progress, etc.) and tails the file accordingly. For completed runs, reads the file once and closes the stream.

**Examples:**
- `/api/projects/my-app/logs/iteration-001-dev.log`
- `/api/projects/my-app/logs/iteration-001-judge.log`
- `/api/projects/my-app/logs/architect-001.log`
- `/api/projects/my-app/logs/documenter-001.log`

**Events:** same as above (`log`, `done`, `error`).

**Security:** the filename must not contain path separators or `..`, and must end with `.log`. Otherwise returns 400.

---

### GET /api/projects/:id/history

Returns the project's history events array. Each event represents an agent invocation (review, iteration, document). History persists across loop restarts — unlike `loop-state.json` which resets on each `startLoop`.

**Response:** `200 OK`

```json
[
  {
    "id": "a1b2c3d4e5f67890",
    "type": "review",
    "status": "completed",
    "startedAt": "2026-04-16T10:15:00.000Z",
    "completedAt": "2026-04-16T10:17:30.000Z",
    "logFile": "architect-001.log",
    "agent": "claude-code",
    "model": "opus",
    "readiness": "READY",
    "signals": {
      "readiness": "READY",
      "gaps": [],
      "suggestions": ["Consider adding rate-limit acceptance tests"],
      "risks": ["External API dependency"],
      "recommended_approach": "Start with the happy path, add edge cases in later iterations."
    }
  },
  {
    "id": "b2c3d4e5f6789012",
    "type": "iteration",
    "status": "completed",
    "startedAt": "2026-04-16T10:20:00.000Z",
    "completedAt": "2026-04-16T10:30:00.000Z",
    "iteration": 1,
    "branch": "cfcf/iteration-1",
    "logFile": "iteration-001-dev.log",
    "devLogFile": "iteration-001-dev.log",
    "judgeLogFile": "iteration-001-judge.log",
    "agent": "codex",
    "devAgent": "codex",
    "judgeAgent": "claude-code",
    "devExitCode": 0,
    "judgeExitCode": 0,
    "judgeDetermination": "PROGRESS",
    "judgeQuality": 7,
    "merged": true,
    "devSignals": { "agent": "codex", "status": "completed", "self_assessment": "high", "tests_run": true, "tests_passed": 5, "tests_total": 5 },
    "judgeSignals": { "determination": "PROGRESS", "quality_score": 7, "tests_verified": true, "tests_passed": 5, "tests_total": 5, "should_continue": true, "reflection_needed": false }
  },
  {
    "id": "d4e5f67890123456",
    "type": "reflection",
    "status": "completed",
    "startedAt": "2026-04-16T10:30:05.000Z",
    "completedAt": "2026-04-16T10:31:20.000Z",
    "logFile": "reflection-001.log",
    "agent": "claude-code",
    "iteration": 1,
    "trigger": "loop",
    "signals": {
      "iteration": 1,
      "plan_modified": false,
      "iteration_health": "stable",
      "key_observation": "First iteration delivered a clean base; no strategic shift needed.",
      "recommend_stop": false
    },
    "iterationHealth": "stable",
    "planModified": false
  },
  {
    "id": "c3d4e5f678901234",
    "type": "document",
    "status": "completed",
    "startedAt": "2026-04-16T10:32:00.000Z",
    "completedAt": "2026-04-16T10:34:00.000Z",
    "logFile": "documenter-001.log",
    "agent": "claude-code"
  }
]
```

Events are returned in insertion order (chronological). Clients should sort if a different order is needed.

**Event types:**

| `type` | Emitted by | Relevant fields |
|--------|-----------|-----------------|
| `review` | Solution Architect run | `readiness`, `signals` (parsed `ArchitectSignals`) |
| `iteration` | Iteration loop | `iteration`, `branch`, `devLogFile`, `judgeLogFile`, `devExitCode`, `judgeExitCode`, `judgeDetermination`, `judgeQuality`, `merged`, `devSignals`, `judgeSignals` |
| `reflection` | Reflection runner (loop or ad-hoc) | `iteration`, `trigger` (`"loop"` or `"manual"`), `signals`, `iterationHealth`, `planModified`, `planRejectionReason` (when applicable) |
| `document` | Documenter run | `docsFileCount`, `committed`, `exitCode` |

---

## Solution Architect Review

### POST /api/projects/:id/review

Start a Solution Architect review of the Problem Pack. User-invoked, advisory, repeatable. The architect reviews the problem definition, identifies gaps, and produces an initial plan outline.

**Request body (optional):**

```json
{
  "problemPackPath": "/path/to/custom/problem-pack"
}
```

**Response:** `202 Accepted`

```json
{
  "projectId": "my-web-app-a1b2c3",
  "status": "preparing",
  "logFile": "/Users/fotis/.cfcf/logs/my-web-app-a1b2c3/iteration-000-architect.log",
  "message": "Architect review started. Poll GET /api/projects/:id/review/status for progress."
}
```

---

### POST /api/projects/:id/review/stop

Stop a running architect review. Kills the agent process and marks the review as failed with "Stopped by user".

**Response:** `200 OK`

```json
{ "projectId": "...", "status": "failed", "message": "Review stopped." }
```

**Error:** `404` if no review is running for this project.

---

### GET /api/projects/:id/review/status

Get the status of an architect review.

**Response:** `200 OK`

```json
{
  "projectId": "my-web-app-a1b2c3",
  "projectName": "my-web-app",
  "status": "completed",
  "startedAt": "2026-04-12T05:16:00.000Z",
  "completedAt": "2026-04-12T05:17:30.000Z",
  "exitCode": 0,
  "logFile": "...",
  "signals": {
    "readiness": "READY",
    "gaps": ["Missing error handling spec"],
    "suggestions": ["Add rate limiting"],
    "risks": ["External API dependency"],
    "recommended_approach": "Use Express with Zod validation"
  }
}
```

---

## Documenter

### POST /api/projects/:id/document

Run the Documenter agent to produce polished final project documentation. User-invoked, repeatable. Also runs automatically post-SUCCESS in the iteration loop.

**Response:** `202 Accepted`

```json
{
  "projectId": "my-web-app-a1b2c3",
  "status": "preparing",
  "logFile": "/Users/fotis/.cfcf/logs/my-web-app-a1b2c3/iteration-000-documenter.log",
  "message": "Documenter started. Poll GET /api/projects/:id/document/status for progress."
}
```

---

### POST /api/projects/:id/document/stop

Stop a running documenter. Kills the agent process and marks the document run as failed with "Stopped by user".

**Response:** `200 OK`

```json
{ "projectId": "...", "status": "failed", "message": "Documenter stopped." }
```

**Error:** `404` if no document run is active for this project.

---

### GET /api/projects/:id/document/status

Get the status of a documenter run.

**Response:** `200 OK`

```json
{
  "projectId": "my-web-app-a1b2c3",
  "projectName": "my-web-app",
  "status": "completed",
  "startedAt": "2026-04-12T05:16:00.000Z",
  "completedAt": "2026-04-12T05:17:30.000Z",
  "exitCode": 0,
  "logFile": "..."
}
```

---

## Reflection (ad-hoc)

### POST /api/projects/:id/reflect

Run the Reflection agent ad-hoc against the current state. Does NOT
modify `loop-state.json` and does NOT write an `iteration-log` (no
iteration happened). Added in v0.6.0.

**Request body (optional):**

```json
{
  "prompt": "focus on the auth-layer drift"
}
```

**Response:** `202 Accepted`

```json
{
  "projectId": "calc-849371",
  "status": "preparing",
  "logFile": "/Users/you/.cfcf/logs/calc-849371/reflection-002.log",
  "message": "Reflection started. Poll GET /api/projects/:id/reflect/status for progress."
}
```

### GET /api/projects/:id/reflect/status

Returns the current reflection run state (including parsed signals once
available).

**Response:** `200 OK` — `ReflectState` object with `status` in
`preparing | executing | collecting | completed | failed`, plus the parsed
`ReflectionSignals` when complete (`iteration_health`, `plan_modified`,
`key_observation`, `recommend_stop`).

### POST /api/projects/:id/reflect/stop

Kill a running reflection and mark it failed.

**Response:** `200 OK`

```json
{
  "projectId": "calc-849371",
  "status": "failed",
  "message": "Reflection stopped."
}
```

Inside the iteration loop, reflection runs as a deterministic phase of
the loop (see below) rather than as a standalone endpoint. The loop's
`loop-state.json` carries `phase: "reflecting"` while it runs.

---

## Iteration Loop (Dark Factory)

### POST /api/projects/:id/loop/start

Start the full iteration loop: `pre_loop_reviewing` (conditional, item 5.1) → dev → judge → reflect (conditional) → decide → repeat.

**Request body (optional):**

```json
{
  "problemPackPath": "/path/to/custom/problem-pack",
  "autoReviewSpecs": true,
  "autoDocumenter": false,
  "readinessGate": "blocked"
}
```

The three 5.1 keys are optional per-run overrides. When omitted they fall back to the project config (then the global config, then the hard default). Overrides are persisted on `loop-state.json` so the behaviour is stable across pause/resume cycles.

**Response:** `202 Accepted`

```json
{
  "projectId": "my-web-app-a1b2c3",
  "phase": "idle",
  "maxIterations": 10,
  "pauseEvery": 3,
  "message": "Iteration loop started. Poll GET /api/projects/:id/loop/status for progress."
}
```

---

### GET /api/projects/:id/loop/status

Get the full loop state including iteration history.

**Response:** `200 OK`

```json
{
  "projectId": "my-web-app-a1b2c3",
  "projectName": "my-web-app",
  "phase": "dev_executing",
  "currentIteration": 3,
  "maxIterations": 10,
  "pauseEvery": 3,
  "startedAt": "2026-04-12T05:16:00.000Z",
  "consecutiveStalled": 0,
  "iterations": [
    {
      "number": 1,
      "branch": "cfcf/iteration-1",
      "devExitCode": 0,
      "judgeSignals": { "determination": "PROGRESS", "quality_score": 7 },
      "merged": true
    }
  ]
}
```

| Phase | Description |
|-------|-------------|
| `idle` | Loop initialized, not yet running |
| `pre_loop_reviewing` | Solution Architect running as a pre-loop phase (item 5.1, when `autoReviewSpecs=true`) |
| `preparing` | Assembling context for next iteration (cf²) |
| `dev_executing` | Dev agent is running |
| `judging` | Judge agent is running |
| `reflecting` | Reflection agent is running (cross-iteration strategic review; conditional) |
| `deciding` | Evaluating judge + reflection signals (cf²) |
| `documenting` | Judge said SUCCESS; documenter is producing final docs before terminal state |
| `paused` | Waiting for user input or review |
| `completed` | Loop finished (success, failure, or max iterations) |
| `failed` | Loop encountered an error |
| `stopped` | Loop halted by user |

---

### POST /api/projects/:id/loop/resume

Resume a paused loop with optional user feedback.

**Request body (optional):**

```json
{
  "feedback": "Focus on error handling in the API layer"
}
```

**Response:** `202 Accepted`

---

### POST /api/projects/:id/loop/stop

Stop a running or paused loop.

**Response:** `200 OK`

```json
{
  "projectId": "my-web-app-a1b2c3",
  "phase": "stopped",
  "currentIteration": 3,
  "outcome": "stopped",
  "message": "Loop stopped."
}
```

---

## Server Lifecycle

### POST /api/shutdown

Gracefully shut down the server.

**Response:** `200 OK` -- `{ "status": "shutting down" }`

---

*This document is updated as new endpoints are added. See `../design/technical-design.md` for the full endpoint design.*
