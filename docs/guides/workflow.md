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

## Step 6: Solution Architect Review (Pre-Iteration Gate)

Before development iterations begin, cf² invokes a **Solution Architect** agent to review the Problem Pack and all provided context. This is a pre-iteration validation step.

```bash
cfcf review --project my-project
```

The Solution Architect agent:
1. Reads the full Problem Pack (problem.md, success.md, constraints, hints, context)
2. Assesses: Is the problem definition clear and actionable? Are success criteria measurable? Are there gaps or ambiguities?
3. Produces a **review report** (`cfcf-docs/architect-review.md`) with:
   - Readiness assessment: READY / NEEDS_REFINEMENT / BLOCKED
   - Identified gaps or ambiguities in the problem definition
   - Suggested clarifications or missing context
   - Recommended approach or architectural considerations
   - Risk factors and potential blockers
4. Writes a signal file (`cfcf-docs/cfcf-architect-signals.json`) for cf² to parse

If the review says **READY**: the user can proceed to launch iterations.
If **NEEDS_REFINEMENT**: the user refines the Problem Pack based on the feedback and re-runs the review.
If **BLOCKED**: fundamental issues must be resolved before development can begin.

The review report persists in the repo and is available to dev agents in subsequent iterations as additional context.

**Configuration:** The user selects which agent (and model) to use for the Solution Architect role, independently from the dev and judge agents.

> **Note:** This feature is planned for iteration 3 of cf² development. Currently, the user is responsible for ensuring the Problem Pack is adequate before launching iterations.

---

## Step 7: Launch the Iterative Development Process

When the Problem Pack is ready (and the Solution Architect has given the green light), the user launches the automated development process:

```bash
# Launch the dark factory -- cf² takes over from here
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

## Step 8: Inspect Results

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
| Create/provide the git repo | Before project init | Yes |
| Run `cfcf project init` | Once per project | Yes |
| Write `problem.md` | Before first iteration | **Yes -- critical** |
| Write `success.md` | Before first iteration | **Yes -- critical** |
| Write `constraints.md` | Before first iteration | Optional |
| Write `hints.md` | Before first iteration or between iterations | Optional |
| Write `style-guide.md` | Before first iteration | Optional |
| Add `context/*.md` files | Before first iteration | Optional (recommended for existing repos) |
| Run `cfcf review` (Solution Architect) | Before first iteration | Recommended |
| Launch `cfcf run` | Once, when ready | Yes |
| Review results at pause points | When cf² pauses and asks | Recommended |
| Provide feedback at pause points | When cf² pauses and asks | Optional but valuable |

---

## What cf² Handles Automatically

| Task | When |
|------|------|
| Scaffold `problem-pack/` templates | On `cfcf project init` |
| Solution Architect review | On `cfcf review` (pre-iteration gate) |
| Assemble context (CLAUDE.md + cfcf-docs/) | Before each iteration |
| Create git feature branches | Before each iteration |
| Launch dev agent with proper flags | Each iteration |
| Capture and store agent logs | During each iteration |
| Parse handoff document + signal file | After each iteration |
| Launch judge agent | After each iteration |
| Determine next action (continue/stop/alert) | After each iteration |
| Archive judge assessments | After each iteration |
| Merge to main on iteration completion | After each iteration |
| Alert user when input is needed | When detected |
| Compress iteration history | Before each iteration |
| Monitor and report progress via CLI/web UI | Continuously during execution |

---

## Quick Reference

```bash
# One-time setup
cfcf init                                          # First-run config
cfcf server start                                  # Start server

# Per-project setup
cfcf project init --repo <path> --name <name>      # Register project
# Edit problem-pack/problem.md and success.md      # USER WRITES THESE

# Pre-iteration review (future)
cfcf review --project <name>                       # Solution Architect review

# Launch the dark factory
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

# Inspect
cfcf project show <name>                           # Project config
cfcf project list                                  # All projects
cfcf config show                                   # Global config
```
