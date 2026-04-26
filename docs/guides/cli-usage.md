# cf² CLI Usage Guide

*cfcf and cf² are used interchangeably. Both are pronounced "cf square." `cfcf` in code and commands; cf² in docs.*

This guide covers all cf² commands and typical workflows.

## Prerequisites

- cfcf binary installed (or Bun + source for development)
- Git installed
- At least one AI coding agent installed: Claude Code or Codex CLI

---

## First-Time Setup

### `cfcf init`

Run once after installing cfcf. Detects installed agents, asks for configuration defaults, and saves the config.

```bash
cfcf init
```

What it does:
1. Scans for installed agents (Claude Code, Codex CLI) and reports what it finds
2. Verifies git is available
3. Asks you to choose agents for all five roles (dev, judge, architect, documenter, reflection)
4. Asks for model selection per role (optional; reflection defaults to the strongest available model)
5. Asks for default iteration limits (max iterations, pause cadence) and the reflection safeguard ceiling (`reflectSafeguardAfter`, default `3` -- the maximum consecutive iterations the judge may skip reflection before cfcf forces it)
6. Asks for the pre-loop review + post-SUCCESS documenter flags (item 5.1):
   - `autoReviewSpecs` (default `false`) -- if `true`, Start Loop first runs the Solution Architect and gates on its readiness signal
   - `readinessGate` (default `blocked`) -- only consulted when `autoReviewSpecs=true`; levels are `never` / `blocked` / `needs_refinement_or_blocked`
   - `autoDocumenter` (default `true`) -- if `false`, the loop skips the Documenter on SUCCESS; run `cfcf document` manually when you want docs
7. Explains the permission flags agents will run with (`--dangerously-skip-permissions` for Claude Code, `-a never -s danger-full-access` for Codex)
8. Saves everything to the config file

To re-run setup (e.g., after installing a new agent):

```bash
cfcf init --force
```

---

## Server Management

cfcf runs a background server that manages workspaces, executes iterations, and streams logs. The CLI communicates with the server via HTTP.

### `cfcf server start`

Start the cfcf server in the background.

```bash
cfcf server start                # Default port 7233
cfcf server start --port 8080    # Custom port
```

### `cfcf server stop`

Stop the running server.

```bash
cfcf server stop
```

### `cfcf server status`

Check if the server is running and show details.

```bash
cfcf server status
```

Output:
```
cfcf server v0.7.0
  Status:     running
  Port:       7233
  PID:        12345
  Uptime:     42s
  Configured: yes
  Agents:     claude-code, codex
```

The same information (plus the full global config) is available in the
web GUI at `http://localhost:7233/#/server`. Since v0.7.3 that page is
a full editor -- wire-compatible with `cfcf config edit` via the same
`PUT /api/config` endpoint. Reach it from the **Settings** link in the
top bar.

---

## Global Configuration

### `cfcf config show`

Display the current global configuration.

```bash
cfcf config show
```

Output:
```
Config file: /Users/you/Library/Application Support/cfcf/config.json
Dev agent:        claude-code
Judge agent:      codex
Architect agent:  claude-code
Documenter agent: claude-code
Reflection agent: claude-code (model: opus)
Max iterations:   10
Pause every:      never
Reflect safeguard: force after 3 consecutive judge opt-outs
Permissions:      acknowledged
Available agents: claude-code, codex
```

### `cfcf config edit`

Re-run the interactive setup (same as `cfcf init --force`).

```bash
cfcf config edit
```

---

## Quick Status

### `cfcf status`

One-command overview of cfcf state: configuration, server status, and active workspace loops.

```bash
cfcf status                          # Overview of everything
cfcf status --workspace my-project     # Detailed loop status for a workspace
```

With `--workspace`, shows the current loop phase, iteration progress, judge determinations, and pending questions.

---

## Workspace Management

Workspaces link cfcf to a local git repository. Each workspace has its own configuration (agents, iteration limits, etc.) that inherits from the global defaults.

### `cfcf workspace init`

Create a new cfcf workspace linked to a git repository.

```bash
cfcf workspace init --repo /path/to/my-project --name my-project
```

The repo must be:
- An existing directory
- A git repository (has been `git init`'d)
- Has at least one commit

Options:
- `--repo <path>` (required) -- Absolute or relative path to the git repo
- `--name <name>` (required) -- Human-readable workspace name

The workspace inherits agent settings from your global config. To override per-workspace, use the API or edit the workspace config file directly.

### `cfcf workspace list`

List all workspaces.

```bash
cfcf workspace list
```

### `cfcf workspace show`

Show detailed configuration for a workspace.

```bash
cfcf workspace show my-project
```

### `cfcf workspace delete`

Delete a workspace from cfcf. This removes the cfcf config only -- your git repo is untouched.

```bash
cfcf workspace delete my-project
```

---

## Solution Architect Review

### `cfcf review`

Run the Solution Architect agent to review your Problem Pack before starting unattended development. Advisory, repeatable -- run as many times as you like.

```bash
cfcf review --workspace my-project
```

What the architect does:
1. Reviews problem.md, success.md, constraints, hints, and context files
2. Checks context completeness -- is there enough for a dev agent to work unattended?
3. Identifies gaps and ambiguities that would cause an engineer to ask questions
4. Runs an initial security assessment
5. Outlines solution options and trade-offs
6. **Produces an implementation plan** (`cfcf-docs/plan.md`) for the dev agent to build on
7. Writes a readiness assessment: READY / NEEDS_REFINEMENT / BLOCKED

### First-run vs re-review mode (v0.7.0+)

The architect automatically detects which mode to use:

- **First-run mode:** `cfcf-docs/plan.md` is absent or has no completed items. The architect produces a fresh plan from scratch and scaffolds the initial `docs/` stubs.
- **Re-review mode:** `cfcf-docs/plan.md` already has completed `[x]` items. The architect reads the full prior history (iteration logs, decision log, reflection reviews), compares to the current Problem Pack, and either:
  - **Appends** new pending iterations when new requirements are detected (completed items never touched), or
  - Leaves `plan.md` alone and says so in `architect-review.md` when the existing plan still covers the pack.

  cf² enforces the non-destructive rule: if the architect's rewrite removes a completed item or an iteration header, `plan.md` is auto-reverted to the pre-spawn snapshot and a warning is logged. Re-review also skips re-scaffolding `docs/*.md` (already maintained by dev + documenter).

Typical flow:
```bash
cfcf review --workspace my-project     # Architect identifies gaps
# → User reads architect-review.md, refines problem-pack/
cfcf review --workspace my-project     # Re-review after changes
# → Architect says READY
cfcf run --workspace my-project        # Start unattended development
```

---

## Running Iterations

### `cfcf run` -- Dark Factory Loop

Start the full iteration loop. Each iteration runs `dev → judge → reflect (conditional) → decide` and produces up to three separate commits; when `autoReviewSpecs=true` a leading pre-loop `review` phase runs on main and gates the loop on the architect's readiness signal; when the judge determines SUCCESS, `documenter` runs (unless `autoDocumenter=false`). This is the primary workflow.

```bash
cfcf run --workspace my-project
```

What happens:
1. Starts the iteration loop asynchronously.
2. **Pre-loop review (conditional, `autoReviewSpecs=true`).** Runs on `main`. Solution Architect reviews the Problem Pack, commits `architect-review.md` + `plan.md` + signals + doc stubs as `cfcf pre-loop review (<readiness>)`. If the `readinessGate` rejects, the loop pauses with the architect's gaps as `pendingQuestions`; on Resume the architect re-runs (see `cfcf resume` below). If the gate accepts, the loop enters iteration 1 branched off `main`.
3. For each iteration:
   a. Reads the Problem Pack, rebuilds `iteration-history.md` from committed iteration-logs, assembles context (`cfcf-docs/` + sentinel-merged CLAUDE.md/AGENTS.md).
   b. Creates a git feature branch: `cfcf/iteration-N`.
   c. Launches the **dev agent** with the assembled context. Commits as `cfcf iteration N dev (<adapter>)`.
   d. Launches the **judge agent** to evaluate the iteration. Archives the assessment. Commits as `cfcf iteration N judge (<adapter>)`.
   e. Launches the **reflection agent** (conditional -- runs unless the judge set `reflection_needed: false` AND the `reflectSafeguardAfter` ceiling hasn't been hit). Non-destructively rewrites pending plan items when the evidence warrants. Commits as `cfcf iteration N reflect (<health>): <key_observation>`.
   f. Decision engine evaluates judge + reflection signals:
      - SUCCESS → run Documenter (unless `autoDocumenter=false`), merge, push to remote, stop.
      - PROGRESS → continue to next iteration.
      - STALLED → apply `onStalled` policy (continue / stop / alert).
      - ANOMALY → pause and alert user.
      - Reflection `recommend_stop: true` → pause (takes precedence over a judge `continue`).
   g. If pause cadence reached → pause and wait for user review.
   h. If auto-merge enabled → merge the iteration branch to `main`.
4. The CLI polls for status, showing phase transitions in real-time.
5. On pause: shows questions and hints for `cfcf resume`.
6. On completion: shows iteration history and outcome.

Options:
- `--workspace <name>` (required) -- workspace name or ID
- `--problem-pack <path>` (optional) -- custom Problem Pack path (default: `<repo>/problem-pack/`)
- `--auto-review` / `--no-auto-review` (optional, item 5.1) -- per-run override: force the Solution Architect to run as a pre-loop phase (`--auto-review`) or skip it (`--no-auto-review`). When the flag is omitted the workspace's `autoReviewSpecs` config value decides.
- `--auto-document` / `--no-auto-document` (optional, item 5.1) -- per-run override for the post-SUCCESS Documenter. When omitted the workspace's `autoDocumenter` config value decides.
- `--readiness-gate <level>` (optional, item 5.1) -- per-run override for the pre-loop readiness gate: `never | blocked | needs_refinement_or_blocked`. Only consulted when auto-review is on.

Per-run overrides are persisted on `loop-state.json` for this run, so a pause + resume keeps the same behaviour across server restarts.

### `cfcf run` -- Manual Mode

Run any command within a workspace (for testing, debugging, or non-agent tasks).

```bash
cfcf run --workspace my-project -- echo "hello"
cfcf run --workspace my-project -- npm test
cfcf run --workspace my-project -- make build
```

Same branch/commit/log behavior, but without context assembly or agent launching.

### Problem Pack

The Problem Pack is a directory of Markdown files that define your problem. Located at `<repo>/problem-pack/` by default (scaffolded by `cfcf workspace init`).

Required files:
- `problem.md` -- what needs to be built or fixed
- `success.md` -- how success is measured (test criteria)

Optional files:
- `constraints.md` -- guardrails, limitations
- `hints.md` -- technical hints, preferred approaches
- `style-guide.md` -- code style guidelines
- `context/` -- additional context (architecture docs, API specs, etc.)

### cfcf-docs/ (Generated by cfcf)

When running in agent mode, cfcf writes a `cfcf-docs/` directory into the repo. This contains:
- Process definition, iteration history, judge feedback, user feedback
- Templates for the agent to fill in (handoff document, signal file)
- The agent's evolving plan and decision log

These files are tracked in git. See `docs/design/agent-process-and-context.md` for the full specification.

---

## Loop Control

### `cfcf resume`

Resume a paused iteration loop. The loop pauses when:
- Pause cadence is reached (every N iterations).
- The dev agent or judge signals `user_input_needed`.
- The judge detects an anomaly (token exhaustion, circling, etc.).
- The reflection agent sets `recommend_stop: true`.
- **The pre-loop Solution Architect's readiness signal fails the `readinessGate`** (when `autoReviewSpecs=true`). In this case the loop hasn't yet entered iteration 1 -- it paused before the first iteration branch was created.

```bash
cfcf resume --workspace my-project
cfcf resume --workspace my-project --feedback "Focus on error handling in the API layer"
```

The optional `--feedback` text is written to `cfcf-docs/user-feedback.md` and read by the next agent spawn. Two distinct code paths use this, both via the same flag:

| Pause reason | Who reads the feedback |
|---|---|
| Pre-loop review blocked | The architect on the next pre-loop spawn (re-review mode if applicable). |
| Any in-loop pause (cadence, anomaly, stalled, dev/judge user_input_needed, reflection recommend_stop) | The dev agent at the start of the next iteration; carried through to that iteration's `cfcf-docs/user-feedback.md`. |

In both cases cfcf clears `state.userFeedback` once the consuming agent has been spawned, so later iterations don't silently inherit stale guidance.

**Pre-loop review resume tips:**
- Fastest path: edit `problem-pack/problem.md` (and `success.md` if needed) to close the gaps the architect listed as `pendingQuestions`, then `cfcf resume --workspace <name>` with no feedback. The architect re-reads the source.
- Faster-still path for tiny clarifications: skip the edit and pass `--feedback "..."`. The architect sees your text in `user-feedback.md` on the next spawn.
- Status peek: `cfcf status --workspace <name>` prints the current `pendingQuestions` so you can see exactly what the architect asked before you type your answer.

### `cfcf document`

Run the Documenter agent to produce polished final workspace documentation. This runs automatically when the loop completes with SUCCESS, but you can also invoke it manually at any time.

```bash
cfcf document --workspace my-project
```

The documenter reads the entire codebase and produces:
- `docs/architecture.md` — system architecture overview
- `docs/api-reference.md` — API documentation (if applicable)
- `docs/setup-guide.md` — setup and usage guide
- `docs/README.md` — workspace overview and quick start

Re-run anytime to regenerate documentation after changes.

### `cfcf reflect`

Run the Reflection agent ad-hoc against the current state of a workspace.
Outside the iteration loop; does NOT modify `loop-state.json` and does
NOT write an `iteration-log` (no iteration happened). Useful for a
strategic health-check between loop runs, or after editing the Problem
Pack and before kicking off the next `cfcf run`.

```bash
cfcf reflect --workspace my-project
cfcf reflect --workspace my-project --prompt "focus on the auth-layer drift"
```

What the reflection agent does:
1. Reads the full cross-iteration history: `decision-log.md`, all
   `iteration-logs/iteration-*.md`, all prior `iteration-reviews/*.md`,
   any prior `reflection-reviews/*.md`, a compact per-iteration-branch
   git log assembled by cfcf, and the tail (~500 lines) of the most
   recent dev log.
2. Classifies iteration health (`converging | stable | stalled | diverging | inconclusive`) with reasoning.
3. Optionally rewrites the **pending** portion of `cfcf-docs/plan.md`.
   Completed items and iteration headers are protected: any destructive
   rewrite is auto-reverted and logged.
4. May set `recommend_stop: true` to escalate to the user -- during a
   loop this pauses it; ad-hoc it just shows up in `architect-review`-style
   output.
5. Appends a `decision-log.md` entry (category `strategy`) summarising
   what changed and why.

Results:
- `cfcf-docs/reflection-analysis.md` -- human-readable cross-iteration analysis
- `cfcf-docs/cfcf-reflection-signals.json` -- parsed signals for cfcf + UI
- Optional: non-destructive edits to `cfcf-docs/plan.md`
- Entry in `cfcf-docs/decision-log.md`

Web parity: `POST /api/workspaces/:id/reflect` (see `docs/api/server-api.md`).

### `cfcf stop`

Stop a running or paused iteration loop.

```bash
cfcf stop --workspace my-project
```

The iteration branch is preserved. You can review the code, then restart with `cfcf run`.

---

## Clio — cross-workspace memory (item 5.7)

Clio is cf²'s persistent memory layer. See [Clio quickstart](clio-quickstart.md) for the full walkthrough; the commands are:

```bash
# Search. Modes: fts | hybrid | semantic. Default mode is auto:
#   - active embedder present → hybrid (RRF over FTS + vector)
#   - no active embedder      → fts
# Override per-call with --mode, or set clio.defaultSearchMode in the
# global config (visible + editable in the Web UI's Server Info page).
cfcf clio search "flaky auth tests"
cfcf clio search "flaky auth tests" --mode hybrid                # force a mode
cfcf clio search "flaky auth tests" --min-score 0.4              # widen vector recall (default 0.5)
cfcf clio search "flaky auth tests" --project <name> --match-count 5 \
                                    --metadata '{"role":"reflection"}' --json

# Ingest a markdown doc (or pipe via --stdin)
cfcf clio ingest path/to/note.md --project cf-ecosystem --title "Note" [--artifact-type design-guideline] [--tier semantic] [--tags a,b,c]
cat note.md | cfcf clio ingest --stdin --project cf-ecosystem --title "Note"

# Browse / retrieve
cfcf clio docs list [--project <name>] [--limit 50] [--offset 0] [--json]   # newest first
cfcf clio get <document-id> [--json]

# Projects (grouping of workspaces by knowledge domain)
cfcf clio projects [--json]
cfcf clio project create <name> [--description "..."]
cfcf clio project show <name-or-id>

# Embedder (controls hybrid/semantic search). Default model installed
# during cfcf init is nomic-embed-text-v1.5 (q8, 768d, 8k token context).
cfcf clio embedder list                            # catalogue with active marker
cfcf clio embedder active                          # current active embedder (or "none")
cfcf clio embedder install                         # uses clio.preferredEmbedder from config
cfcf clio embedder install nomic-embed-text-v1.5   # explicit
cfcf clio embedder set <name> --reindex            # safe switch: re-embeds existing chunks
cfcf clio embedder set <name> --force              # recovery only; degrades vector search until reindex

# Re-embed existing chunks under the active embedder. Idempotent
# (skips chunks already matching). Pair with `embedder set --reindex`
# for the canonical switch flow.
cfcf clio reindex [--project <name>] [--force] [--batch-size 32] [--json]

# Introspection
cfcf clio stats [--json]
```

`cfcf memory` is a top-level alias that points at the same command tree — `cfcf memory search "..."` works identically.

### Workspace ↔ Clio Project assignment

```bash
# At init time
cfcf workspace init --repo <path> --name <name> --project <clio-project>   # flag-driven
cfcf workspace init --repo <path> --name <name>                             # interactive pick

# Later
cfcf workspace set <name> --project <new-clio-project>                      # future ingests only
cfcf workspace set <name> --project <new-clio-project> --migrate-history    # rekey historical docs too
```

---

## Configuration Storage

cfcf stores configuration in the platform-standard directory:

| Platform | Location |
|----------|----------|
| macOS | `~/Library/Application Support/cfcf/` |
| Linux | `~/.config/cfcf/` |
| Windows | `%APPDATA%/cfcf/` |

Override with `CFCF_CONFIG_DIR` environment variable.

### Directory structure:

```
cfcf config dir/
  config.json               # Global config (from cfcf init)
  server.pid                # Server PID file (when running)
  workspaces/
    my-workspace-a1b2c3/
      config.json           # Workspace-specific config
      loop-state.json       # Current loop run state (phase, iterations, etc.)
      history.json          # Persistent history of all agent runs (reviews, iterations, documents)
```

### Log storage:

Agent output logs are stored separately (they can be large):

```
~/.cfcf/
  logs/
    my-project-a1b2c3/
      iteration-001-dev.log       # Dev agent log per iteration
      iteration-001-judge.log     # Judge agent log per iteration
      reflection-001.log          # Nth reflection run (loop or ad-hoc)
      architect-001.log           # Nth architect review
      documenter-001.log          # Nth documenter run
      notifications.log           # JSON Lines audit trail of notifications
```

Each architect / documenter / reflection invocation gets its own
sequence-numbered log so re-running preserves history.

Override with `CFCF_LOGS_DIR` environment variable.

---

## Notifications

cfcf can ping you at key moments during long-running unattended loops so you
can walk away and get notified only when needed. This is the "dark factory"
operating mode.

### Events

- **`loop.paused`** — Loop pauses because of the review cadence, agent questions, an anomaly, or reaching max iterations
- **`loop.completed`** — Loop reaches a terminal state (success, failure, stopped, max iterations)
- **`agent.failed`** — An agent process exits with non-zero status and no signals (e.g., judge config was wrong)

### Channels

| Channel | What it does | Platforms |
|---------|-------------|-----------|
| `terminal-bell` | Writes the ASCII BEL character (`\a`) to server stderr — most terminals beep or flash | all |
| `macos` | Native macOS Notification Center entry via `osascript` | macOS only |
| `linux` | Native Linux desktop notification via `notify-send` (part of libnotify) | Linux only |
| `log` | Appends a JSON Lines entry to `~/.cfcf/logs/<workspace>/notifications.log` — always-on audit trail | all |

### Configuration

Configured via `cfcf init` or by editing the global config file directly:

```json
{
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

Set `enabled: false` to disable all notifications. Remove channels from
a specific event's array to silence that event. Workspace config can
override the global default.

### Notes

- macOS notifications require Terminal.app (or the calling terminal) to have
  notification permission in System Settings → Notifications. First use may
  silently fail if permission has never been granted.
- Dispatch is fire-and-forget with a 5-second per-channel timeout. A slow or
  failing channel never blocks the loop or other channels.
- No rate limiting in v1 — if you set `pauseEvery: 1`, you'll get a
  notification on every iteration.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CFCF_PORT` | `7233` | Server port |
| `CFCF_CONFIG_DIR` | (platform-specific) | Config directory override |
| `CFCF_LOGS_DIR` | `~/.cfcf/logs` | Log directory override |

---

## Typical Workflow

```bash
# One-time setup
cfcf init                                          # Configure agents and defaults
cfcf server start                                  # Start the server

# Per-workspace setup
cfcf workspace init --repo /path/to/repo --name my-app

# Define the problem
# Edit problem-pack/problem.md and success.md with your problem definition

# Architect review (recommended before unattended development)
cfcf review --workspace my-app                       # Architect identifies gaps
# Read cfcf-docs/architect-review.md, refine problem-pack/
cfcf review --workspace my-app                       # Re-review after refinements
                                                    # (re-review-aware on existing workspaces)

# Start the dark factory loop
cfcf run --workspace my-app
# cfcf runs: dev → judge → reflect (unless judge opts out) → decide → repeat
# Three separate commits per iteration: dev / judge / reflect
# On SUCCESS: documenter runs automatically to produce final docs
# On pause: review and provide feedback
cfcf resume --workspace my-app --feedback "Focus on X"

# Ad-hoc strategic health-check (no iteration)
cfcf reflect --workspace my-app
cfcf reflect --workspace my-app --prompt "focus on auth-layer drift"

# Monitor progress anytime
cfcf status --workspace my-app

# Stop if needed
cfcf stop --workspace my-app
```
