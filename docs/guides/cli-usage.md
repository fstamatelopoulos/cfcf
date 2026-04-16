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
3. Asks you to choose agents for all four roles (dev, judge, architect, documenter)
4. Asks for model selection per role (optional)
5. Asks for default iteration limits (max iterations, pause cadence)
5. Explains the permission flags agents will run with (`--dangerously-skip-permissions` for Claude Code, `-a never -s danger-full-access` for Codex)
6. Saves everything to the config file

To re-run setup (e.g., after installing a new agent):

```bash
cfcf init --force
```

---

## Server Management

cfcf runs a background server that manages projects, executes iterations, and streams logs. The CLI communicates with the server via HTTP.

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
cfcf server v0.0.0
  Status:     running
  Port:       7233
  PID:        12345
  Uptime:     42s
  Configured: yes
  Agents:     claude-code, codex
```

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
Dev agent:       claude-code
Judge agent:     codex
Max iterations:  10
Pause every:     never
Permissions:     acknowledged
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

One-command overview of cfcf state: configuration, server status, and active project loops.

```bash
cfcf status                          # Overview of everything
cfcf status --project my-project     # Detailed loop status for a project
```

With `--project`, shows the current loop phase, iteration progress, judge determinations, and pending questions.

---

## Project Management

Projects link cfcf to a local git repository. Each project has its own configuration (agents, iteration limits, etc.) that inherits from the global defaults.

### `cfcf project init`

Create a new cfcf project linked to a git repository.

```bash
cfcf project init --repo /path/to/my-project --name my-project
```

The repo must be:
- An existing directory
- A git repository (has been `git init`'d)
- Has at least one commit

Options:
- `--repo <path>` (required) -- Absolute or relative path to the git repo
- `--name <name>` (required) -- Human-readable project name
- `--repo-url <url>` (optional) -- Remote git URL for push

The project inherits agent settings from your global config. To override per-project, use the API or edit the project config file directly.

### `cfcf project list`

List all projects.

```bash
cfcf project list
```

### `cfcf project show`

Show detailed configuration for a project.

```bash
cfcf project show my-project
```

### `cfcf project delete`

Delete a project from cfcf. This removes the cfcf config only -- your git repo is untouched.

```bash
cfcf project delete my-project
```

---

## Solution Architect Review

### `cfcf review`

Run the Solution Architect agent to review your Problem Pack before starting unattended development. Advisory, repeatable -- run as many times as you like.

```bash
cfcf review --project my-project
```

What the architect does:
1. Reviews problem.md, success.md, constraints, hints, and context files
2. Checks context completeness -- is there enough for a dev agent to work unattended?
3. Identifies gaps and ambiguities that would cause an engineer to ask questions
4. Runs an initial security assessment
5. Outlines solution options and trade-offs
6. **Produces an initial implementation plan** (`cfcf-docs/plan.md`) for the dev agent to build on
7. Writes a readiness assessment: READY / NEEDS_REFINEMENT / BLOCKED

Typical flow:
```bash
cfcf review --project my-project     # Architect identifies gaps
# → User reads architect-review.md, refines problem-pack/
cfcf review --project my-project     # Re-review after changes
# → Architect says READY
cfcf run --project my-project        # Start unattended development
```

---

## Running Iterations

### `cfcf run` -- Dark Factory Loop

Start the full iteration loop: dev → judge → decide → repeat. This is the primary workflow.

```bash
cfcf run --project my-project
```

What happens:
1. Starts the iteration loop asynchronously
2. For each iteration:
   a. Reads the Problem Pack and assembles context (CLAUDE.md + cfcf-docs/)
   b. Creates a git feature branch: `cfcf/iteration-N`
   c. Launches the dev agent with assembled context
   d. Commits dev work to the feature branch
   e. Launches the judge agent to evaluate the iteration
   f. Commits judge assessment, archives to iteration-reviews/
   g. Decision engine evaluates judge signals:
      - SUCCESS → stop, push to remote
      - PROGRESS → continue to next iteration
      - STALLED → apply onStalled policy (continue/stop/alert)
      - ANOMALY → pause and alert user
   h. If pause cadence reached → pause and wait for user review
   i. If auto-merge enabled → merge branch to main
3. The CLI polls for status, showing phase transitions in real-time
4. On pause: shows questions and hints for `cfcf resume`
5. On completion: shows iteration history and outcome

Options:
- `--project <name>` (required) -- project name or ID
- `--problem-pack <path>` (optional) -- custom Problem Pack path (default: `<repo>/problem-pack/`)

### `cfcf run` -- Manual Mode

Run any command within a project (for testing, debugging, or non-agent tasks).

```bash
cfcf run --project my-project -- echo "hello"
cfcf run --project my-project -- npm test
cfcf run --project my-project -- make build
```

Same branch/commit/log behavior, but without context assembly or agent launching.

### Problem Pack

The Problem Pack is a directory of Markdown files that define your problem. Located at `<repo>/problem-pack/` by default (scaffolded by `cfcf project init`).

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
- Pause cadence is reached (every N iterations)
- The dev agent or judge signals `user_input_needed`
- The judge detects an anomaly (token exhaustion, circling, etc.)

```bash
cfcf resume --project my-project
cfcf resume --project my-project --feedback "Focus on error handling in the API layer"
```

The optional `--feedback` text is injected into the next iteration's context as user direction.

### `cfcf document`

Run the Documenter agent to produce polished final project documentation. This runs automatically when the loop completes with SUCCESS, but you can also invoke it manually at any time.

```bash
cfcf document --project my-project
```

The documenter reads the entire codebase and produces:
- `docs/architecture.md` — system architecture overview
- `docs/api-reference.md` — API documentation (if applicable)
- `docs/setup-guide.md` — setup and usage guide
- `docs/README.md` — project overview and quick start

Re-run anytime to regenerate documentation after changes.

### `cfcf stop`

Stop a running or paused iteration loop.

```bash
cfcf stop --project my-project
```

The iteration branch is preserved. You can review the code, then restart with `cfcf run`.

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
  projects/
    my-project-a1b2c3/
      config.json           # Project-specific config
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
      architect-001.log           # Nth architect review
      documenter-001.log          # Nth documenter run
```

Each architect/documenter invocation gets its own sequence-numbered log
so re-running preserves history.

Override with `CFCF_LOGS_DIR` environment variable.

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

# Per-project setup
cfcf project init --repo /path/to/repo --name my-app

# Define the problem
# Edit problem-pack/problem.md and success.md with your problem definition

# Architect review (recommended before unattended development)
cfcf review --project my-app                       # Architect identifies gaps
# Read cfcf-docs/architect-review.md, refine problem-pack/
cfcf review --project my-app                       # Re-review after refinements

# Start the dark factory loop
cfcf run --project my-app
# cfcf runs: dev agent → judge → decide → repeat
# On SUCCESS: documenter runs automatically to produce final docs
# On pause: review and provide feedback
cfcf resume --project my-app --feedback "Focus on X"

# Monitor progress anytime
cfcf status --project my-app

# Stop if needed
cfcf stop --project my-app
```
