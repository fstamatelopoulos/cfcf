# cfcf -- Cerefox Code Factory (cf²)

*cfcf and cf² are used interchangeably throughout this project. Both are pronounced "cf square." `cfcf` is used in code, package names, and CLI commands; cf² is used in documentation and conversation.*

A deterministic orchestration harness that runs AI coding agents in iterative loops until your problem is solved.

**cfcf is not another AI agent.** It is the orchestration layer that manages agent lifecycles, assembles context, evaluates results via a separate judge agent, and decides whether to continue, adjust, or stop. The agents do the creative coding work; cfcf does the plumbing.

## Status

Early development. Iteration 5 largely complete; iteration 6 on deck.

- **Iteration 3 (v0.3.0, shipped)** — MVP: iteration loop with dev + judge agents, Solution Architect review, Documenter, pause/resume/stop, loop state persistence.
- **Iteration 4 (v0.4.0, shipped)** — React web GUI, unified agent-run state machine, workspace history tracking, graceful shutdown, notifications, architect-review UI, live elapsed-timer, one-phase-per-iteration discipline.
- **Iteration 5 (v0.5.0 – v0.8.0, mostly shipped)** — single-binary self-hosting (no Bun runtime needed), embedded templates + web bundle with local override layer, `cleanupMergedBranches` flag. **Tier 3 Strategic Reflection role** (item 5.6) with non-destructive plan editing, three-commit-per-iteration discipline, multi-role decision log, per-iteration changelog artifact, `cfcf reflect` CLI, architect re-review mode, sentinel-based `CLAUDE.md` / `AGENTS.md` preservation, richer web History + cross-workspace activity indicator. **`autoReviewSpecs` / `autoDocumenter` / `readinessGate` config keys** (item 5.1) wiring the Solution Architect as an optional pre-loop phase with a user-in-the-loop readiness gate. **Editable global-settings page** (5.9) + top-bar `Workspaces` / `Settings` nav + **editable per-workspace Config tab** (6.14, pulled forward from iter-6). Generated-copy banners protect user-owned source files from accidental edits; `iteration-handoffs/` joins `iteration-reviews/` + `reflection-reviews/` as a per-iteration audit directory so brownfield runs see their own history. **Workspace rename** (item 5.10, v0.8.0): cf²'s `project` noun renamed to `workspace` across CLI + API + types + web UI, so Cerefox's `Project` semantics stay free for the upcoming Clio memory layer. Still open in iter 5: `5.5` installer, `5.7` Clio, `5.8` user manual. Design: [`docs/research/reflection-role-and-iterative-planning.md`](docs/research/reflection-role-and-iterative-planning.md).

cfcf can be driven from the CLI or from the web GUI served by the same Hono server. See `docs/plan.md` for the full roadmap and current status table.

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

# Create a workspace linked to a git repo
bun run dev:cli -- workspace init --repo /path/to/your/project --name my-app

# Edit the problem definition
# (cfcf scaffolds problem-pack/problem.md and problem-pack/success.md for you)

# Launch the AI agent against your problem
bun run dev:cli -- run --workspace my-app

# Or run a manual command (for testing)
bun run dev:cli -- run --workspace my-app -- npm test
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
      workflow.md                 # Full user workflow (main user guide)
      cli-usage.md                # CLI command reference
    research/                     # Designs in flight or historical
      reflection-role-and-iterative-planning.md
  CLAUDE.md             # AI agent context (for Claude Code, Codex, etc.)
  CHANGELOG.md          # Release notes (follows Keep a Changelog)
```

### Five Agent Roles

cfcf uses five independently configurable agent roles -- each role can use
a different adapter and model:

| Role | Purpose |
|------|---------|
| Solution Architect | Reviews Problem Pack, produces / extends `plan.md` |
| Dev agent | Writes code, runs tests, authors per-iteration changelog |
| Judge agent | Per-iteration assessment + `reflection_needed` opt-out signal |
| Reflection agent | Cross-iteration strategic review, non-destructive plan edits |
| Documenter | Polished final docs after SUCCESS |

## Architecture at a Glance

```
User (CLI / Web GUI)
    |
    v
cfcf Server (Hono on Bun, serves API + static web GUI)
    |
    +-- Workspace Manager         (config, state)
    +-- Iteration Controller      (loop: prepare -> dev -> judge -> reflect? -> decide -> documenting)
    +-- Runners                   (architect [first-run or re-review], judge, reflection, documenter)
    +-- Process Manager           (spawn agents, capture logs)
    +-- Active Processes Registry (track + kill on shutdown)
    +-- Context Assembler         (merge sentinel block into CLAUDE.md/AGENTS.md, build cfcf-docs/)
    +-- Plan Validator            (non-destructive rewrite check for architect + reflection)
    +-- Workspace History         (persistent audit trail: review / iteration / reflection / document)
    +-- Notifications Dispatcher  (terminal bell / macOS / Linux / log)
    +-- Memory Layer              (file-based, in repo + ~/.cfcf/ for logs)
    |
    v
Agent Processes (Claude Code, Codex, etc.)
    running in user's local dev environment
```

## How It Works

1. You define your problem in Markdown files (problem.md, success.md, optional constraints / hints / context).
2. (Recommended) The **Solution Architect** reviews the Problem Pack and produces an implementation plan with **phases mapped to concrete iterations** (`## Iteration 1 -- Foundation`, etc.). On re-review (a workspace with prior iterations) the architect appends new iterations non-destructively when new requirements appear.
3. cfcf creates a feature branch and assembles context for the AI agent. The cfcf-owned block is written between sentinel markers in `CLAUDE.md` (Claude Code) or `AGENTS.md` (Codex); any user-authored content outside the markers is preserved across iterations.
4. The **dev agent** reads context and executes **one phase per iteration**: picks up the next pending chunk from `cfcf-docs/plan.md`, does just that, marks it `[x]` with a brief note, writes a per-iteration changelog under `cfcf-docs/iteration-logs/`, and exits.
5. The **judge agent** reviews the iteration and produces structured feedback (determination, quality score, tests, concerns, reflection opt-out).
6. The **reflection agent** reads the full cross-iteration history and may non-destructively rewrite pending plan items (completed work is protected; destructive rewrites are auto-reverted). Reflection runs after every iteration unless the judge explicitly opts out; even then cfcf forces reflection after `reflectSafeguardAfter` consecutive opt-outs (default 3). Reflection can set `recommend_stop` to pause the loop for the user.
7. Each iteration produces up to three separate commits (dev / judge / reflect). cfcf merges the feature branch to main (auto-merge mode) and starts the next iteration -- a brand new agent process that reads the updated plan and picks up from there.
8. Repeat until success criteria are met, reflection recommends stopping, or iteration limits are reached. On success, the **documenter** produces polished `docs/` before the loop ends.

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
