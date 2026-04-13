# cfcf Decisions & Lessons Log

**Purpose:** This log captures important decisions and lessons learned that are NOT already documented in `plan.md`, `design/technical-design.md`, or other design docs, and that are not obvious from git history. It serves as a quick reference to avoid repeating failed experiments and to preserve rationale for non-obvious choices.

**What to add here:**
- Failed experiments and why they didn't work (so we don't repeat them)
- Non-obvious implementation decisions that future developers would question
- Surprising gotchas discovered during development
- Performance findings that influenced design choices

**What NOT to add here:**
- Architectural decisions (those go in `plan.md` decision log)
- Design rationale (those go in `design/technical-design.md` or `design/cfcf-requirements-vision.md`)
- Bug fixes (those are in git history)

**Format:** Newest entries at the top. Each entry has a date and a brief explanation.

---

## Log

### 2026-04-12 -- Loop state must be persisted to disk

In-memory loop state is lost on server restart. This includes `bun --watch` restarts (triggered by file changes during development), crashes, and manual restarts. Without persistence, `cfcf resume` fails after any restart with "No active loop for this project". Fix: persist `LoopState` to `~/.cfcf/projects/<id>/loop-state.json` on every phase transition, load from disk as fallback in `getLoopState()`.

### 2026-04-12 -- Codex CLI flag ordering matters: global flags before subcommand

Codex CLI requires global flags (like `-a never`) BEFORE the subcommand (`exec`). The command must be `codex -a never exec --full-auto "prompt"`, NOT `codex exec --full-auto -a never "prompt"`. The old `--approval-mode full-auto` flag was also removed in recent Codex versions. Discovered during first real judge run -- the judge silently failed with exit code 2.

### 2026-04-12 -- Branch creation must handle stale branches from failed runs

When an iteration fails and the user retries, the iteration branch may already exist from the failed attempt but point to a different base (e.g., off `main` instead of the current feature branch). Checking out the stale branch loses the working directory contents. Fix: delete existing branch and recreate off current HEAD. Also: validate problem-pack BEFORE switching branches.

### 2026-04-12 -- Judge failure should not silently lose dev work

When the judge agent fails (wrong CLI flags, crash, etc.), the loop correctly pauses with "anomaly", but the original implementation gave no clue about the cause. The user saw bare "anomaly" with no log path, no exit code, no hint. Fix: capture `judgeError` with exit code and log path, show in CLI pause output. Also: set `retryJudge` flag so resume retries only the judge on the same branch rather than starting a new full iteration.

### 2026-04-12 -- HTTP request/response model doesn't work for long agent runs

First real agent run (Claude Code) failed because: (1) Bun.serve has a max idleTimeout of 255 seconds, (2) the CLI's fetch() timed out after 10s default. Agent runs can take minutes or hours. The synchronous request/response model (CLI sends POST, server runs agent, returns result when done) fundamentally doesn't work for long-running operations.

**Fix implemented:** Refactored to async pattern. `POST /api/projects/:id/iterate` now returns 202 immediately. The server runs the agent in the background via `iteration-runner.ts`. The CLI polls `GET /api/projects/:id/iterations/:n/status` every 2 seconds, showing real-time progress dots. SSE log streaming available via `/iterations/:n/logs`. No timeout issues regardless of how long the agent runs.

### 2026-04-11 -- bun test --recursive hangs with process-spawning tests

`bun test --recursive` hangs when test files include process manager tests that spawn + kill subprocesses (e.g., `sleep 30` with `kill()`). Running packages sequentially (`bun test packages/core && bun test packages/server && bun test packages/cli`) works reliably. Updated root `package.json` test script accordingly. Likely a Bun v1.3.12 bug with --recursive and concurrent subprocess management in tests.

### 2026-04-11 -- Server stop must use PID file or port scan

The `cfcf server start` spawns a background bun process. Shell job control (`kill %1`) is unreliable across shell contexts. For `cfcf server stop` to work reliably, we need either: (a) store the PID in a file at startup and read it at stop, or (b) scan for the process on the configured port via `lsof -ti :<port>`. Approach (a) is more robust. Will implement in iteration 1.

### 2026-04-11 -- Bun v1.3.12 confirmed on macOS

Bun installed via `curl -fsSL https://bun.sh/install | bash`. Version 1.3.12. Will need to verify Windows and Linux compatibility when cross-platform testing begins.
