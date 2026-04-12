# CLAUDE.md -- cfcf Project Context

This file provides context for AI coding agents (Claude Code, Codex, etc.) working on the cfcf codebase.

## What is cfcf?

cfcf (Cerefox Code Factory, also written cf², pronounced "cf square") is a deterministic orchestration harness that runs AI coding agents in iterative loops. It is NOT an AI agent itself -- it is the plumbing that manages agent lifecycles, context assembly, evaluation, and iteration control.

## Architecture Overview

- **Monorepo** with Bun workspaces: `packages/core`, `packages/server`, `packages/cli`
- **TypeScript** throughout, **Bun** as runtime and toolchain
- **Hono** HTTP server as the backbone (manages projects, iterations, agent processes)
- **Commander.js** CLI that communicates with the server via HTTP
- Agents run as **local processes** (not containers) in the user's dev environment
- **Git branches** provide isolation between iterations (feature branch per iteration, merge to main)

## Key Design Principles

1. **Deterministic control, non-deterministic workers.** The orchestration loop is predictable code. LLMs do creative work inside agent processes. cfcf does plumbing.
2. **Agent-agnostic.** Two adapters today (Claude Code, Codex). The `AgentAdapter` interface in `packages/core/src/types.ts` is the contract. No agent-specific code in core.
3. **All cfcf files live in the repo** under `cfcf-docs/`. Agent logs go to `~/.cfcf/logs/`. No external database.
4. **Signal files for machine-readable communication.** `cfcf-iteration-signals.json` and `cfcf-judge-signals.json` complement human-readable Markdown docs.
5. **Tests are mandatory.** Every component must have unit tests. Integration and API tests for server endpoints. Bun test runner. Aim for a solid regression suite.
6. **Fire-and-forget agent execution.** Each iteration spawns a fresh agent process. No session continuity. Context comes from files.
7. **Human on the loop, not in it.** Runs are headless by default. `--pause-every N` for review gates.

## Development Commands

```bash
bun install              # Install all workspace dependencies
bun test --recursive     # Run all tests
bun run typecheck        # TypeScript type checking
bun run dev:server       # Start server in dev mode (with watch)
bun run dev:cli          # Run CLI directly
```

## File Structure

```
packages/
  core/src/
    types.ts             # All type definitions (AgentAdapter, signals, config, etc.)
    constants.ts         # Ports, paths, defaults
    config.ts            # Config read/write/validation
    projects.ts          # Project CRUD, iteration counter
    process-manager.ts   # Spawn agents, stream logs, kill/timeout
    git-manager.ts       # Branch, commit, diff, reset, merge
    log-storage.ts       # Log file path helpers
    pid-file.ts          # Server PID file management
    problem-pack.ts      # Read/validate Problem Pack directories
    context-assembler.ts # Generate CLAUDE.md + cfcf-docs/, parse handoff/signals
    adapters/            # Agent adapter implementations (claude-code, codex)
    templates/           # cfcf-docs/ file templates (process.md, handoff, signals, etc.)
  server/src/
    app.ts               # Route definitions (testable without binding to port)
    start.ts             # Server lifecycle (start/stop, PID file)
  cli/src/
    client.ts            # HTTP client for server communication
    commands/            # CLI command implementations
      init.ts            # First-run interactive setup
      server.ts          # Server start/stop/status
      project.ts         # Project init/list/show/delete
      config.ts          # Global config show/edit
      run.ts             # Execute iterations (agent mode + manual mode)
      status.ts          # Quick status overview
problem-packs/           # Example Problem Pack definitions
docs/                    # Design docs, API reference, guides
```

## Development Workflow

- **Tests**: Only run tests when code changes are made. Doc-only changes do not need tests.
- **Git pushes**: Collect related commits locally and push in batches when a coherent set of changes is ready. Avoid pushing every single commit -- each push triggers GitHub Actions CI which consumes minutes. Doc-only changes can be batched and pushed together.
- **Commits**: Fine-grained commits are good (easier to review). Frequent pushes are not (wastes CI).

## Conventions

- Package imports use `@cfcf/core`, `@cfcf/server` workspace aliases
- Test files are colocated: `foo.ts` → `foo.test.ts`
- Config env overrides: `CFCF_PORT`, `CFCF_CONFIG_DIR`, `CFCF_LOGS_DIR`
- Adapter names are kebab-case: `claude-code`, `codex`
- All decisions logged in `docs/plan.md` decision log and `docs/decisions-log.md`

## What NOT to Do

- Do not add hard dependencies on any specific LLM vendor SDK in `packages/core`
- Do not add Docker/container dependencies (agents run as local processes)
- Do not store secrets or API keys in config files or logs
- Do not modify files marked read-only in `cfcf-docs/` (process.md, problem.md, success.md, constraints.md)
- Do not break the test suite. Run `bun test --recursive` before committing.

## Documentation

```
docs/
  README.md                        # Explains the docs structure
  plan.md                          # Development roadmap, decision log (living doc)
  decisions-log.md                 # Failed experiments, non-obvious choices
  design/                          # Specs and architecture
    cfcf-requirements-vision.md    # What and why (v0.4)
    cfcf-stack.md                  # Technology choices
    technical-design.md            # How components fit together
    agent-process-and-context.md   # Iteration process, file artifacts, signal formats
  api/                             # API reference
    server-api.md                  # Server REST API endpoints
  research/                        # Ideas and explorations (not yet in the plan)
  guides/                          # User guides (future)
```
