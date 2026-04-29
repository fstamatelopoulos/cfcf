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

Returns a cross-workspace list of agent runs that are currently in flight.
Used by the web header to drive the pulsing blue activity indicator and
the "workspace: phase" label. Added in v0.6.0.

**Response:** `200 OK`

```json
{
  "active": [
    {
      "workspaceId": "calc-849371",
      "workspaceName": "calc",
      "type": "iteration",
      "phase": "reflecting",
      "iteration": 3,
      "startedAt": "2026-04-19T01:43:32.931Z"
    },
    {
      "workspaceId": "other-xyz",
      "workspaceName": "other",
      "type": "review",
      "startedAt": "2026-04-19T01:44:10.000Z"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `workspaceId` / `workspaceName` | string | Workspace that owns the run |
| `type` | `"iteration" \| "review" \| "document" \| "reflection"` | Kind of run |
| `phase` | `LoopPhase` | Only for `type: "iteration"` — current phase (preparing, dev_executing, judging, reflecting, deciding, documenting) |
| `iteration` | number | Iteration number when applicable |
| `startedAt` | ISO string | When the run started |

Loop-state has priority over raw history.json events: if a workspace has an
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

### PUT /api/config

Edit the global config. Added in v0.7.3 (item 5.9). Backs the web UI's
Settings page and is wire-compatible with `cfcf config edit` on the CLI.

**Request body:** a full `CfcfGlobalConfig` object or a partial patch.
The server merges the patch onto the current config, preserves
server-owned fields (`version`, `permissionsAcknowledged`,
`availableAgents` — clients cannot override these), validates, and
writes. Missing optional fields are backfilled the same way `readConfig`
does it.

```json
{
  "maxIterations": 20,
  "autoReviewSpecs": true,
  "readinessGate": "needs_refinement_or_blocked",
  "notifications": {
    "enabled": true,
    "events": {
      "loop.paused": ["terminal-bell", "macos", "log"],
      "loop.completed": ["terminal-bell", "macos", "log"],
      "agent.failed": ["log"]
    }
  }
}
```

**Response:** `200 OK` — the saved, fully-validated config (identical
shape to `GET /api/config`).

**Errors:**

| Status | When |
|---|---|
| `400` | Invalid JSON body, `maxIterations < 1`, `pauseEvery < 0`, or `validateConfig` rejected the merged result (e.g. missing `devAgent.adapter`). Error body: `{ "error": "<reason>" }`. |
| `404` | `cfcf init` has never been run — there's no config to edit. |
| `500` | Disk write failed. |

Unknown / invalid values for bounded fields (e.g. `readinessGate` set to
`"bogus"`) are silently backfilled to their defaults (see
`validateConfig`'s rules); they don't produce a `400`.

---

## Workspaces

### POST /api/workspaces

Create a new workspace.

**Request body:**

```json
{
  "name": "my-web-app",
  "repoPath": "/Users/fotis/src/my-web-app"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Workspace name |
| `repoPath` | Yes | Absolute path to a local git repository |
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

### GET /api/workspaces

List all workspaces.

**Response:** `200 OK` -- Array of workspace configs, sorted by name.

---

### GET /api/workspaces/:id

Get a workspace by ID or name (case-insensitive name match supported).

**Response:** `200 OK` -- Workspace config object.

**Error:** `404` if not found.

---

### PUT /api/workspaces/:id

Update per-workspace config (partial update). Backs the web UI's workspace detail Config tab (item 6.14, v0.7.4) and is the same endpoint `cfcf` CLI would use for a per-workspace edit if one existed.

**Request body:** a full `WorkspaceConfig` object or a partial patch. Server merges onto the existing config, **preserves identity + runtime fields** (`id`, `name`, `repoPath`, `currentIteration`, `status`, `processTemplate`) regardless of what the client sends, validates bounded + enum fields, and writes the result. `notifications: null` is a special signal meaning "clear the per-workspace override, inherit global".

```json
{
  "maxIterations": 20,
  "pauseEvery": 3,
  "onStalled": "alert",
  "mergeStrategy": "auto",
  "autoReviewSpecs": true,
  "readinessGate": "blocked",
  "reflectionAgent": { "adapter": "claude-code", "model": "opus" },
  "notifications": {
    "enabled": true,
    "events": {
      "loop.paused": ["terminal-bell", "log"],
      "loop.completed": ["terminal-bell", "log"],
      "agent.failed": ["log"]
    }
  }
}
```

**Response:** `200 OK` -- the saved, canonicalised workspace config (identical shape to `GET /api/workspaces/:id`).

**Errors:**

| Status | When |
|---|---|
| `400` | Invalid JSON body; `maxIterations < 1`; `pauseEvery < 0`; `reflectSafeguardAfter < 1`; invalid enum for `onStalled` / `mergeStrategy` / `readinessGate`; agent role object missing `adapter`. |
| `404` | Workspace not found. |

---

### DELETE /api/workspaces/:id

Delete a workspace (removes config only, does not touch the repo).

**Response:** `200 OK` -- `{ "deleted": true }`

---

## Iterate

### POST /api/workspaces/:id/iterate

Execute the next iteration within a workspace. Two modes:

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
  "message": "Iteration started. Poll GET /api/workspaces/:id/iterations/:n/status for progress."
}
```

The iteration runs in the background. Use the status and logs endpoints to track progress.

---

### GET /api/workspaces/:id/iterations/:n/status

Get the current status of an iteration.

**Response:** `200 OK`

```json
{
  "iteration": 1,
  "workspaceId": "my-web-app-a1b2c3",
  "workspaceName": "my-web-app",
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

### GET /api/workspaces/:id/iterations/latest

Get the status of the most recent iteration for a workspace.

Same response format as `/iterations/:n/status`.

---

### GET /api/workspaces/:id/iterations/:n/logs

SSE stream of log events for a completed iteration (the dev agent log). Tails the file if the iteration is still active.

**Events:**
- `event: log` -- Log line from agent output
- `event: done` -- Stream complete
- `event: error` -- Error reading logs

---

### GET /api/workspaces/:id/logs/:filename

Generic SSE log streaming by filename. Used for architect / documenter / judge logs and any other file under the workspace's log directory.

The server detects if the log belongs to a live agent run (iteration in progress, review in progress, etc.) and tails the file accordingly. For completed runs, reads the file once and closes the stream.

**Examples:**
- `/api/workspaces/my-app/logs/iteration-001-dev.log`
- `/api/workspaces/my-app/logs/iteration-001-judge.log`
- `/api/workspaces/my-app/logs/architect-001.log`
- `/api/workspaces/my-app/logs/documenter-001.log`

**Events:** same as above (`log`, `done`, `error`).

**Security:** the filename must not contain path separators or `..`, and must end with `.log`. Otherwise returns 400.

---

### GET /api/workspaces/:id/history

Returns the workspace's history events array. Each event represents an agent invocation (review, iteration, document). History persists across loop restarts — unlike `loop-state.json` which resets on each `startLoop`.

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
| `pa-session` | Product Architect (`cfcf spec`) | `sessionId`, `sessionFilePath`, `outcomeSummary`, `decisionsCount`, `clioWorkspaceMemoryDocId`, `exitCode`, `workspaceRegisteredAtStart`, `gitInitializedAtStart`, `problemPackFilesAtStart` |

A `pa-session` event example:

```json
{
  "id": "pa-pa-2026-04-29T08-15-30-abc123",
  "type": "pa-session",
  "status": "completed",
  "startedAt": "2026-04-29T08:15:30.000Z",
  "completedAt": "2026-04-29T08:42:14.000Z",
  "logFile": ".cfcf-pa/session-pa-2026-04-29T08-15-30-abc123.md",
  "agent": "codex",
  "sessionId": "pa-2026-04-29T08-15-30-abc123",
  "sessionFilePath": ".cfcf-pa/session-pa-2026-04-29T08-15-30-abc123.md",
  "exitCode": 0,
  "outcomeSummary": "Drafted problem.md and success.md; user wants to refine constraints next session.",
  "decisionsCount": 3,
  "clioWorkspaceMemoryDocId": "f4a8c5e2-...-...",
  "workspaceRegisteredAtStart": true,
  "gitInitializedAtStart": true,
  "problemPackFilesAtStart": 2
}
```

---

### GET /api/workspaces/:id/pa-sessions/:sessionId/file

Return the on-disk artefacts for a specific Product Architect session. Powers the web UI's expandable PA-session detail panel. Reads from `<workspace.repoPath>/.cfcf-pa/`; any of the three files may be absent (returns `null` for missing).

The `sessionId` parameter is validated against `^pa-[A-Za-z0-9-]+$` to prevent path traversal.

**Response:** `200 OK`

```json
{
  "sessionId": "pa-2026-04-29T08-15-30-abc123",
  "cachePath": "/abs/path/to/repo/.cfcf-pa",
  "sessionFile": "# PA session log\n\n... full Markdown body ...",
  "sessionFilePath": ".cfcf-pa/session-pa-2026-04-29T08-15-30-abc123.md",
  "workspaceSummary": "# PA workspace memory\n\n... full Markdown body ...",
  "workspaceSummaryPath": ".cfcf-pa/workspace-summary.md",
  "meta": {
    "currentSessionId": "pa-2026-04-29T08-15-30-abc123",
    "lastSyncAt": "2026-04-29T08:42:14.000Z",
    "paWorkspaceMemoryDocId": "f4a8c5e2-...",
    "paGlobalMemoryDocId": null,
    "lastSession": {
      "sessionId": "pa-2026-04-29T08-15-30-abc123",
      "endedAt": "2026-04-29T08:42:14.000Z",
      "outcomeSummary": "Drafted problem.md and success.md; user wants to refine constraints next session.",
      "decisionsCount": 3,
      "clioWorkspaceMemoryDocId": "f4a8c5e2-..."
    }
  }
}
```

**Errors:**
- `400` — `sessionId` doesn't match the expected pattern
- `404` — workspace not found

---

## Solution Architect Review

### POST /api/workspaces/:id/review

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
  "workspaceId": "my-web-app-a1b2c3",
  "status": "preparing",
  "logFile": "/Users/fotis/.cfcf/logs/my-web-app-a1b2c3/iteration-000-architect.log",
  "message": "Architect review started. Poll GET /api/workspaces/:id/review/status for progress."
}
```

---

### POST /api/workspaces/:id/review/stop

Stop a running architect review. Kills the agent process and marks the review as failed with "Stopped by user".

**Response:** `200 OK`

```json
{ "workspaceId": "...", "status": "failed", "message": "Review stopped." }
```

**Error:** `404` if no review is running for this workspace.

---

### GET /api/workspaces/:id/review/status

Get the status of an architect review.

**Response:** `200 OK`

```json
{
  "workspaceId": "my-web-app-a1b2c3",
  "workspaceName": "my-web-app",
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

### POST /api/workspaces/:id/document

Run the Documenter agent to produce polished final workspace documentation. User-invoked, repeatable. Also runs automatically post-SUCCESS in the iteration loop.

**Response:** `202 Accepted`

```json
{
  "workspaceId": "my-web-app-a1b2c3",
  "status": "preparing",
  "logFile": "/Users/fotis/.cfcf/logs/my-web-app-a1b2c3/iteration-000-documenter.log",
  "message": "Documenter started. Poll GET /api/workspaces/:id/document/status for progress."
}
```

---

### POST /api/workspaces/:id/document/stop

Stop a running documenter. Kills the agent process and marks the document run as failed with "Stopped by user".

**Response:** `200 OK`

```json
{ "workspaceId": "...", "status": "failed", "message": "Documenter stopped." }
```

**Error:** `404` if no document run is active for this workspace.

---

### GET /api/workspaces/:id/document/status

Get the status of a documenter run.

**Response:** `200 OK`

```json
{
  "workspaceId": "my-web-app-a1b2c3",
  "workspaceName": "my-web-app",
  "status": "completed",
  "startedAt": "2026-04-12T05:16:00.000Z",
  "completedAt": "2026-04-12T05:17:30.000Z",
  "exitCode": 0,
  "logFile": "..."
}
```

---

## Reflection (ad-hoc)

### POST /api/workspaces/:id/reflect

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
  "workspaceId": "calc-849371",
  "status": "preparing",
  "logFile": "/Users/you/.cfcf/logs/calc-849371/reflection-002.log",
  "message": "Reflection started. Poll GET /api/workspaces/:id/reflect/status for progress."
}
```

### GET /api/workspaces/:id/reflect/status

Returns the current reflection run state (including parsed signals once
available).

**Response:** `200 OK` — `ReflectState` object with `status` in
`preparing | executing | collecting | completed | failed`, plus the parsed
`ReflectionSignals` when complete (`iteration_health`, `plan_modified`,
`key_observation`, `recommend_stop`).

### POST /api/workspaces/:id/reflect/stop

Kill a running reflection and mark it failed.

**Response:** `200 OK`

```json
{
  "workspaceId": "calc-849371",
  "status": "failed",
  "message": "Reflection stopped."
}
```

Inside the iteration loop, reflection runs as a deterministic phase of
the loop (see below) rather than as a standalone endpoint. The loop's
`loop-state.json` carries `phase: "reflecting"` while it runs.

---

## Iteration Loop (Dark Factory)

### POST /api/workspaces/:id/loop/start

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

The three 5.1 keys are optional per-run overrides. When omitted they fall back to the workspace config (then the global config, then the hard default). Overrides are persisted on `loop-state.json` so the behaviour is stable across pause/resume cycles.

**Response:** `202 Accepted`

```json
{
  "workspaceId": "my-web-app-a1b2c3",
  "phase": "idle",
  "maxIterations": 10,
  "pauseEvery": 3,
  "message": "Iteration loop started. Poll GET /api/workspaces/:id/loop/status for progress."
}
```

---

### GET /api/workspaces/:id/loop/status

Get the full loop state including iteration history.

**Response:** `200 OK`

```json
{
  "workspaceId": "my-web-app-a1b2c3",
  "workspaceName": "my-web-app",
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

### POST /api/workspaces/:id/loop/resume

Resume a paused loop with optional user feedback.

**Request body (optional):**

```json
{
  "feedback": "Focus on error handling in the API layer"
}
```

**Response:** `202 Accepted`

---

### POST /api/workspaces/:id/loop/stop

Stop a running or paused loop.

**Response:** `200 OK`

```json
{
  "workspaceId": "my-web-app-a1b2c3",
  "phase": "stopped",
  "currentIteration": 3,
  "outcome": "stopped",
  "message": "Loop stopped."
}
```

---

## Clio (cross-workspace memory, item 5.7)

All Clio endpoints live under `/api/clio/*`. Backed by a single SQLite DB at `~/.cfcf/clio.db` (override via `CFCF_CLIO_DB`). FTS5 keyword search + ONNX-embedder hybrid (α-weighted blend of cosine + normalised BM25, default α=0.7) + semantic (cosine) search, all behind the same shape — clients pick via `mode`. Default mode is `auto` (hybrid if an embedder is active, else fts).

### GET /api/clio/projects

List all Clio Projects with document counts.

**Response:** `200 OK`
```json
{
  "projects": [
    { "id": "<uuid>", "name": "cf-ecosystem", "description": "...", "metadata": {}, "createdAt": "...", "updatedAt": "...", "documentCount": 12 }
  ]
}
```

### POST /api/clio/projects

Create a Clio Project.

**Request body:**
```json
{ "name": "cf-ecosystem", "description": "optional" }
```

**Responses:** `201 Created` · `400` if `name` missing · `409` if name already exists (case-insensitive).

### GET /api/clio/projects/:idOrName

Fetch a single Clio Project by UUID or name (case-insensitive).

**Responses:** `200 OK` with the ClioProject · `404` if not found.

### POST /api/clio/ingest

Ingest a Markdown document. Chunks the content via the heading-aware chunker, then takes one of four branches based on the request body:

1. `documentId` provided → **deterministic update**. Snapshots the named doc's current chunks into a new version row and replaces them with the new content. 404s if the doc doesn't exist or is soft-deleted. Wins over `updateIfExists` (returns a `note` if both passed). Mirrors Cerefox `cerefox_ingest(document_id=...)`.
2. `updateIfExists: true` → **title-based update**. Looks up an existing live (non-deleted) doc with the same title in the same Project; if found, updates in place (snapshot + replace); if not, falls through to create. Mirrors Cerefox `cerefox_ingest(update_if_exists=true)`.
3. Content matches an existing live doc's `content_hash` → **skip** (idempotent no-op; returns the existing record). PR1 behaviour preserved.
4. Otherwise → **create** a brand-new document.

**Request body:**
```json
{
  "project": "cf-ecosystem",            // name or id; auto-created if unknown (name only)
  "title": "Document title",
  "content": "# Markdown body\n\n...",
  "source": "optional origin hint",
  "metadata": { "role": "dev", "artifact_type": "iteration-log" },
  "reviewStatus": "approved",
  "documentId": "<uuid, optional>",     // 5.11: deterministic update
  "updateIfExists": false,              // 5.11: title-based update fallback
  "author": "claude-code"               // 5.11: stored on version rows for attribution
}
```

**Responses:**
- `201 Created` on a fresh ingest — returns `{ id, action: "created", created: true, document, chunksInserted }`.
- `200 OK` on update — returns `{ id, action: "updated", created: false, document, chunksInserted, versionId, versionNumber, note? }`. The `versionId` points at the snapshot row holding the prior content.
- `200 OK` on dedup skip — returns `{ id, action: "skipped", created: false, document, chunksInserted: 0 }`.
- `400` for missing required fields / empty title or content / malformed metadata.
- `404` when `documentId` doesn't resolve.

**Backwards compatibility:** the legacy `created` boolean is still set (`true` iff `action === "created"`), so PR1 callers continue to work. New code should prefer `action`.

### GET /api/clio/documents/:id/content

**5.11.** Reconstruct the full Markdown content of a document by joining its chunks (newline-separated, in `chunk_index` order). Mirrors Cerefox `cerefox_get_document(p_document_id, p_version_id)`.

**Path:** `:id` — document UUID.

**Query params:**
- `version_id` (optional) — UUID of an archived version (from `GET /api/clio/documents/:id/versions`). When omitted, returns the live (current) version.

**Response:** `200 OK`
```json
{
  "document": { /* ClioDocument */ },
  "content": "# Reconstructed markdown body\n\n...",
  "chunkCount": 12,
  "totalChars": 7430,
  "versionId": null
}
```

**Errors:** `404` when the doc doesn't exist or `version_id` doesn't belong to it.

### GET /api/clio/documents/:id/versions

**5.11.** List archived versions for a document, newest first. Empty array when the doc has never been updated. Mirrors Cerefox `cerefox_list_document_versions`.

**Response:** `200 OK`
```json
{
  "versions": [
    {
      "id": "<version uuid>",
      "documentId": "<doc uuid>",
      "versionNumber": 3,
      "source": "claude-code",
      "metadata": {},
      "chunkCount": 12,
      "totalChars": 7430,
      "archived": false,
      "createdAt": "2026-04-26T08:11:42.054Z"
    }
    // ...older versions...
  ]
}
```

**Errors:** `404` when the doc doesn't exist.

### DELETE /api/clio/documents/:id

**5.11.** Soft-delete. Sets `deleted_at`; the row + chunks + versions remain. Idempotent. Mirrors Cerefox `cerefox_delete_document`.

**Body (optional):** `{ "author": "claude-code" }` — recorded on the audit log entry.

**Response:** `200 OK` with `{ deleted: true, document }`. `404` for unknown doc.

### POST /api/clio/documents/:id/restore

**5.11.** Undo a soft-delete. Idempotent: restoring an already-live doc returns `{ restored: false, document }`.

**Response:** `200 OK`. `404` for unknown doc.

### PATCH /api/clio/documents/:id

**5.13 follow-up.** Metadata-only edit. Mutate `title`, `author`, Clio Project, and metadata WITHOUT re-ingesting content. **No version snapshot is taken** — versions exist to protect chunks from accidental overwrite, and metadata edits don't touch chunks. Writes one `edit-metadata` audit-log entry with a before/after diff.

**Body (all fields optional):**
```json
{
  "title":         "New name",
  "author":        "claude-code",       // empty string clears to default 'agent'
  "projectId":     "<uuid>",            // OR
  "projectName":   "cfcf",              // (one of the two -- projectId wins if both)
  "metadataSet":   { "reviewed_by": "fotis", "status": "approved" },
  "metadataUnset": ["draft"],
  "actor":         "claude-code"        // audit-log attribution; defaults to 'agent'
}
```

`metadataSet` adds/overwrites keys; existing keys not mentioned survive. `metadataUnset` removes keys (idempotent — no-op if absent). The set/unset split (vs Cerefox's full-blob replace) avoids the read-modify-write footgun where an agent accidentally drops keys it didn't know about; a future `CerefoxRemote` adapter can reconstruct the full blob from these deltas at the abstraction boundary if upstream demands it.

**Response:** `200 OK` with `{ updated: boolean, document: ClioDocument }`.
- `updated: true` — at least one field actually changed; one `edit-metadata` audit row was written.
- `updated: false` — every requested edit already matched the current state; no audit row, no `updated_at` bump.

**Errors:**
- `400` — empty `title`, unknown `projectId` / `projectName`, or doc is soft-deleted (restore first).
- `404` — doc not found.

### POST /api/clio/metadata-search

**5.12.** Find documents by metadata-only filter. Mirrors Cerefox `cerefox_metadata_search`.

**Body:**
```json
{
  "metadataFilter": { "role": "reflection", "tier": "semantic" },
  "project": "cf-ecosystem",                      // optional
  "updatedSince": "2026-04-01T00:00:00Z",         // optional ISO timestamp
  "includeDeleted": false,                        // optional
  "matchCount": 50                                 // optional, default 50, cap 500
}
```

**Response:** `200 OK` with `{ documents: ClioDocument[], metadataFilter }`. `400` for missing/empty `metadataFilter`.

### GET /api/clio/metadata-keys

**5.12.** List metadata keys + sample values currently in the corpus. Mirrors Cerefox `cerefox_list_metadata_keys`.

**Query params:** `project` (optional name or id; restricts the scan to that Clio Project).

**Response:** `200 OK`
```json
{
  "keys": [
    { "key": "role", "documentCount": 42, "valueSamples": ["reflection", "dev", "architect"] },
    { "key": "artifact_type", "documentCount": 18, "valueSamples": ["reflection-analysis", "iteration-log"] }
  ]
}
```

Most-used keys first. Array values produce `valueSamples: []` (only top-level scalars are sampled — they're the only valid values for `metadata-search` filters anyway).

### GET /api/clio/audit-log

**5.13.** Query the audit log. Mirrors Cerefox `cerefox_get_audit_log`. Newest first.

The audit log records every Clio **mutation**: `create`, `update-content`, `edit-metadata`, `delete`, `restore`, `migrate-project`. Reads (search, get, list) are NOT recorded — write attribution is the trust story.

**Query params (all optional, AND-combined):**
- `event_type` — `create` | `update-content` | `edit-metadata` | `delete` | `restore` | `migrate-project`
- `actor` — exact match (e.g. `claude-code`)
- `project` — Clio Project name or id
- `document_id` — UUID
- `since` — ISO-8601 timestamp; only entries with `timestamp >= this`
- `limit` — default 100, cap 1000

**Response:** `200 OK`
```json
{
  "entries": [
    {
      "id": 42,
      "timestamp": "2026-04-26T08:11:42.054Z",
      "eventType": "update-content",
      "actor": "claude-code",
      "projectId": "<uuid>",
      "documentId": "<uuid>",
      "query": null,
      "metadata": { "version_id": "<uuid>", "version_number": 3, "chunks": 12, "total_chars": 7430 }
    }
  ]
}
```

**Errors:** `400` for unknown `event_type`.

### GET /api/clio/search

Hybrid / semantic / FTS search. Default returns one row per matching **document** (Cerefox parity); `?by=chunk` returns one row per matching chunk.

**Query params:**
- `q` (required) — free-text query. FTS operator characters are stripped server-side, so clients don't need to escape.
- `by` (optional, default `doc`) — `doc` returns deduplicated document-level hits (one per unique `documentId`, ordered by best-chunk score, with `matchingChunks` + `versionCount` + the best chunk's content). `chunk` returns the raw chunk-level hits ordered by score. Doc-level is the default since 5.12 (Cerefox `cerefox_search` parity); chunk-level is preserved for callers that want to see the engine's per-chunk ranking explicitly.
- `project` (optional) — Clio Project name or id. Scopes to that Project only.
- `mode` (optional) — `"fts"` · `"hybrid"` · `"semantic"`. When omitted, the server resolves in this order:
  - `clio.defaultSearchMode` from the global config (`auto` | concrete value),
  - `auto` (hybrid if `clio_active_embedder` row exists, else fts).
  Hybrid + semantic require an active embedder; calling them without one returns a 400.
- `min_score` (optional) — cosine threshold (0.0–1.0) for the **vector branch** of hybrid (FTS-matched chunks bypass) and for **every** result of semantic. Per-call value wins over `clio.minSearchScore` in the global config; absent both, default 0.5 (Cerefox parity). Ignored for `mode=fts`.
- `alpha` (optional) — hybrid blend weight (0.0–1.0). `α × cosine + (1−α) × normalised_BM25`. Higher = more semantic; lower = more keyword. Per-call value wins over `clio.hybridAlpha`; absent both, default 0.7 (Cerefox parity). Ignored for `mode=fts` and `mode=semantic`.
- `small_doc_threshold` (optional) — doc-level small-to-big threshold (chars). Documents whose live `total_chars` is at most this value return the full document content as `bestChunkContent`; larger docs return matched chunk + `context_window` neighbours. Per-call value wins over `clio.smallDocThreshold`; absent both, default 20000 (Cerefox parity). Set 0 to always use the chunk-window form. Only meaningful for `?by=doc`.
- `context_window` (optional) — sibling chunks per side around the matched chunk in the large-doc path. Per-call value wins over `clio.contextWindow`; absent both, default 1 (Cerefox parity). `0` returns only the matched chunk. Only meaningful for `?by=doc`.
- `match_count` (optional) — max hits to return. Default 10 for `?by=chunk`, 5 for `?by=doc` (Cerefox parity). Cap 100 for chunks, 50 for docs.
- `metadata` (optional) — JSON-encoded object for exact-match filtering against `clio_documents.metadata`, e.g. `metadata={"role":"reflection","tier":"semantic"}`.

**Response (default, `?by=doc` — `DocumentSearchResponse`):** `200 OK`
```json
{
  "hits": [
    {
      "documentId": "<uuid>",
      "docTitle": "Auth service design",
      "docSource": "user-ingest: /Users/.../design.md",
      "docAuthor": "claude-code",
      "docProjectId": "<uuid>",
      "docProjectName": "cf-ecosystem",
      "docMetadata": { "role": "dev" },
      "chunkCount": 9,
      "totalChars": 5320,
      "versionCount": 2,
      "matchingChunks": 3,
      "bestScore": 4.12,
      "bestChunkHeadingPath": ["Overview", "Architecture"],
      "bestChunkHeadingLevel": 2,
      "bestChunkTitle": "Architecture",
      "bestChunkContent": "...",
      "bestChunkId": "<uuid>",
      "bestChunkIndex": 2,
      "createdAt": "2026-04-26T...",
      "updatedAt": "2026-04-27T...",
      "isPartial": true
    }
  ],
  "mode": "hybrid",
  "totalMatches": 12,
  "totalDocuments": 4
}
```

`isPartial` (Cerefox `is_partial` parity): `true` when `bestChunkContent` is the matched chunk + `context_window` neighbours (large-doc path); `false` when it's the full document content (small-doc path: `total_chars ≤ small_doc_threshold`).

**Response (`?by=chunk` — legacy `SearchResponse`):** `200 OK`
```json
{
  "hits": [
    {
      "chunkId": "...",
      "documentId": "...",
      "chunkIndex": 2,
      "title": "Architecture",
      "content": "...",
      "headingPath": ["Overview", "Architecture"],
      "headingLevel": 2,
      "score": 4.12,
      "docTitle": "Auth service design",
      "docSource": "user-ingest: /Users/.../design.md",
      "docAuthor": "claude-code",
      "docProjectId": "<uuid>",
      "docProjectName": "cf-ecosystem",
      "docMetadata": { "role": "dev" }
    }
  ],
  "mode": "fts",
  "totalMatches": 1
}
```

**Errors:** `400` for missing / empty `q`; `400` for malformed `metadata` JSON; `400` for `by` not in {`doc`, `chunk`}.

### GET /api/clio/documents

List documents, newest first. Soft-deleted docs are excluded.

**Query params:**
- `project` (optional) — Clio Project name or id. When unknown, returns an empty list.
- `limit` (optional, default 50, cap 500).
- `offset` (optional, default 0).
- `include_deleted` (optional, default `false`) — when `true`, soft-deleted docs appear alongside live ones.
- `deleted_only` (optional, default `false`) — trash-bin view: only soft-deleted docs are returned. Wins over `include_deleted` when both are passed.

**Response:** `200 OK`
```json
{ "documents": [ { /* ClioDocument */ }, ... ] }
```

**Errors:** `400` for non-positive `limit`, negative `offset`, or invalid params.

### GET /api/clio/documents/:id

Fetch a document by UUID.

**Responses:** `200 OK` with the ClioDocument · `404` if not found.

### GET /api/clio/embedders

Catalogue of supported embedders + active marker.

**Response:** `200 OK`
```json
{
  "catalogue": [
    { "name": "nomic-embed-text-v1.5", "dim": 768, "approxSizeMb": 130, "recommendedChunkMaxChars": 7000, "recommendedExpansionRadius": 1, "description": "...", "active": true },
    { "name": "bge-small-en-v1.5", "dim": 384, "approxSizeMb": 120, "recommendedChunkMaxChars": 1800, "recommendedExpansionRadius": 2, "description": "...", "active": false }
  ]
}
```

### POST /api/clio/embedders/install

Install + activate an embedder. Triggers the HuggingFace download via `@huggingface/transformers` and caches to `~/.cfcf/models/`. With `loadNow: true` (default in CLI / init flows), warmup also materialises the inference pipeline so the next search is instant.

**Request body:**
```json
{ "name": "nomic-embed-text-v1.5", "force": false }
```

**Responses:** `200 OK` with `{ active: { name, dim, recommendedChunkMaxChars }, downloaded: true|false }` · `400` for unknown name · `409` when existing embeddings would be invalidated and `force` is not set.

### GET /api/clio/embedders/:name/switch-impact

**5.12+ follow-up.** Pre-flight summary for an embedder switch — surfaced by the CLI + Web UI before the user confirms the change. Read-only; no DB writes.

**Path:** `:name` — the candidate embedder name (must be in the catalogue).

**Response:** `200 OK`
```json
{
  "newName": "bge-small-en-v1.5",
  "newDim": 384,
  "newRecommendedChunkMaxChars": 1800,
  "currentName": "nomic-embed-text-v1.5",
  "currentRecommendedChunkMaxChars": 7000,
  "totalChunkCount": 89,
  "embeddedChunkCount": 89,
  "chunksOverNewCeiling": 67,
  "configMaxChunkChars": null,
  "configMaxOverCeiling": false
}
```

Three signals the CLI / UI use to warn:
- `embeddedChunkCount > 0` and switching to a different model → existing embeddings become inconsistent unless `--reindex` is also passed.
- `chunksOverNewCeiling > 0` → existing chunks exceed the new model's `recommendedChunkMaxChars`; the model would silently truncate inputs at embed time. Recommended remediation: `cfcf clio reindex --rechunk` (planned, item 6.23).
- `configMaxOverCeiling: true` → the user's `clio.maxChunkChars` exceeds the new embedder's ceiling; future ingests will be capped at the ceiling, not honoured verbatim.

**Errors:** `400` for unknown embedder name; `400` when the active backend doesn't support embedders (only `LocalClio` does today).

### POST /api/clio/embedders/set

Switch the active embedder. Pair `--reindex` (CLI flag → server `reindex: true` body field) for the safe, atomic switch + re-embed flow. `force` without reindex is degraded — vector search is broken until a separate `cfcf clio reindex` runs.

**Request body:**
```json
{ "name": "bge-small-en-v1.5", "force": false, "reindex": true }
```

**Responses:** `200 OK` with `{ active: {...}, reindex: { chunksReembedded, chunksSkipped, documentsTouched, elapsedMs } | null }` · `400` for invalid `name` · `409` when corpus exists and neither `reindex` nor `force` is set.

### POST /api/clio/reindex

Re-embed chunks under the currently-active embedder. Idempotent: chunks whose `embedder` + `embedding_dim` already match the active embedder are skipped unless `force: true`.

**Request body:**
```json
{ "project": "cf-ecosystem", "force": false, "batchSize": 32 }
```

All fields optional. Without `project`, every document in the DB is processed.

**Response:** `200 OK`
```json
{
  "embedder": "nomic-embed-text-v1.5",
  "embeddingDim": 768,
  "chunksScanned": 1234,
  "chunksReembedded": 980,
  "chunksSkipped": 254,
  "documentsTouched": 56,
  "elapsedMs": 18420
}
```

**Errors:** `400` when no embedder is active.

### GET /api/clio/stats

DB size, counts, active embedder (null in PR1), applied migrations.

**Response:** `200 OK`
```json
{
  "dbPath": "/Users/.../.cfcf/clio.db",
  "dbSizeBytes": 65536,
  "projectCount": 3,
  "documentCount": 42,
  "chunkCount": 156,
  "migrations": ["0001_initial.sql @ 2026-04-22T21:30:00.000Z"],
  "activeEmbedder": null
}
```

### PUT /api/workspaces/:id/clio-project

Rewire a workspace's Clio Project assignment. Backs the `cfcf workspace set --project` CLI.

**Request body:**
```json
{
  "project": "new-clio-project-name",
  "migrateHistory": false
}
```

- `project` (required) — new Clio Project name. Auto-created if it doesn't already exist. Refuses raw UUIDs to guard against accidental "create project named after a UUID" mistakes.
- `migrateHistory` (optional, default `false`) — when `true`, re-keys all `clio_documents` currently in the workspace's old Project to the new Project via a single SQL UPDATE in a transaction.

**Response:** `200 OK`
```json
{
  "workspace": { /* full WorkspaceConfig with updated clioProject */ },
  "migrated": 2
}
```

`migrated` is the number of documents re-keyed (0 when `migrateHistory: false` or when the old Project had no docs).

**Errors:** `404` if the workspace doesn't exist; `400` if `project` is missing; `400` if the new Project name is a UUID.

---

## Server Lifecycle

### POST /api/shutdown

Gracefully shut down the server.

**Response:** `200 OK` -- `{ "status": "shutting down" }`

---

*This document is updated as new endpoints are added. See `../design/technical-design.md` for the full endpoint design.*
