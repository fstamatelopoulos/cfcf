# cfcf: Cerefox Code Factory -- Technology Stack

## Overview

cfcf (Cerefox Code Factory, also written cf² and pronounced "cf square") is a deterministic coding orchestration harness. It spawns AI dev agents as local processes and coordinates them through structured, uninterrupted iteration cycles. Iterations run headless by design. The human user is on the loop, not in it -- optionally reviewing and providing direction between iterations at a cadence they configure, rather than being interrupted mid-run. LLMs and AI agents are pluggable components; cfcf is vendor, agent, and model agnostic at its core.

---

## Design Principles

- **Vendor agnostic**: No LLM vendor or AI dev agent is a first-class citizen. Claude Code, Codex, OpenCode, Cline, Goose, OpenHands, Cursor Agent, and others are all pluggable via a common abstraction layer.
- **Deterministic orchestration**: LLMs and agents serve as utility evaluators and executors, not decision-makers. Control flow is deterministic and defined by cfcf.
- **Minimal prerequisites for end users**: Distributed as a standard npm-format CLI package (`@cerefox/codefactory`). The only runtime requirement is Bun ≥ 1.3, which the curl-bash installer bootstraps automatically when missing. No Node or other runtime install required.
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

Bun is the runtime and toolchain. It is fully compatible with Node.js APIs and npm packages, and provides:

- **Bun-specific APIs cfcf depends on**: `bun:sqlite` (the Clio memory layer), `Bun.spawn` (agent process management), `Bun.serve` (Hono server), `Bun.file`, asset embedding via `with { type: "text" }`. These are why Bun is a hard runtime requirement at install time, not just a build-time tool.
- **JS bundling for distribution**: `bun build` (without `--compile`) produces a single bundled JS file shipped as the `@cerefox/codefactory` npm package. Standard Node-ecosystem distribution; users install with `bun install -g`. The `--compile` self-contained-binary path was attempted in v0.5.0–v0.9.0 and abandoned in v0.10.0 — see [`docs/decisions-log.md`](../decisions-log.md) 2026-04-26.
- **Performance**: Faster startup and execution than Node for CLI-heavy workloads; Bun-native APIs avoid Node-shim overhead.
- **Unified toolchain**: Package manager, test runner, bundler, and runtime in one tool. Reduces CI complexity.

---

## Distribution and Installation

### Approach: npm-format CLI package

cfcf is distributed as the `@cerefox/codefactory` npm package on npmjs.com. End users install with one command:

```bash
curl -fsSL https://github.com/fstamatelopoulos/cfcf/releases/latest/download/install.sh | bash
# or, manually (if you already have Bun + npm):
npm install -g --prefix ~/.bun @cerefox/codefactory
```

The curl-bash installer:

1. Detects whether Bun is on PATH; runs `curl -fsSL https://bun.sh/install | bash` if not.
2. Detects whether `npm` is available; runs `bun install -g npm` if not.
3. Runs `npm install -g --prefix ~/.bun @cerefox/codefactory`. npm's optional-deps resolver (gated by the package's `os`/`cpu` fields) installs the matching `@cerefox/codefactory-native-<platform>` package (pinned libsqlite3 + sqlite-vec) and the runtime deps (`@huggingface/transformers`, `onnxruntime-node`, `sharp`).
4. Prints a banner pointing the user at `cfcf init` to start interactive first-run setup.

Why the `--prefix ~/.bun`? cfcf requires Bun at runtime (it uses `bun:sqlite`, `Bun.spawn`, etc. directly), so every cfcf user already has `~/.bun/bin` on their PATH (added by Bun's installer). Pointing npm at `~/.bun` lands cfcf at `~/.bun/bin/cfcf` — immediately reachable, with no second PATH entry, no shell-rc edit by cfcf, and no `EACCES` from npm's default root-owned `/usr/local` prefix on stock-installer Node. Full rationale + the four-design journey in [`docs/decisions-log.md`](../decisions-log.md) (2026-05-01 entry). Why npm and not `bun install -g`? Bun blocks transitive postinstall scripts by default ([oven-sh/bun#4959](https://github.com/oven-sh/bun/issues/4959)), which would break `onnxruntime-node` + `protobufjs`; npm runs them by default with no trust prompt.

This is the same distribution model `vercel`, `yarn`, `openclaw`, and most JS-ecosystem CLIs use. The earlier `bun --compile` self-contained-binary approach was abandoned because Bun's compile-mode resolver doesn't support the heavy native deps cfcf relies on (full post-mortem in [`docs/decisions-log.md`](../decisions-log.md) 2026-04-26).

### Release Pipeline

`.github/workflows/release.yml` (`workflow_dispatch` only) runs three jobs on tag input: per-platform `build-native` (compiles libsqlite3, fetches sqlite-vec, packs `@cerefox/codefactory-native-<platform>` tarballs), `build-cli` (single Linux runner, runs `bun build` and packs the `@cerefox/codefactory` tarball), and `release` (assembles SHA256SUMS + MANIFEST.txt + install.sh, uploads everything as GitHub Release assets). See [`docs/research/installer-design.md`](../research/installer-design.md) for the full design.

---

## Component Architecture

### CLI Layer

- **Framework**: Commander.js for command and subcommand routing.
- **Terminal UI**: Ink (React-based terminal rendering). Used for interactive iteration display, agent status, open question prompts, and progress indicators.
- **Entry point**: The `cfcf` command (installed by `npm install -g --prefix ~/.bun @cerefox/codefactory` to `~/.bun/bin/cfcf`) routes to subcommands (`cfcf iterate`, `cfcf init`, `cfcf status`, `cfcf logs`, etc.).

### Server Layer

- **Framework**: Hono -- lightweight, fast, runs on Bun natively.
- **Role**: Manages workspace and iteration lifecycles, exposes a local API consumed by both the CLI and the web GUI, manages agent process lifecycles, and streams logs and events.
- **Transport**: HTTP/SSE for streaming event output to the web GUI. WebSocket as an option for bidirectional agent communication.

### Web GUI (Iteration 4 — Available)

A React + Vite web GUI at `packages/web`. The Vite build output (`packages/web/dist/`) is **embedded into the bundled CLI JS at build time** via `scripts/embed-web-dist.ts` — the Hono server serves the embedded bytes directly, so the npm package carries both the API and the web UI with no separate asset deployment. In dev mode (`bun run dev:server`), the server falls back to reading `packages/web/dist/` from disk. The CLI remains the primary headless interface; the web GUI is for monitoring and control. Both drive the same server.

Implemented (iteration 4):
- Dashboard with workspace list + status badges
- Workspace detail page with tabs: Status, History, Logs, Config
- Unified PhaseIndicator for loop / review / document runs
- LoopControls with Start / Stop / Resume / Review / Document
- Real-time log streaming via SSE (persists across tab switches)
- Unified workspace history timeline (reviews + iterations + documents)

Still planned for later iterations:
- Diff viewer per iteration
- Agent telemetry and token usage dashboards
- Configuration editing in the web UI (currently read-only)
- Remote access (tunneled or network-exposed)

The GUI is a plain React + Vite app with no UI framework. Dark theme, minimal CSS, no routing library (hash-based routing).

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
4. Spawns the dev agent as a local process in the workspace directory.
5. Streams and captures all stdout/stderr.
6. Waits for the agent process to exit.
7. Reads the agent's output artifacts (handoff document, signal file).
8. Commits all changes to the cfcf branch.
9. Spawns the judge agent in the same directory.
10. Commits judge output. Proceeds to the next iteration or stops.

### Why Not Containers?

Containers were considered and deferred. The key reasons for local processes:

- **Minimal prerequisites**: No Docker install required. Bun + cfcf + installed agents is all you need.
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
- **Notifications**: The server alerts the user via configurable channels when loops pause, complete, or an agent fails. v1 channels (iteration 4): terminal bell, macOS Notification Center (osascript), Linux notify-send, JSON Lines log file. Webhook channel (Slack, email, custom URLs) deferred to iteration 5.
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
cfcf/
  packages/
    cli/          # Commander, bundled via bun build → @cerefox/codefactory npm package
    server/       # Hono server, session and process management
    core/         # Shared types, agent abstraction layer, orchestration logic
    web/          # React GUI (embedded into the CLI bundle at build time)
  scripts/
    build-cli.sh             # Bundle + pack @cerefox/codefactory tarball
    build-native-package.sh  # Pack @cerefox/codefactory-native-<platform> tarballs
    install.sh               # Curl-bash install wrapper (bootstraps Bun)
  .github/
    workflows/
      release.yml # CI: workflow_dispatch → build-native + build-cli + release
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
| Monorepo | Bun workspaces |
| Build/release | Bun + GitHub Actions |

Vendor AI SDKs (Anthropic, OpenAI, etc.) are dependencies of individual adapter packages only, not of core.

---

## Memory Layer

cfcf has a self-contained, file-based memory layer stored under `~/.cfcf/`. All iteration history, logs, judge assessments, decision logs, and cross-run knowledge are stored as structured Markdown and JSON files on the local filesystem. No external database or service is required.

The memory layer is designed to be human-readable, version-controllable, and easy to back up. The user can copy the entire `~/.cfcf/` directory to preserve all workspace history.

> **Note:** Cerefox (the OSS knowledge base) is supported as an optional external memory backend. When configured, cfcf syncs memory documents to Cerefox for semantic search across workspaces. This is not required -- the built-in file-based memory is fully functional on its own.

See `agent-process-and-context.md` for the full directory structure and file specifications.

---

## What is Explicitly Out of Scope for Core

- Any hard dependency on a specific LLM vendor.
- Any hard dependency on a specific AI dev agent.
- Any hard dependency on an external memory service (Cerefox is optional).
- Runtime requirements beyond Bun (no Node, Python, JVM, etc. on the user's machine).
- Cloud infrastructure (cfcf is a local-first tool; remote deployment is a stretch goal).
