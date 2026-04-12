# cf² Workflow Guide

*cfcf and cf² are used interchangeably. Both are pronounced "cf square". `cfcf` is used in code and commands; cf² in documentation.*

This guide walks through the complete cf² workflow: from setting up a project to running iterative AI agent development cycles.

---

## Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     USER RESPONSIBILITIES                    │
│                                                              │
│  1. Create repo          3. Populate Problem Pack            │
│  2. Init cf² project     4. Trigger iterations               │
│                          5. Review & provide feedback        │
│                              at pause cadence                │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                     cf² AUTOMATION                            │
│                                                              │
│  • Assemble context (CLAUDE.md + cfcf-docs/)                 │
│  • Launch dev agent on feature branch                        │
│  • Capture logs, parse handoff + signals                     │
│  • Launch judge agent, parse assessment                      │
│  • Decide: continue / pause / stop                           │
│  • Alert user when input is needed                           │
└─────────────────────────────────────────────────────────────┘
```

---

## Step 1: One-Time Setup

Run once after installing cf²:

```bash
cfcf init
```

This detects installed AI agents (Claude Code, Codex), asks for configuration defaults (dev agent, judge agent, iteration limits), explains the permission flags, and saves the config.

---

## Step 2: Create or Prepare the Git Repo

cf² works with any git repository. You either:

**Create a new repo** (for a greenfield project):
```bash
mkdir my-project && cd my-project
git init
echo "# my-project" > README.md
git add -A && git commit -m "init"
```

**Use an existing repo** (to add features, refactor, fix bugs):
```bash
cd /path/to/existing/project
# Ensure there's at least one commit
```

---

## Step 3: Initialize the cf² Project

Register the repo with cf²:

```bash
cfcf project init --repo /path/to/my-project --name my-project
```

This creates:
- A project config in cf²'s config directory (`~/.config/cfcf/projects/`)
- A `problem-pack/` directory in your repo with template files

---

## Step 4: Populate the Problem Pack (User's Most Important Step)

**This is where the user defines what the AI agent should build.** cf² scaffolds templates, but the user MUST replace the template content with real problem definitions. Without this, the agent has no direction.

### Required files:

**`problem-pack/problem.md`** -- What needs to be built or fixed:
```markdown
# Problem Definition

## What Needs to Be Built
A REST API for user management with signup, login, and profile endpoints.

## Current State
Empty project. No existing code.

## Expected Behavior
- POST /signup creates a new user with email/password
- POST /login returns a JWT token
- GET /profile returns the authenticated user's profile
- All endpoints validate input and return proper error codes

## Scope
- In scope: API endpoints, input validation, JWT auth, tests
- Out of scope: Frontend, deployment, database migrations
```

**`problem-pack/success.md`** -- How success is measured:
```markdown
# Success Criteria

## Tests Must Pass
- Signup creates a user and returns 201
- Duplicate email returns 409
- Login with valid credentials returns a JWT
- Login with invalid credentials returns 401
- Profile endpoint requires authentication (401 without token)
- Profile returns user data with valid token
- All input validation works (missing fields, invalid email format)

## Code Quality
- TypeScript with proper type annotations
- Error handling with descriptive messages
- Tests cover all endpoints and edge cases
```

### Optional files (create as needed):

- **`problem-pack/constraints.md`** -- Guardrails: "must use Express.js", "no ORMs", "must be compatible with Node 20"
- **`problem-pack/hints.md`** -- Technical guidance: "use bcrypt for passwords", "prefer Zod for validation"
- **`problem-pack/style-guide.md`** -- Code conventions: "use 2-space indentation", "prefer async/await over callbacks"
- **`problem-pack/context/`** -- Reference files: API specs, architecture docs, data model descriptions

### Tips for effective problem definitions:

- **Be specific.** "Build an auth system" is vague. "Build JWT-based auth with signup, login, and profile endpoints" is actionable.
- **Define success concretely.** The agent needs to know when it's done. List specific test cases.
- **Set boundaries.** What's in scope and what isn't? What libraries should (or shouldn't) be used?
- **Provide context for existing repos.** If there's existing code, describe the architecture so the agent understands what it's working with.

---

## Step 5: Start the Server

```bash
# Start the cf² server (required for all operations)
bun run dev:server &
```

---

## Step 6: Launch the First Iteration

```bash
cfcf run --project my-project
```

What happens automatically:

1. **cf² reads** the Problem Pack from `problem-pack/`
2. **cf² writes** context files into the repo:
   - `CLAUDE.md` (or `AGENTS.md` for Codex) -- agent instruction file with tiered context
   - `cfcf-docs/` -- process definition, templates, iteration history
3. **cf² creates** a git feature branch: `cfcf/iteration-1`
4. **cf² launches** the configured dev agent (e.g., Claude Code with `--dangerously-skip-permissions`)
5. **The agent works**: reads context, formulates a plan, writes code, runs tests, fills in the handoff document and signal file
6. **cf² captures** all agent output to `~/.cfcf/logs/`
7. **cf² commits** all changes to the feature branch
8. **cf² reports** results: exit code, duration, whether handoff + signals were received

The CLI shows real-time progress:
```
Iteration 1 started on branch cfcf/iteration-1
Status: preparing
Status: executing...................
Status: collecting
Status: completed

--- Iteration 1 completed ---
Branch:    cfcf/iteration-1
Exit code: 0
Duration:  45s
Committed: true
Handoff:   received
Signals:   received

Agent signals:
  Status:      completed
  Assessment:  high
  Tests:       7/7 passed
```

---

## Step 7: Review the Results

After each iteration, inspect what the agent produced:

```bash
# See the code changes
cd /path/to/my-project
git log --oneline    # See the iteration commit
git diff HEAD~1      # See what changed

# Read the agent's handoff
cat cfcf-docs/iteration-handoff.md

# Check the structured signals
cat cfcf-docs/cfcf-iteration-signals.json

# Read the evolving plan
cat cfcf-docs/plan.md

# Check the full agent log
cat ~/.cfcf/logs/<project-id>/iteration-001-dev.log
```

---

## Step 8: Continue Iterating (Future -- Iteration 3+)

In the current version, each `cfcf run` triggers a single iteration. In iteration 3 of cf² development, the multi-iteration loop will be automated:

```bash
# Future: run up to 10 iterations, pause every 3 for review
cfcf run --project my-project --max-iterations 10 --pause-every 3
```

The automated loop will:
1. Run a dev agent iteration
2. Run the judge agent to assess the iteration
3. Based on the judge's determination:
   - **SUCCESS** → stop, push to remote, notify user
   - **PROGRESS** → continue to next iteration
   - **STALLED** → alert user
   - **ANOMALY** → pause and wait for user input
4. At every N iterations (configured pause cadence): pause and wait for user review

### User review at pause points:

When cf² pauses (either at the configured cadence or because the agent/judge requests input):

- **Review** the current state: iteration history, judge assessment, code changes
- **Provide feedback**: update `user-feedback.md`, refine `hints.md`, adjust the problem definition
- **Resume** or **stop** the iteration loop

---

## What the User Is Responsible For

| Task | When | Required? |
|------|------|-----------|
| Create/provide the git repo | Before project init | Yes |
| Run `cfcf project init` | Once per project | Yes |
| Write `problem.md` | Before first iteration | **Yes -- critical** |
| Write `success.md` | Before first iteration | **Yes -- critical** |
| Write `constraints.md` | Before first iteration | Optional |
| Write `hints.md` | Before first iteration or between iterations | Optional |
| Write `style-guide.md` | Before first iteration | Optional |
| Add `context/*.md` files | Before first iteration | Optional (recommended for existing repos) |
| Review results after iterations | At pause cadence or on completion | Recommended |
| Provide feedback at pause points | When cf² asks or at configured cadence | Optional but valuable |

---

## What cf² Handles Automatically

| Task | When |
|------|------|
| Scaffold `problem-pack/` templates | On `cfcf project init` |
| Assemble context (CLAUDE.md + cfcf-docs/) | Before each iteration |
| Create git feature branches | Before each iteration |
| Launch dev agent with proper flags | Each iteration |
| Capture and store agent logs | During each iteration |
| Parse handoff document + signal file | After each iteration |
| Launch judge agent (future) | After each iteration |
| Determine next action (continue/stop/alert) | After each iteration |
| Archive judge assessments | After each iteration |
| Alert user when input is needed | When detected |
| Compress iteration history | Before each iteration |

---

## Quick Reference

```bash
# One-time setup
cfcf init                                          # First-run config
cfcf project init --repo <path> --name <name>      # Register project

# Edit problem-pack/problem.md and success.md      # USER WRITES THESE

# Start server + run
bun run dev:server &                               # Start server
cfcf run --project <name>                          # Agent mode
cfcf run --project <name> -- <cmd>                 # Manual mode (testing)

# Inspect
cfcf project show <name>                           # Project config
cfcf status                                        # Overall status
cat cfcf-docs/iteration-handoff.md                 # Agent's report
cat cfcf-docs/cfcf-iteration-signals.json          # Structured signals

# Manage
cfcf config show                                   # Global config
cfcf project list                                  # All projects
cfcf project delete <name>                         # Remove project (not repo)
cfcf server stop                                   # Stop server
```
