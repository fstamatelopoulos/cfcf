# cf² Workflow Guide

*cfcf and cf² are used interchangeably. Both are pronounced "cf square". `cfcf` is used in code and commands; cf² in documentation.*

This guide walks through the complete cf² workflow: from setting up a project to running iterative AI agent development cycles.

---

## Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     USER DOES THIS                          │
│                                                             │
│  1. Start server (once)                                     │
│  2. Create repo + init project                              │
│  3. Populate Problem Pack (problem, success criteria, etc.) │
│  4. (Optional) Consult Solution Architect for feedback      │
│     └─ iterate on Problem Pack until satisfied              │
│  5. Launch the iterative development process                │
│     └─ review & provide feedback at pause cadence           │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                     cf² HANDLES THIS                        │
│                                                             │
│  • Assemble context (CLAUDE.md + cfcf-docs/)                │
│  • Launch dev agent on feature branch                       │
│  • Capture logs, parse handoff + signals                    │
│  • Launch judge agent, parse assessment                     │
│  • Decide: continue / pause / stop                          │
│  • Alert user when input is needed                          │
│  • Monitor + report progress via CLI / web UI               │
└─────────────────────────────────────────────────────────────┘
```

---

## Step 1: Start the Server

The cf² server must be running for all CLI commands to work. Start it once and leave it running:

```bash
# Check if already running
cfcf server status

# Start if needed
cfcf server start
```

The server runs in the background. You can stop it anytime with `cfcf server stop`.

---

## Step 2: One-Time Setup (First Use Only)

Run once after installing cf²:

```bash
cfcf init
```

This detects installed AI agents (Claude Code, Codex), asks for configuration defaults (dev agent, judge agent, iteration limits), explains the permission flags, and saves the config. The configuration can be changed later with:

```bash
cfcf config edit
```
or
```bash
cfcf init --force
```

---

## Step 3: Create the Project

### 3a. Prepare a Git Repo

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

### 3b. Register with cf²

```bash
cfcf project init --repo /path/to/my-project --name my-project
```

This creates:
- A project config in cf²'s config directory
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

## Step 5: Consult the Solution Architect (Optional, Recommended)

Before launching the development process, you can ask cf²'s **Solution Architect** agent to review your Problem Pack. This is an advisory tool for the user -- it is not a gate or a requirement. You can skip this step entirely, or iterate on it as many times as you want.

```bash
cfcf review --project my-project
```

The Solution Architect reads your Problem Pack and produces:
- `cfcf-docs/architect-review.md` -- a human-readable assessment: is the problem definition clear? Are success criteria measurable? Are there gaps or ambiguities? Suggested improvements and risk factors.
- `cfcf-docs/cfcf-architect-signals.json` -- structured readiness signal (READY / NEEDS_REFINEMENT / BLOCKED)

### The user's iterative refinement loop:

```
  ┌──────────────────────────────────────────────────┐
  │  1. Run: cfcf review --project my-project        │
  │  2. Read: cfcf-docs/architect-review.md          │
  │  3. The architect points out gaps/suggestions     │
  │  4. User updates problem-pack/ files              │
  │  5. Run cfcf review again if desired              │
  │  └─ Repeat until satisfied                        │
  └──────────────────────────────────────────────────┘
```

**Important:** The user decides when the Problem Pack is ready. The architect provides advice, not permission. You can launch development at any time, even if the architect suggests refinements. The architect's review persists in the repo as additional context for dev agents.

> **Note:** The Solution Architect role is planned for iteration 3 of cf² development. Currently, the user is responsible for ensuring Problem Pack quality.

---

## Step 6: Launch the Iterative Development Process

When you feel the Problem Pack adequately describes the problem, launch the dark factory:

```bash
# Launch cf² -- it takes over from here
cfcf run --project my-project --max-iterations 10 --pause-every 3
```

**This is the last user action until cf² needs input.** From this point, cf² manages everything autonomously:

### What cf² does automatically (each iteration):

```
┌─────────────────────────────────────────────────────────────────┐
│ ITERATION LOOP (cf² manages this autonomously)                   │
│                                                                  │
│  1. Assemble context (CLAUDE.md + cfcf-docs/ from Problem Pack)  │
│  2. Create git feature branch: cfcf/iteration-N                  │
│  3. Launch dev agent (e.g., Claude Code)                         │
│  4. Agent works: reads context, plans, codes, tests              │
│  5. Agent produces handoff doc + signal file                     │
│  6. cf² captures logs, commits all changes                       │
│  7. Launch judge agent (e.g., Codex)                             │
│  8. Judge reviews: determines SUCCESS/PROGRESS/STALLED/ANOMALY   │
│  9. cf² decides next action:                                     │
│     ├─ SUCCESS → merge to main, push, notify user. Done.         │
│     ├─ PROGRESS → continue to next iteration                     │
│     ├─ STALLED → alert user, wait for input                      │
│     ├─ ANOMALY → alert user, wait for input                      │
│     ├─ User input needed → alert user with questions, wait       │
│     └─ Pause cadence reached → alert user, wait for feedback     │
│                                                                  │
│  Loop continues until: success, max iterations, or user stops    │
└─────────────────────────────────────────────────────────────────┘
```

### The CLI shows real-time progress:

```
cf² dark factory started for project: my-project
Max iterations: 10, pause every: 3

Iteration 1 started on branch cfcf/iteration-1
Status: preparing
Status: executing...................
Status: collecting
Status: judging...
Status: completed (PROGRESS -- quality: 7/10)

Iteration 2 started on branch cfcf/iteration-2
Status: executing............................
Status: completed (PROGRESS -- quality: 8/10)

Iteration 3 started on branch cfcf/iteration-3
Status: executing...............
Status: completed (PROGRESS -- quality: 9/10)

--- Pause: review cadence reached (every 3 iterations) ---
Review the current state and provide feedback.
  cfcf project show my-project
  cat cfcf-docs/judge-assessment.md
  cat cfcf-docs/plan.md
Resume with: cfcf resume --project my-project
```

### Monitoring (anytime during execution):

The user can monitor progress without interrupting the process:

```bash
# Quick status
cfcf status --project my-project

# Watch the current iteration's live log
tail -f ~/.cfcf/logs/<project-id>/iteration-NNN-dev.log

# Check the latest judge assessment
cat cfcf-docs/judge-assessment.md

# View iteration history
cat cfcf-docs/iteration-history.md

# Web UI (future)
# Open http://localhost:7233 in a browser
```

### When cf² involves the user:

cf² pauses and alerts the user in these situations:

| Situation | What happens |
|-----------|-------------|
| **Pause cadence** (e.g., every 3 iterations) | cf² shows a summary. User reviews, provides feedback, resumes or stops. |
| **Agent has questions** | Dev agent flagged `user_input_needed` in signal file. cf² presents the questions. |
| **Judge flags anomaly** | Token exhaustion, circling, regression detected. cf² alerts user. |
| **Judge says STALLED** | No progress for N consecutive iterations. cf² alerts user. |
| **Success** | All success criteria met. cf² merges to main, pushes, notifies user. |
| **Max iterations reached** | cf² stops and reports final state. |

### User actions at pause points:

- **Review** the current state: judge assessment, iteration history, code changes, the evolving plan
- **Provide feedback**: cf² captures it in `user-feedback.md` for the next iteration's agent to read
- **Refine hints**: update `problem-pack/hints.md` with new guidance based on what you've seen
- **Resume**: `cfcf resume --project my-project`
- **Stop**: `cfcf stop --project my-project`

---

## Step 7: Inspect Results

After the process completes (success, max iterations, or user stop):

```bash
# See the code changes across all iterations
cd /path/to/my-project
git log --oneline --all | grep cfcf

# Read the final handoff
cat cfcf-docs/iteration-handoff.md

# Read the judge's final assessment
cat cfcf-docs/judge-assessment.md

# Review the full iteration history
cat cfcf-docs/iteration-history.md

# Check the decision log
cat cfcf-docs/decision-log.md

# View any iteration's full agent log
cat ~/.cfcf/logs/<project-id>/iteration-NNN-dev.log
```

---

## What the User Is Responsible For

| Task | When | Required? |
|------|------|-----------|
| Start the server | Before any cf² commands | Yes (once) |
| Run `cfcf init` | First use only | Yes (once) |
| Create/provide the git repo | Before project init | Yes |
| Run `cfcf project init` | Once per project | Yes |
| Write `problem.md` | Before launching iterations | **Yes -- critical** |
| Write `success.md` | Before launching iterations | **Yes -- critical** |
| Write `constraints.md` | Before launching iterations | Optional |
| Write `hints.md` | Before launching or between iterations | Optional |
| Write `style-guide.md` | Before launching iterations | Optional |
| Add `context/*.md` files | Before launching iterations | Optional (recommended for existing repos) |
| Run `cfcf review` (Solution Architect) | Before launching iterations | Optional (recommended) |
| Launch `cfcf run` | When Problem Pack is ready | Yes (once per development cycle) |
| Review results at pause points | When cf² pauses and asks | Recommended |
| Provide feedback at pause points | When cf² pauses and asks | Optional but valuable |

---

## What cf² Handles Automatically

| Task | When |
|------|------|
| Scaffold `problem-pack/` templates | On `cfcf project init` |
| Solution Architect review | On `cfcf review` (user-triggered, advisory) |
| Assemble context (CLAUDE.md + cfcf-docs/) | Before each iteration |
| Create git feature branches | Before each iteration |
| Launch dev agent with proper flags | Each iteration |
| Capture and store agent logs | During each iteration |
| Parse handoff document + signal file | After each iteration |
| Launch judge agent | After each iteration |
| Determine next action (continue/stop/alert) | After each iteration |
| Merge to main on iteration completion | After each iteration |
| Archive judge assessments | After each iteration |
| Alert user when input is needed | When detected |
| Compress iteration history | Before each iteration |
| Monitor and report progress via CLI/web UI | Continuously during execution |

---

## Quick Reference

```bash
# One-time setup
cfcf server start                                  # Start server (check with: cfcf server status)
cfcf init                                          # First-run config

# Per-project setup
cfcf project init --repo <path> --name <name>      # Register project
# Edit problem-pack/problem.md and success.md      # USER WRITES THESE

# Optional: consult the Solution Architect
cfcf review --project <name>                       # Get feedback on Problem Pack
# Read cfcf-docs/architect-review.md               # Review suggestions
# Refine problem-pack/ files, repeat if desired    # Iterate until satisfied

# Launch the dark factory (user decides when ready -- no permission needed)
cfcf run --project <name>                          # cf² takes over
cfcf run --project <name> --max-iterations 10      # With iteration limit
cfcf run --project <name> --pause-every 3          # With review cadence

# Monitor (while running)
cfcf status --project <name>                       # Current state
tail -f ~/.cfcf/logs/<id>/iteration-NNN-dev.log    # Live agent output

# At pause points
cfcf resume --project <name>                       # Continue after review
cfcf stop --project <name>                         # Stop the process

# Manual mode (testing)
cfcf run --project <name> -- <cmd>                 # Run a specific command

# Management
cfcf project show <name>                           # Project config
cfcf project list                                  # All projects
cfcf config show                                   # Global config
cfcf server stop                                   # Stop server
```
