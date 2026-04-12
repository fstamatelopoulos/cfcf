# cfcf Server API Reference

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

## Future Endpoints

The following endpoints are planned for upcoming iterations. They are documented here as placeholders to show the API direction.

### Projects (Iteration 2+)

```
POST   /api/projects                           # Create/register a project
GET    /api/projects                           # List all projects
GET    /api/projects/:id                       # Get project details
PUT    /api/projects/:id/config                # Update project config
```

### Runs (Iteration 3+)

```
POST   /api/projects/:id/runs                  # Start a new run
GET    /api/projects/:id/runs                  # List runs
GET    /api/projects/:id/runs/:runId           # Get run status
POST   /api/projects/:id/runs/:runId/pause     # Pause a running run
POST   /api/projects/:id/runs/:runId/resume    # Resume (with optional feedback)
POST   /api/projects/:id/runs/:runId/stop      # Stop a run
```

### Real-time Events (Iteration 3+)

```
GET    /api/projects/:id/runs/:runId/events    # SSE stream for real-time updates
```

**Event types:**

| Event | Description |
|-------|-------------|
| `iteration.started` | New iteration began |
| `iteration.log` | Log line from agent (dev or judge) |
| `iteration.dev_completed` | Dev agent finished |
| `iteration.judge_completed` | Judge agent finished with determination |
| `run.paused` | Run paused (cadence, anomaly, or user input needed) |
| `run.completed` | Run finished (success, failure, or stopped) |
| `alert` | User notification |

### Iteration Details (Iteration 3+)

```
GET    /api/projects/:id/runs/:runId/iterations            # List iterations
GET    /api/projects/:id/runs/:runId/iterations/:n          # Iteration details
GET    /api/projects/:id/runs/:runId/iterations/:n/logs     # Full agent logs
GET    /api/projects/:id/runs/:runId/iterations/:n/diff     # Git diff
GET    /api/projects/:id/runs/:runId/iterations/:n/judge    # Judge assessment
```

---

*This document is updated as new endpoints are added. See `../design/technical-design.md` for the full endpoint design.*
