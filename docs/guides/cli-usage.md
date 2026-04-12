# cfcf CLI Usage Guide

This guide covers all cfcf commands and typical workflows.

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
3. Asks you to choose a default dev agent and judge agent
4. Asks for default iteration limits (max iterations, pause cadence)
5. Explains the permission flags agents will run with (`--dangerously-skip-permissions` for Claude Code, `--approval-mode full-auto` for Codex)
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

One-command overview of cfcf state: configuration and server status.

```bash
cfcf status
```

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

## Running Commands

### `cfcf run`

Execute a command within a cfcf project. This is the core operation -- it creates a feature branch, runs your command, captures all output, and commits the results.

```bash
cfcf run --project my-project -- echo "hello"
cfcf run --project my-project -- npm test
cfcf run --project my-project -- make build
```

What happens:
1. Creates a git feature branch: `cfcf/iteration-1`
2. Runs the command in the project's repo directory
3. Captures all stdout/stderr to `~/.cfcf/logs/`
4. If the command changed any files, commits them to the feature branch
5. Reports: iteration number, branch, exit code, duration, log location

In future iterations, this will be `cfcf run --project my-project` (no `--` command) and cfcf will automatically launch the configured AI agent.

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
```

### Log storage:

Agent output logs are stored separately (they can be large):

```
~/.cfcf/
  logs/
    my-project-a1b2c3/
      iteration-001-dev.log
      iteration-001-judge.log
```

Override with `CFCF_LOGS_DIR` environment variable.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CFCF_PORT` | `7233` | Server port |
| `CFCF_CONFIG_DIR` | (platform-specific) | Config directory override |
| `CFCF_LOGS_DIR` | `~/.cfcf/logs` | Log directory override |

---

## Typical Workflow (Current)

```bash
# One-time setup
cfcf init
cfcf server start

# Per-project setup
cfcf project init --repo /path/to/repo --name my-app

# Run commands (iteration 1: manual commands)
cfcf run --project my-app -- npm test

# Check what happened
cd /path/to/repo && git log --oneline --all | grep cfcf
```

## Typical Workflow (Future -- after iteration 2+)

```bash
# One-time setup
cfcf init
cfcf server start

# Per-project setup
cfcf project init --repo /path/to/repo --name my-app

# Provide problem definition
# (populate cfcf-docs/ with problem.md, success.md, etc.)

# Start iterating
cfcf iterate --project my-app --max-iterations 10 --pause-every 3

# cfcf runs the loop: dev agent → judge → next iteration → pause for review → repeat
# You review when prompted, or check status anytime:
cfcf status
```
