# cfcf: Cerefox Code Factory -- Technology Stack

## Overview

cfcf (Cerefox Code Factory, also written cf² and pronounced "cf square") is a deterministic coding orchestration harness. It spawns AI dev agents as local processes and coordinates them through structured, uninterrupted iteration cycles. Iterations run headless by design. The human user is on the loop, not in it -- optionally reviewing and providing direction between iterations at a cadence they configure, rather than being interrupted mid-run. LLMs and AI agents are pluggable components; cfcf is vendor, agent, and model agnostic at its core.

---

## Design Principles

- **Vendor agnostic**: No LLM vendor or AI dev agent is a first-class citizen. Claude Code, Codex, OpenCode, Cline, Goose, OpenHands, Cursor Agent, and others are all pluggable via a common abstraction layer.
- **Deterministic orchestration**: LLMs and agents serve as utility evaluators and executors, not decision-makers. Control flow is deterministic and defined by cfcf.
- **No prerequisites for end users**: Distributed as a self-contained binary. No Node, no Bun, no runtime install required.
- **Progressive complexity**: Starts with a single-agent sequential flow. Multi-agent and hierarchical flows are supported by design but not required upfront.
- **Human on the loop**: Iterations run uninterrupted and headless by design. The human user may configure cfcf to pause every N iterations to review results, the plan, or the code, and optionally provide corrective direction or refined requirements before the next iteration begins.

---

## Language and Runtime

### TypeScript

TypeScript is the primary language for all cfcf components: CLI, server, and web GUI (if applicable). Rationale:

- Strong typing is valuable for an evolving spec with many moving parts (agent configs, iteration state, message schemas).
- Shared types across CLI, server, and GUI in a monorepo eliminate a major source of drift.
- The npm ecosystem has mature libraries for process management, terminal UI, HTTP servers, and AI SDK integration.
- TypeScript is the dominant language in the AI agent tooling ecosystem, making it easier to integrate with and learn from adjacent projects.

### Bun

Bun is the runtime and toolchain. It is fully compatible with Node.js APIs and npm packages, but adds:

- **Single binary compilation**: `bun build --compile` produces a self-contained executable with the Bun runtime embedded. No external runtime dependency for end users.
- **Cross-compilation**: Targets include `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, and `windows-x64`. All built from a single codebase.
- **Performance**: Faster startup and execution than Node for CLI-heavy workloads.
- **Unified toolchain**: Package manager, test runner, bundler, and runtime in one tool. Reduces CI complexity.

---

## Distribution and Installation

### Approach: Curl Install Script

End users install cfcf with a single command, no prerequisites:

```bash
curl -fsSL https://cf-cf.dev/install.sh | sh
```

The install script:

1. Detects the user's OS and architecture.
2. Downloads the correct pre-built binary from the GitHub Releases page (e.g. `cf-cf-darwin-arm64`, `cf-cf-linux-x64`, `cf-cf-windows-x64.exe`).
3. Places the binary in the user's PATH.

This is the same distribution model used by Claude Code and similar tools. It requires no package manager, no runtime, and no elevated permissions beyond writing to a local bin directory.

### Release Pipeline

On each tagged release, CI (GitHub Actions) runs `bun build --compile --target=<platform>` for each supported target and uploads the binaries as release artifacts. The install script always pulls from the latest release tag.

---

## Component Architecture

### CLI Layer

- **Framework**: Commander.js for command and subcommand routing.
- **Terminal UI**: Ink (React-based terminal rendering). Used for interactive iteration display, agent status, open question prompts, and progress indicators.
- **Entry point**: A single compiled binary (`cf-cf`) that routes to subcommands (`cf-cf iterate`, `cf-cf init`, `cf-cf status`, `cf-cf logs`, etc.).

### Server Layer

- **Framework**: Hono -- lightweight, fast, runs on Bun natively.
- **Role**: Manages project and iteration lifecycles, exposes a local API consumed by both the CLI and the web GUI, manages agent process lifecycles, and streams logs and events.
- **Transport**: HTTP/SSE for streaming event output to the web GUI. WebSocket as an option for bidirectional agent communication.

### Web GUI (Optional, Deferred)

The CLI is the primary interface. A local web GUI is planned for use cases that benefit from richer visualization:

- Iteration history and diffs.
- Agent telemetry and token usage.
- Configuration management.
- Real-time log streaming.
- Dependency and call graphs.

When implemented, the GUI will be a React app served by the Hono server on localhost. It shares types with the server via the monorepo. Remote access (tunneled or network-exposed) is a configuration option.

---

## Agent Abstraction Layer

cfcf treats all LLMs and AI dev agents as interchangeable components behind a common interface. The abstraction layer handles:

- **Agent adapters**: One adapter per supported agent type (Claude Code, Codex, OpenCode, Cline, Goose, OpenHands, Cursor Agent, etc.). Each adapter implements a standard interface: `initialize`, `submitTask`, `getOutput`, `getStatus`, `terminate`.
- **Model adapters**: For cases where cfcf calls LLM APIs directly (e.g. for evaluation or planning steps), a model abstraction wraps vendor SDKs (Anthropic, OpenAI, Google, etc.) behind a common `complete(prompt, options)` interface.
- **Configuration-driven**: Users specify which agent and model to use per role in a cfcf config file. Swapping agents or models requires only a config change, not code changes.

Vendor SDKs (e.g. Anthropic SDK, OpenAI SDK) may be used internally within specific adapters, but they never leak into cfcf's core orchestration logic.

---

## Execution Model: Local Processes

Agents run as **local processes** in the user's normal development environment -- not inside Docker containers. cfcf spawns agent CLI processes, captures their output, and manages their lifecycle.

- **Process spawning**: Bun's native `Bun.spawn()` (or `child_process.spawn()` for compatibility). Non-blocking, async.
- **Isolation**: Git branches provide state isolation between iterations. Each iteration operates on a dedicated `cfcf/iteration-N` branch. The user's working branch is never modified.
- **Output capture**: Agent stdout/stderr is streamed to the cfcf server (for SSE to clients) and simultaneously written to disk in cfcf's external memory directory.
- **Authentication**: Agents use the user's existing local credentials. cfcf does not manage API keys or agent authentication. The user must have their agents installed and authenticated before starting iteration.
- **Unattended execution**: Agents run with permission-skip flags (e.g., `--dangerously-skip-permissions` for Claude Code) to enable fully unattended operation.

### Per-Iteration Setup

For each iteration, cfcf:

1. Ensures the repo is on the correct cfcf git branch.
2. Generates agent-specific instruction files (e.g., `CLAUDE.md`) from the assembled context.
3. Writes cfcf-managed context files to the `cfcf-docs/` directory in the repo.
4. Spawns the dev agent as a local process in the project directory.
5. Streams and captures all stdout/stderr.
6. Waits for the agent process to exit.
7. Reads the agent's output artifacts (handoff document, signal file).
8. Commits all changes to the cfcf branch.
9. Spawns the judge agent in the same directory.
10. Commits judge output. Proceeds to the next iteration or stops.

### Why Not Containers?

Containers were considered and deferred. The key reasons for local processes:

- **Zero prerequisites**: No Docker install required. cfcf binary + installed agents is all you need.
- **Reuses agent auth**: CLI agents (Claude Code, Codex) use OAuth and local auth flows that are complex to replicate inside a container.
- **Environment parity**: The agent runs in the exact environment the user develops in -- same tools, same runtimes, same configs.
- **Speed**: No container create/teardown overhead per iteration.

Container-based execution is a future option for users who want stronger isolation (CI environments, paranoid mode). The process manager interface is designed so a container backend can be swapped in without changing other components.

---

## Service Mode

cfcf runs as a background service on the user's machine. The server process manages iteration lifecycles, agent process orchestration, and event streaming. The CLI (and future web GUI) are thin clients that communicate with the server via a local HTTP API.

- **Start**: `cfcf server start` launches the server as a background process. Auto-start on boot is an optional setup step (via launchd on macOS, systemd on Linux, or a Windows service).
- **Communication**: CLI talks to the server via HTTP on a configurable local port (default: `localhost:7233`).
- **Event streaming**: The server exposes an SSE endpoint for real-time updates (iteration progress, test results, alerts). The CLI and web GUI subscribe to this stream.
- **Notifications**: The server can alert the user via multiple channels when iterations complete, pause for review, or encounter errors. Initially: terminal notifications. Planned: Slack, email, webhook integrations.
- **Graceful degradation**: If the server is not running, `cfcf iterate` can operate in "direct mode" -- running the iteration loop in the foreground CLI process. This is useful for quick one-off iterations and development/debugging of cfcf itself.

---

## Agent Communication (Multi-Agent)

Single-agent sequential flow is the initial target. The architecture is designed to support multi-agent flows without requiring a rewrite.

For multi-agent scenarios, cfcf will implement a messaging layer between agent processes:

- **Approach**: A lightweight message bus embedded in the cfcf server, exposed to agents via local HTTP endpoint or structured files in the repo.
- **Model**: The chief agent uses cfcf CLI commands to spawn and manage sub-agents. Communication is mediated by cfcf -- agents don't talk directly to each other. This is conceptually similar to a tmux pane model where sub-panels communicate via messages, but mediated by cfcf rather than terminal multiplexing.
- **Supported topologies**:
  - **Sequential**: Agent A completes, output passed to Agent B.
  - **Hierarchical**: An orchestrator agent delegates subtasks to specialist agents.
  - **Parallel with merge**: Multiple agents work on isolated subtasks, results merged by cfcf before the next iteration.

Role-to-agent assignment is user-configurable. A user might assign the planning role to Claude Code and the implementation role to Goose, for example.

---

## Monorepo Structure

```
cf-cf/
  packages/
    cli/          # Commander + Ink, compiled to binary
    server/       # Hono server, session and process management
    core/         # Shared types, agent abstraction layer, orchestration logic
    adapters/     # One package per agent/model adapter
    web/          # React GUI (served by Hono server)
  scripts/
    build.sh      # Cross-platform binary compilation
    install.sh    # Curl install script template
  .github/
    workflows/
      release.yml # CI: build all targets, publish to GitHub Releases
```

---

## Key Dependencies

| Concern | Package |
|---|---|
| CLI routing | Commander.js |
| Terminal UI | Ink + @inkjs/ui |
| HTTP server | Hono |
| Process management | Bun.spawn() (built-in) |
| Testing | Bun test (built-in) |
| Monorepo | npm workspaces |
| Build/release | Bun + GitHub Actions |

Vendor AI SDKs (Anthropic, OpenAI, etc.) are dependencies of individual adapter packages only, not of core.

---

## Memory Layer

cfcf has a self-contained, file-based memory layer stored under `~/.cfcf/`. All iteration history, logs, judge assessments, decision logs, and cross-run knowledge are stored as structured Markdown and JSON files on the local filesystem. No external database or service is required.

The memory layer is designed to be human-readable, version-controllable, and easy to back up. The user can copy the entire `~/.cfcf/` directory to preserve all project history.

> **Note:** Cerefox (the OSS knowledge base) is supported as an optional external memory backend. When configured, cfcf syncs memory documents to Cerefox for semantic search across projects. This is not required -- the built-in file-based memory is fully functional on its own.

See `agent-process-and-context.md` for the full directory structure and file specifications.

---

## What is Explicitly Out of Scope for Core

- Any hard dependency on a specific LLM vendor.
- Any hard dependency on a specific AI dev agent.
- Any hard dependency on an external memory service (Cerefox is optional).
- Runtime requirements for end users (Node, Python, Bun, etc.).
- Cloud infrastructure (cfcf is a local-first tool; remote deployment is a stretch goal).
