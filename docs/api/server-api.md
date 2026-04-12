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

---

## Configuration

### GET /api/config

Returns the current global configuration.

**Response:** `200 OK` (when configured)

```json
{
  "version": 1,
  "devAgent": {
    "adapter": "claude-code"
  },
  "judgeAgent": {
    "adapter": "codex"
  },
  "maxIterations": 10,
  "pauseEvery": 0,
  "availableAgents": ["claude-code", "codex"],
  "permissionsAcknowledged": true
}
```

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

SSE stream of log events for a completed iteration.

**Events:**
- `event: log` -- Log line from agent output
- `event: done` -- Stream complete
- `event: error` -- Error reading logs

---

## Server Lifecycle

### POST /api/shutdown

Gracefully shut down the server.

**Response:** `200 OK` -- `{ "status": "shutting down" }`

---

## Future Endpoints

The following endpoints are planned for upcoming iterations. They are documented here as placeholders to show the API direction.

### Projects (Iteration 2+)

```
POST   /api/projects                           # Create/register a project
GET    /api/projects                           # List all projects
GET    /api/projects/:id                       # Get project details
PUT    /api/projects/:id/config                # Update project config
```

### Iteration Lifecycle (Iteration 3+)

```
POST   /api/projects/:id/iterate               # Execute the next iteration
POST   /api/projects/:id/pause                 # Pause iteration loop
POST   /api/projects/:id/resume                # Resume (with optional feedback)
POST   /api/projects/:id/stop                  # Stop iterating
```

### Real-time Events (Iteration 3+)

```
GET    /api/projects/:id/events                # SSE stream for real-time updates
```

**Event types:**

| Event | Description |
|-------|-------------|
| `iteration.started` | New iteration began |
| `iteration.log` | Log line from agent (dev or judge) |
| `iteration.dev_completed` | Dev agent finished |
| `iteration.judge_completed` | Judge agent finished with determination |
| `project.paused` | Project paused (cadence, anomaly, or user input needed) |
| `project.completed` | Project finished (success, failure, or stopped) |
| `alert` | User notification |

### Iteration Details (Iteration 3+)

```
GET    /api/projects/:id/iterations            # List iterations
GET    /api/projects/:id/iterations/:n          # Iteration details
GET    /api/projects/:id/iterations/:n/logs     # Full agent logs
GET    /api/projects/:id/iterations/:n/diff     # Git diff
GET    /api/projects/:id/iterations/:n/judge    # Judge assessment
```

---

*This document is updated as new endpoints are added. See `../design/technical-design.md` for the full endpoint design.*
