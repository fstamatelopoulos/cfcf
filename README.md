# cfcf -- Cerefox Code Factory (cf²)

*cfcf and cf² are used interchangeably throughout this project. Both are pronounced "cf square." `cfcf` is used in code, package names, and CLI commands; cf² is used in documentation and conversation.*

A deterministic orchestration harness that runs AI coding agents in iterative loops until your problem is solved.

**cfcf is not another AI agent.** It is the orchestration layer that manages agent lifecycles, assembles context, evaluates results via a separate judge agent, and decides whether to continue, adjust, or stop. The agents do the creative coding work; cfcf does the plumbing.

## Status

Early development. Iteration 2 complete -- cfcf can launch AI agents against problem definitions, assemble context, and capture results. See `docs/plan.md` for the full roadmap.

## Prerequisites

- **[Node.js](https://nodejs.org/)** v20+ (required for AI agent CLIs)
- **[Bun](https://bun.sh/)** v1.3+ (runtime and toolchain)
- **[Git](https://git-scm.com/)** (required for iteration branch management)
- At least one supported AI coding agent:
  - **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** (Anthropic)
  - **[Codex CLI](https://github.com/openai/codex)** (OpenAI)

### Install Node.js

```bash
# macOS (Homebrew)
brew install node

# macOS / Linux (nvm -- recommended for managing versions)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install 20

# Windows
# Download installer from https://nodejs.org/
```

### Install Bun

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Windows
powershell -c "irm bun.sh/install.ps1 | iex"
```

### Install an AI Agent

```bash
# Claude Code (requires Anthropic account)
npm install -g @anthropic-ai/claude-code

# Codex CLI (requires OpenAI account)
npm install -g @openai/codex
```

## Getting Started

```bash
# Clone the repo
git clone https://github.com/user/cfcf.git
cd cfcf

# Install dependencies
bun install

# Run first-time setup (detects agents, configures defaults)
bun run dev:cli -- init

# Start the server
bun run dev:cli -- server start

# Create a project linked to a git repo
bun run dev:cli -- project init --repo /path/to/your/project --name my-app

# Edit the problem definition
# (cfcf scaffolds problem-pack/problem.md and problem-pack/success.md for you)

# Launch the AI agent against your problem
bun run dev:cli -- run --project my-app

# Or run a manual command (for testing)
bun run dev:cli -- run --project my-app -- npm test
```

## Development

```bash
# Run all tests
bun run test

# TypeScript type checking
bun run typecheck

# Build a self-contained binary
bun run build

# Start server in watch mode (auto-restart on changes)
bun run dev:server

# Run CLI commands during development
bun run dev:cli -- <command>
```

## Project Structure

```
cfcf/
  packages/
    core/               # Shared types, config, adapters, context assembly
    server/             # Hono HTTP server (backbone)
    cli/                # Commander.js CLI (user interface)
  problem-packs/        # Example problem definitions
    example/            # Calculator module example
  docs/
    plan.md                       # Development roadmap and decision log
    decisions-log.md              # Lessons learned
    design/                       # Specs and architecture
      cfcf-requirements-vision.md
      cfcf-stack.md
      technical-design.md
      agent-process-and-context.md
    api/                          # API reference
      server-api.md
    guides/                       # User guides
      cli-usage.md
  CLAUDE.md             # AI agent context (for Claude Code, Codex, etc.)
  CHANGELOG.md          # Release notes (follows Keep a Changelog)
```

## Architecture at a Glance

```
User (CLI / Web GUI)
    |
    v
cfcf Server (Hono on Bun)
    |
    +-- Project Manager      (config, state)
    +-- Iteration Controller  (the loop: prepare -> dev -> judge -> decide)
    +-- Process Manager       (spawn agents, capture logs)
    +-- Context Assembler     (build CLAUDE.md + cfcf-docs/)
    +-- Memory Layer          (file-based, in repo + ~/.cfcf/ for logs)
    |
    v
Agent Processes (Claude Code, Codex, etc.)
    running in user's local dev environment
```

## How It Works (When Complete)

1. You define your problem in Markdown files (problem.md, success.md, test scenarios)
2. cfcf creates a feature branch and assembles context for the AI agent
3. The agent reads context, codes, tests, and produces a handoff document
4. A separate judge agent reviews the work and provides structured feedback
5. cfcf merges to main (or creates a PR) and starts the next iteration with accumulated knowledge
6. Repeat until success criteria are met or iteration limits are reached

## Configuration

cfcf stores its config in the platform-standard directory:
- **Linux:** `~/.config/cfcf/config.json`
- **macOS:** `~/Library/Application Support/cfcf/config.json`
- **Windows:** `%APPDATA%/cfcf/config.json`

Override with `CFCF_CONFIG_DIR` environment variable.

## License

TBD

---

*cfcf is part of the [Cerefox](https://github.com/user/cerefox) ecosystem.*
