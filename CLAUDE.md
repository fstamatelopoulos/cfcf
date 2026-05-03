# CLAUDE.md -- cfcf Project Context

This file provides context for AI coding agents (Claude Code, Codex, etc.) working on the cfcf codebase.

## What is cfcf?

cfcf (Cerefox Code Factory, also written cf², pronounced "cf square") is a deterministic orchestration harness that runs AI coding agents in iterative loops. It is NOT an AI agent itself -- it is the plumbing that manages agent lifecycles, context assembly, evaluation, and iteration control.

## Architecture Overview

- **Monorepo** with Bun workspaces: `packages/core`, `packages/server`, `packages/cli`, `packages/web`
- **TypeScript** throughout, **Bun** as runtime and toolchain
- **Hono** HTTP server as the backbone (manages workspaces, iterations, agent processes); React+Vite web GUI served from the same process (embedded into the compiled binary at build time)
- **Commander.js** CLI that communicates with the server via HTTP
- Agents run as **local processes** (not containers) in the user's dev environment
- **Git branches** provide isolation between iterations (feature branch per iteration, merge to main)
- **Seven agent roles**: five run inside the iteration loop — dev (writes code), judge (per-iteration assessment), architect (reviews / extends Problem Pack; verdicts: READY / NEEDS_REFINEMENT / BLOCKED / SCOPE_COMPLETE), reflection (cross-iteration strategic review), documenter (produces final docs); two are interactive — Product Architect (live spec iteration before the loop, item 5.14) and Help Assistant (in-shell guidance). Each role independently configurable (adapter + model).
- **Per-adapter model registry** (item 6.26): pickers in web Settings, web workspace Config, and `cfcf init` / `cfcf config edit` source their model dropdown from `packages/core/src/adapters/seed-models.ts` (the bundled seed) merged with the user's optional override on `CfcfGlobalConfig.agentModels[<adapter>]` (managed via the web Settings → Model registry editor). Resolution lives in `resolveModelsForAdapter()`. The seed is intentionally minimal — generic aliases (`opus`, `sonnet`, `haiku` for claude-code; `gpt-5-codex`, `gpt-5`, `o3` for codex) so it ages slowly. Every picker also offers a `(custom model name…)` sentinel so users can pin an unreleased / experimental model without waiting for a seed update or editing Settings. **Maintenance**: when an upstream agent CLI ships a new headline model, edit the relevant array in `seed-models.ts` and ship in the next release; user overrides survive the upgrade.
- **Structured pause actions** (item 6.25, shipped 2026-05-02): when a paused loop is resumed via `cfcf resume --action <…>`, the user picks one of `continue` / `finish_loop` / `stop_loop_now` / `refine_plan` / `consult_reflection`. `loop-stopped` is a workspace-history event type for user-initiated `stop_loop_now`.
- **Three commits per iteration** when reflection runs: `cfcf iteration N dev (...)`, `cfcf iteration N judge (...)`, `cfcf iteration N reflect (<health>): <key_observation>`.
- **Async execution**: iterate endpoint returns 202, CLI polls for status.
- **Clio cross-workspace memory** (items 5.7 + 5.11 + 5.12 + 5.13): persistent SQLite knowledge layer at `~/.cfcf/clio.db`. Shared across all workspaces, scoped by named **Clio Project**. FTS5 keyword search out of the box; install an embedder via `cfcf clio embedder install` to enable hybrid (α-weighted blend of cosine + normalised BM25, default α=0.7) + semantic search. **Cerefox-parity surface**: doc-level search by default (`--by-chunk` for raw chunk view), per-document small-to-big retrieval (small docs return full content, large docs return chunk + context window), update-by-document-id + update-by-title (with version snapshots in `clio_document_versions`), metadata-only edit (`cfcf clio docs edit` / `PATCH /api/clio/documents/:id`: title/author/project/metadata change with NO version snapshot — versions protect chunks, not metadata; one `edit-metadata` audit entry per non-empty edit), soft-delete + restore, audit log (write-only, with `edit-metadata` before/after diffs), metadata-search + metadata-keys discovery, `--alpha` / `--small-doc-threshold` / `--context-window` per-call knobs and matching `clio.*` global config. Iteration-loop auto-ingests reflection analyses, architect reviews, decision-log entries, iteration summaries (gated by `workspace.clio.ingestPolicy`). All agent roles read Clio via `cfcf-docs/clio-relevant.md` (top-k hits matched against `problem.md`) + the `cfcf-docs/clio-guide.md` cue card. Backend code lives behind a `MemoryBackend` interface so a future remote-Cerefox adapter can swap in cleanly.

## Key Design Principles

1. **Deterministic control, non-deterministic workers.** The orchestration loop is predictable code. LLMs do creative work inside agent processes. cfcf does plumbing.
2. **Agent-agnostic.** Two adapters today (Claude Code, Codex). The `AgentAdapter` interface in `packages/core/src/types.ts` is the contract. No agent-specific code in core.
3. **All cfcf files live in the repo** under `cfcf-docs/`. Raw agent stdout/stderr logs go to `~/.cfcf/logs/<workspace>/` (too large, potentially contain PII/secrets). Agent-authored per-iteration changelogs live in the repo at `cfcf-docs/iteration-logs/iteration-N.md` -- these are small, human-curated, safe to commit. `iteration-history.md` is rebuilt from those logs each iteration so it survives server restarts. Four per-iteration archive directories under `cfcf-docs/` preserve the full audit trail: `iteration-logs/` (backward-looking dev changelogs), `iteration-handoffs/` (forward-looking dev notes, v0.7.6), `iteration-reviews/` (judge verdicts), `reflection-reviews/` (reflection analyses). No external database.
4. **Signal files for machine-readable communication.** `cfcf-iteration-signals.json`, `cfcf-judge-signals.json`, `cfcf-architect-signals.json`, `cfcf-reflection-signals.json` complement human-readable Markdown docs.
5. **Non-destructive plan rewrites.** Both the architect (re-review mode) and the reflection agent may rewrite `cfcf-docs/plan.md`, but cfcf validates each rewrite: completed items (`[x]`) and iteration-header numbers must survive. Destructive rewrites are auto-reverted to the pre-spawn snapshot. Logic lives in `packages/core/src/plan-validation.ts`.
6. **Sentinel-based user-content preservation.** cfcf regenerates iteration-specific instructions for the dev agent every iteration, but only inside the `<!-- cfcf:begin --> ... <!-- cfcf:end -->` block in `CLAUDE.md` / `AGENTS.md`. User content outside the markers is preserved byte-for-byte across iterations.
7. **Tests are mandatory.** Every component must have unit tests. Integration and API tests for server endpoints. Bun test runner. Aim for a solid regression suite.
8. **Fire-and-forget agent execution.** Each iteration spawns a fresh agent process. No session continuity. Context comes from files. Because each iteration is a clean session, the dev agent is prompted (via the generated `CLAUDE.md` / `AGENTS.md`) to execute **one phase per iteration**: read `cfcf-docs/plan.md`, pick the next pending chunk, do just that, mark `[x]` with a short note, write `iteration-logs/iteration-N.md`, and exit. The next iteration's brand-new process picks up from the updated plan. This discipline is injected by `context-assembler.generateInstructionContent()` on every run.
9. **Human on the loop, not in it.** User launches once, cfcf takes over. User involved only at pause cadence, when agents request input, or when reflection flags `recommend_stop`.

## Development Commands

```bash
bun install              # Install all workspace dependencies
bun run test             # Run all tests (packages sequentially)
bun run typecheck        # TypeScript type checking
bun run build            # Build npm-format CLI tarball (dist/cfcf-X.Y.Z.tgz)
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
    workspaces.ts        # Workspace CRUD, iteration counter
    process-manager.ts   # Spawn agents, stream logs, kill/timeout
    git-manager.ts       # Branch, commit, diff, reset, merge
    log-storage.ts       # Log file path helpers
    pid-file.ts          # Server PID file management
    problem-pack.ts      # Read/validate Problem Pack directories
    context-assembler.ts # Generate cfcf-docs/, rebuild iteration-history.md,
                         #   sentinel-merge CLAUDE.md/AGENTS.md, parse handoff/signals
    plan-validation.ts   # Shared non-destructive plan.md rewrite validator
                         #   (used by architect re-review + reflection)
    judge-runner.ts      # Judge agent: spawn, parse signals/assessment, archive
    architect-runner.ts  # Solution Architect: spawn (first-run or re-review),
                         #   snapshot+revert plan.md on destructive rewrite
    documenter-runner.ts # Documenter: spawn post-SUCCESS, produce final docs
    reflection-runner.ts # Reflection: cross-iteration strategic review, sync
                         #   entry for loop + async entry for `cfcf reflect`
    iteration-loop.ts    # Main iteration loop controller + decision engine
                         #   (preparing -> dev -> judging -> reflecting? -> deciding)
    workspace-history.ts # history.json: review / iteration / reflection / document events
    adapters/            # Agent adapter implementations (claude-code, codex)
    templates/           # cfcf-docs/ file templates (17 entries incl. reflection + iteration-log + clio-guide)
    clio/                # Clio memory layer (item 5.7)
      backend/
        types.ts           # MemoryBackend interface (swap point for future CerefoxRemote)
        local-clio.ts      # LocalClio: SQLite + FTS5 + alpha-weighted hybrid + per-doc small-to-big +
                           #   update-by-id + version snapshots + soft-delete + edit-metadata +
                           #   audit + metadata-search
      embedders/
        types.ts           # Embedder interface (warmup, embed, close)
        catalogue.ts       # Built-in embedder catalogue (nomic default + bge / MiniLM); each entry
                           #   declares `recommendedChunkMaxChars` used as a safety ceiling at ingest
        onnx-embedder.ts   # @huggingface/transformers wrapper, lazy HF download, dtype select
        store.ts           # clio_active_embedder row read/write
      chunker.ts         # Cerefox markdown chunker (1:1 port)
      db.ts              # bun:sqlite open + migrations runner with @migration-flags marker support
      migrations/        # 0001_initial.sql (consolidated 2026-04-27 from 0001-0004 pre-public)
      ingest.ts          # iteration-loop auto-ingest hooks (reflection, architect, …)
      types.ts           # Clio domain types (Document, Chunk, Project, SearchRequest,
                         #   DocumentSearchHit, ClioDocumentVersion, ClioAuditEntry, …)
  server/src/
    app.ts               # Route definitions (testable without binding to port)
    start.ts             # Server lifecycle (start/stop, PID file)
    iteration-runner.ts  # Single iteration execution (manual mode, backwards compat)
    clio-backend.ts      # MemoryBackend singleton + self-heal on deleted clio.db
    routes/clio.ts       # /api/clio/* — search (?by=doc default, alpha + small_doc_threshold +
                         #   context_window per-call), ingest (documentId / updateIfExists / author),
                         #   /documents/:id/{content,versions,restore}, DELETE for soft-delete,
                         #   PATCH for metadata-only edit (5.13 follow-up),
                         #   metadata/search + metadata/keys, audit-log, embedders/{install,set,
                         #   :name/switch-impact}, reindex
  cli/src/
    client.ts            # HTTP client for server communication
    commands/            # CLI command implementations
      init.ts            # First-run interactive setup (numbered agent picker, embedder
                         #   pick + inline HF download with progress bar, error classifier)
      server.ts          # Server start/stop/status
      workspace.ts       # Workspace init/list/show/delete (--project for Clio assignment)
      config.ts          # Global config show/edit
      run.ts             # Start iteration loop (agent) or single iteration (manual)
      review.ts          # Solution Architect review (cfcf review)
      resume.ts          # Resume a paused loop (cfcf resume)
      stop.ts            # Stop a running loop (cfcf stop)
      document.ts        # Generate final docs (cfcf document)
      reflect.ts         # Ad-hoc reflection pass (cfcf reflect, 5.6)
      status.ts          # Status overview with loop state
      spec.ts            # Product Architect interactive spec iteration (cfcf spec, 5.14)
      doctor.ts          # Environment / install diagnostics (cfcf doctor)
      self-update.ts     # In-place upgrade to latest npm release (cfcf self-update)
      help.ts            # In-shell user-manual + focused guides (cfcf help [topic])
      completion.ts      # Shell completion scripts (cfcf completion)
      clio.ts            # cfcf clio {search,ingest,get,docs {list,edit},projects,project,
                         #   versions,audit,delete,restore,metadata-search,metadata-keys,
                         #   embedder {list,active,install,set},reindex,stats}
                         #   + cfcf memory alias
  web/src/
    App.tsx              # Root router (dashboard / workspace / server)
    pages/               # Dashboard, WorkspaceDetail, ServerInfo
    components/          # Header, PhaseIndicator, WorkspaceHistory,
                         #   ArchitectReview, JudgeDetail, ReflectionDetail, …
    api.ts               # Client for all /api/* endpoints incl. /activity + /reflect
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
- Feature branches for cfcf development: `iteration-N/<description>` (e.g., `iteration-5/reflection-pr1`)
- Seven agent roles: 5 iteration (dev, judge, architect, reflection, documenter) + 2 interactive (Product Architect, Help Assistant) -- each independently configurable (agent + model)
- Reflection defaults to the architect agent's adapter when unset; `reflectSafeguardAfter` defaults to `3` consecutive judge opt-outs

## What NOT to Do

- Do not add hard dependencies on any specific LLM vendor SDK in `packages/core`
- Do not add Docker/container dependencies (agents run as local processes)
- Do not store secrets or API keys in config files or logs
- Do not modify files marked read-only in `cfcf-docs/` (process.md, problem.md, success.md, constraints.md)
- Do not bypass the `plan-validation` rules -- completed items and iteration headers in `plan.md` must survive any rewrite by architect/reflection
- Do not bypass the `<!-- cfcf:begin --> ... <!-- cfcf:end -->` sentinel merge -- user content outside those markers in `CLAUDE.md` / `AGENTS.md` is inviolate
- Do not break the test suite. Run `bun run test` before committing code changes.

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
  guides/                          # User guides
    manual.md                      # 3-minute getting started + concepts (entry point; mirrored by `cfcf help`)
    workflow.md                    # Complete user workflow
    cli-usage.md                   # CLI command reference
    installing.md                  # Install / upgrade / uninstall / offline
    clio-quickstart.md             # Clio cross-workspace memory quickstart
    product-architect.md           # Product Architect interactive role
    troubleshooting.md             # Troubleshooting guide
```
