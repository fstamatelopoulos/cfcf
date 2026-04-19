# cf² Workflow Guide

*cfcf and cf² are used interchangeably. Both are pronounced "cf square". `cfcf` is used in code and commands; cf² in documentation.*

This guide walks through the complete cf² workflow: from setting up a project to running iterative AI agent development cycles.

cfcf can be driven from either the **CLI** or the **web GUI** (served by the same local server at `http://localhost:7233`). This guide uses CLI commands in examples, but every action shown here has a web UI equivalent. See `cli-usage.md` for the CLI reference.

---

## Overview

```
┌──────────────────────────────────────────────────────────────┐
│                     USER DOES THIS                           │
│                                                              │
│  1. Start server (once)                                      │
│  2. Create repo + init project                               │
│  3. Populate Problem Pack (problem, success criteria, etc.)  │
│  4. (Recommended) Consult Solution Architect for feedback    │
│     └─ iterate on Problem Pack until satisfied               │
│  5. Launch the iterative development process                 │
│     └─ review & provide feedback at pause cadence            │
│  6. (Optional) Re-consult the Architect or run ad-hoc        │
│     Reflection if you want to extend a finished project      │
└──────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                     cf² HANDLES THIS                         │
│                                                              │
│  Each iteration:                                             │
│   • Assemble context (CLAUDE.md/AGENTS.md + cfcf-docs/)      │
│   • Launch dev agent on feature branch                       │
│   • Capture logs, parse handoff + signals                    │
│   • Launch judge agent, parse assessment                     │
│   • Launch reflection agent (unless judge opts out)          │
│   • Decide: continue / pause / stop                          │
│   • Produce three separate commits (dev / judge / reflect)   │
│   • On SUCCESS: run documenter to produce final docs         │
│   • Alert user when input is needed                          │
│  Cross-iteration plumbing:                                   │
│   • Preserve user's content in CLAUDE.md/AGENTS.md           │
│     (sentinel-delimited cfcf block)                          │
│   • Rebuild iteration-history.md from per-iteration logs     │
│   • Non-destructively protect completed plan items           │
└──────────────────────────────────────────────────────────────┘
```

### Five Agent Roles

cf² uses five independently configurable agent roles:

| Role | Purpose | When it runs |
|------|---------|-------------|
| **Solution Architect** | Reviews Problem Pack, produces initial plan + doc stubs. On re-review: extends the plan non-destructively when new requirements appear. | User-invoked (`cfcf review`) |
| **Dev agent** | Writes code, runs tests, produces handoff + iteration-log | Each iteration |
| **Judge agent** | Reviews dev work, determines progress, may opt out of reflection | After each dev iteration |
| **Reflection agent** | Reads the full cross-iteration history, classifies iteration health, may rewrite pending plan items non-destructively | After the judge on every iteration, unless the judge explicitly opts out |
| **Documenter** | Produces polished final documentation | Auto post-SUCCESS, or `cfcf document` on demand |

Each role can use a different agent and model. Reflection is the strongest-context role -- the project's full history is its input -- so the recommended default is the most capable model available (Claude Opus, GPT-5, etc.). You can configure each role separately in `cfcf init` or via `cfcf config edit`.

### Three Tiers of Evaluation

cf² evaluates every iteration at three levels:

1. **Mechanical** -- tests, type-checks, linters. The dev agent runs them and the judge verifies them.
2. **Per-iteration judgment** -- the Judge assesses the latest iteration only: did it make meaningful progress? Any anomalies? Is the code quality acceptable?
3. **Strategic reflection** -- the Reflection agent reads the *entire* project history (all iteration logs, all prior judge assessments, the decision log, the git log of iteration branches, the tail of the most recent dev log) and classifies trajectory: `converging | stable | stalled | diverging | inconclusive`. Reflection can non-destructively rewrite the *pending* portion of `cfcf-docs/plan.md` when the evidence warrants a strategic shift, or flag `recommend_stop` to pause the loop for you.

Reflection is the only role allowed to edit a plan that already has completed work.

---

## Step 1: Start the Server

The cf² server must be running for all CLI commands to work. Start it once and leave it running:

```bash
# Check if already running
cfcf server status

# Start if needed
cfcf server start
```

The server runs in the background. You can stop it anytime with `cfcf server stop`. The web GUI is reachable at `http://localhost:7233`. A read-only server + config page is available at `http://localhost:7233/#/server` and linked from the Dashboard.

---

## Step 2: One-Time Setup (First Use Only)

Run once after installing cf²:

```bash
cfcf init
```

This detects installed AI agents (Claude Code, Codex), asks for configuration defaults for all five roles (dev, judge, architect, documenter, reflection), asks for `reflectSafeguardAfter` (how many consecutive judge opt-outs before cfcf forces reflection -- default 3), explains the permission flags, and saves the config. The configuration can be changed later with:

```bash
cfcf config edit    # or: cfcf init --force
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

cfcf will **preserve any existing `CLAUDE.md` / `AGENTS.md`** in the repo. Iteration-specific instructions are inserted between sentinel markers (`<!-- cfcf:begin --> ... <!-- cfcf:end -->`); your own content outside the markers is never touched. See "CLAUDE.md / AGENTS.md" below.

### 3b. Register with cf²

```bash
cfcf project init --repo /path/to/my-project --name my-project
```

This creates:
- A project config in cf²'s config directory
- A `problem-pack/` directory in your repo with template files

---

## Files you edit vs. files cfcf regenerates

Before you start writing the Problem Pack, it helps to know which files in the repo you own and which cfcf treats as generated copies.

| Directory | Role | Edit here? |
|---|---|---|
| `problem-pack/` | **User-owned source of truth.** `problem.md`, `success.md`, and the optional `constraints.md` / `hints.md` / `style-guide.md` / `context/*` live here. | ✅ Yes -- this is where you describe the problem. |
| `cfcf-docs/problem.md` and friends | **Generated copies.** cfcf copies from `problem-pack/` into `cfcf-docs/` at the start of every run (iteration, pre-loop review, architect review) so agents have a single `cfcf-docs/` surface to read. | ❌ No -- cfcf overwrites these on every run. Every generated copy also carries a banner at the top saying so. |
| `cfcf-docs/plan.md` | Agent-maintained -- dev agent + reflection role + architect re-review mode edit it through cfcf's controlled path. | Read-only for you, except when the loop is paused and you want to manually hand-edit before resuming. |
| `cfcf-docs/iteration-logs/iteration-N.md` | Written by the dev agent at the end of each iteration. cfcf rebuilds `iteration-history.md` from these. | Read-only. |
| `cfcf-docs/decision-log.md` | Multi-role append-only journal (dev, judge, architect, reflection, user all append tagged entries). | You may append entries (use the `[role: user]` tag). |
| `cfcf-docs/*-signals.json` | Machine-readable signal files. Reset before each agent spawn, read by cfcf after. | Don't edit by hand. |
| `CLAUDE.md` / `AGENTS.md` (at the repo root) | The cfcf-generated block lives between `<!-- cfcf:begin -->` and `<!-- cfcf:end -->`. Anything outside those markers is yours and cfcf never touches it. | Edit OUTSIDE the sentinel block (above or below). Never edit inside -- those lines get rewritten every iteration. |

**Rule of thumb:** if you want a change to persist across runs, edit a file in `problem-pack/` or outside the sentinels in `CLAUDE.md`/`AGENTS.md`. Never edit a file in `cfcf-docs/` unless you are appending to `decision-log.md`.

cfcf prepends a comment banner to every generated copy under `cfcf-docs/` so this is visible in the file itself:

```markdown
<!--
  cfcf: this file is generated from problem-pack/problem.md and is overwritten
  on every run (pre-loop review, iteration, or architect review).
  DO NOT EDIT HERE -- your changes will be lost. Edit the source at
  problem-pack/problem.md instead.
-->
```

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

Before launching the development process, you can ask cf²'s **Solution Architect** agent to review your Problem Pack. This is an advisory tool -- not a gate or requirement. You can skip it entirely, or iterate as many times as you want.

```bash
cfcf review --project my-project
```

The Solution Architect reads your Problem Pack and produces:
- **`cfcf-docs/architect-review.md`** -- readiness assessment, gaps, ambiguities, security considerations, risk factors, recommendations
- **`cfcf-docs/plan.md`** -- initial implementation plan outline for the dev agent to build on
- **`docs/architecture.md`**, **`docs/api-reference.md`**, **`docs/setup-guide.md`** -- initial documentation stubs (first-run only)
- **`cfcf-docs/cfcf-architect-signals.json`** -- structured readiness signal (READY / NEEDS_REFINEMENT / BLOCKED)

### The architect has two modes

**First-run mode.** `cfcf-docs/plan.md` doesn't exist (or has no completed items yet). The architect scaffolds a fresh plan from the Problem Pack.

**Re-review mode.** `cfcf-docs/plan.md` already has completed items (`[x]`) -- i.e. previous iterations have shipped. The architect:
- Reads the full history first (iteration logs, decision log, reflection reviews) to understand what was already delivered.
- Compares to the current Problem Pack. If new requirements appeared (e.g. you added a new section to `problem.md`), the architect **appends** new pending iterations to `plan.md` rather than rewriting it.
- If the current plan still covers the Problem Pack, the architect leaves `plan.md` untouched and says so in `architect-review.md`.
- Never deletes completed items or iteration headers. cfcf enforces this: any destructive rewrite is auto-reverted and logged.

This means you can safely re-run `cfcf review` mid-project or after a finished loop when you've added new requirements -- the architect won't erase the audit trail.

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

**Important:** The user decides when the Problem Pack is ready. The architect provides advice, not permission. You can launch development at any time, even if the architect suggests refinements.

---

## Step 6: Launch the Iterative Development Process

When you feel the Problem Pack adequately describes the problem, launch the dark factory:

```bash
# Launch cf² -- it takes over from here
cfcf run --project my-project
```

**This is the last user action until cf² needs input.** From this point, cf² manages everything autonomously.

### Per-iteration flow (what cf² does automatically)

```
┌──────────────────────────────────────────────────────────────────┐
│ PRE-LOOP (conditional, only when autoReviewSpecs=true; item 5.1) │
│                                                                  │
│  REVIEW (agent)      Solution Architect runs against the         │
│                      current Problem Pack. Output (review +      │
│                      plan + doc stubs) commits to main (NOT an   │
│                      iteration branch). readinessGate decides    │
│                      whether the loop proceeds:                  │
│                        "never"   -> always proceed (informational)│
│                        "blocked" -> stop only on BLOCKED         │
│                        "needs_refinement_or_blocked" -> stop on  │
│                                     anything but READY.          │
│                      On block: loop pauses with the architect's  │
│                      gaps as pending questions.                  │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│ ITERATION N                                                      │
│                                                                  │
│  PREPARE (cf²)       Assemble context -- merge cfcf block into   │
│                      CLAUDE.md/AGENTS.md, rebuild                │
│                      iteration-history.md from iteration-logs,   │
│                      create branch cfcf/iteration-N              │
│                                                                  │
│  DEV (agent)         Fresh agent process; reads plan.md,         │
│                      executes the next pending chunk, updates    │
│                      plan.md with [x] + notes, writes            │
│                      iteration-logs/iteration-N.md,              │
│                      iteration-handoff.md, iteration signals     │
│                      → commit: "cfcf iteration N dev (<adapter>)"│
│                                                                  │
│  JUDGE (agent)       Fresh agent process; assesses this          │
│                      iteration; writes judge-assessment.md       │
│                      + signals (determination, quality score,    │
│                      tests, concerns, reflection_needed opt-out) │
│                      → commit: "cfcf iteration N judge (...)"    │
│                                                                  │
│  REFLECT (agent,     Conditional. Runs unless the judge set      │
│  conditional)        reflection_needed:false AND we're still     │
│                      under the reflectSafeguardAfter ceiling.    │
│                      Reads FULL history. Writes                  │
│                      reflection-analysis.md + signals. May       │
│                      rewrite pending plan items non-             │
│                      destructively (completed items are          │
│                      protected; destructive rewrites are auto-   │
│                      reverted). May flag recommend_stop.         │
│                      → commit: "cfcf iteration N reflect         │
│                         (<health>): <key_observation>"           │
│                                                                  │
│  DECIDE (cf²)        Read all signals. Decision engine picks:    │
│                        SUCCESS  → run documenter, merge, push    │
│                        PROGRESS → continue to next iteration     │
│                        STALLED  → apply onStalled policy         │
│                        ANOMALY  → pause, alert user              │
│                        reflection.recommend_stop → pause         │
│                          (takes precedence over judge)           │
│                        pause cadence reached → pause, alert      │
│                      Auto-merge the branch to main if configured │
│                                                                  │
│  DOCUMENT (agent)    Only on SUCCESS. Produces polished          │
│                      docs/ (architecture, api-reference,         │
│                      setup-guide, README). Skipped when          │
│                      autoDocumenter=false (item 5.1) -- user     │
│                      can invoke `cfcf document` manually.        │
└──────────────────────────────────────────────────────────────────┘
```

### The pre-loop review cycle (when `autoReviewSpecs=true`)

This deserves its own walkthrough -- it's a tight user-in-the-loop pattern for getting the Problem Pack right before burning iterations.

**Branching.** Pre-loop review runs on the **current branch** (typically `main`). No iteration branch is created yet. Review artifacts -- `architect-review.md`, `plan.md`, `cfcf-architect-signals.json`, the `docs/*.md` stubs, and `user-feedback.md` -- all commit to `main` as a single `cfcf pre-loop review (<readiness>)` commit. Iteration branches come later, after the readiness gate accepts the review.

**The gate cycle.**

1. Start Loop (web UI) or `cfcf run` (CLI) → cfcf runs the architect as the first phase. Web UI shows `Review (agent)` lit up in the PhaseIndicator.
2. Architect writes its output and exits. cfcf reads the readiness signal.
3. **If `readinessGate` accepts** (default `"blocked"` means accept anything but `BLOCKED`): cfcf proceeds to iteration 1. The iteration branch `cfcf/iteration-1` is created from `main` and inherits the architect's artifacts + `user-feedback.md`.
4. **If `readinessGate` rejects**: cfcf pauses the loop with `pauseReason: "anomaly"` and the architect's gaps populated as `pendingQuestions`. The web UI shows the FeedbackForm; the CLI prints the questions via `cfcf status` and offers `cfcf resume`. The PhaseIndicator stays at `Review (agent) -- PAUSED`.
5. **User refines and resumes.** Two paths, composable:
    - **Edit the source.** Open `problem-pack/problem.md` and/or `problem-pack/success.md` in your editor and tighten the spec based on the architect's listed gaps. (Remember: `cfcf-docs/problem.md` is a generated copy -- see the "Files you edit vs. files cfcf regenerates" section above.)
    - **Provide guidance.** Type a clarifying answer into the FeedbackForm (web) or pass it via `cfcf resume --feedback "..."` (CLI). The text is written to `cfcf-docs/user-feedback.md` on main before the next architect spawn, so the architect sees it too. This is especially useful when the gap is small and doesn't warrant reopening the Problem Pack.
    - Either / both / neither + Resume -- all valid. A Resume with no changes and no feedback re-runs the architect against the same source; useful if you suspect the previous spawn was a one-off stumble.
6. cfcf re-runs the architect (same `pre_loop_reviewing` phase, new `architect-NNN.log` sequence). Back to step 2.
7. Eventually the gate accepts and the loop moves on. `state.userFeedback` carries through to iteration 1's `user-feedback.md` so the dev agent reads it too; it clears automatically after iteration 1's DECIDE phase.

**History-tab label.** Pre-loop reviews appear in the History tab as **"Pre-loop review"** (loop-triggered). Manual `cfcf review` runs stay labeled **"Review"**. Both share the same `ArchitectReview` expanded-row detail -- only the top-line label distinguishes them.

**Stopping vs resuming.** If the pre-loop gate never accepts and you want to bail out entirely (rewrite the problem pack wholesale, change strategy), `cfcf stop --project <name>` ends the loop in a clean terminal state. The pre-loop review commit on main is preserved (useful for audit); you can start a fresh loop later.

### Behaviour flags: `autoReviewSpecs`, `autoDocumenter`, `readinessGate` (item 5.1)

Three settings shape whether Review runs inside the loop and whether the Documenter auto-runs on SUCCESS. Each is available at three tiers with the standard priority order: **per-run CLI flag → project config → global config → hard default**.

| Key | Default | Effect |
|-----|---------|--------|
| `autoReviewSpecs` | `false` | When `true`, Start Loop first runs the Solution Architect as a pre-loop phase; the standalone Review button is hidden in the web UI; a leading `Review (agent)` step appears in the phase indicator. |
| `autoDocumenter` | `true` | When `false`, the loop reaches SUCCESS and skips the Documenter; the `Document` step is absent from the phase indicator; the standalone `cfcf document` command still works. |
| `readinessGate` | `"blocked"` | Only consulted when `autoReviewSpecs=true`. Levels: `"never"` (always proceed), `"blocked"` (stop only on `BLOCKED`), `"needs_refinement_or_blocked"` (strictest; stop on anything but `READY`). |

Per-run CLI overrides on `cfcf run`:

```
--auto-review / --no-auto-review
--auto-document / --no-auto-document
--readiness-gate <never|blocked|needs_refinement_or_blocked>
```

Example: "try once without the pre-loop review even though the project default has it on":
```bash
cfcf run --project my-project --no-auto-review
```

Each iteration produces **up to three separate commits** (dev / judge / reflect) on the feature branch, so `git log --oneline cfcf/iteration-N` reads as a clean per-iteration story.

### One phase per iteration, one clean session per phase

Every agent invocation is a **separate, clean process** -- no session continuity, no memory carried over except files on disk. cf² enforces and leverages this:

- The Solution Architect's `cfcf-docs/plan.md` maps phases to concrete iterations (`## Iteration 1 -- Foundation`, `## Iteration 2 -- Core features`, ...).
- Each iteration's generated `CLAUDE.md` (for Claude Code) or `AGENTS.md` (for Codex) includes an **Iteration Scope** section instructing the dev agent to execute only the **next pending chunk** from the plan.
- Before exiting, the dev agent marks completed items `[x]` in `plan.md` with a short note and writes a per-iteration changelog at `cfcf-docs/iteration-logs/iteration-N.md`. cf² uses those log files to rebuild `iteration-history.md` before the next iteration, so history survives server restarts.
- The next iteration -- a brand new agent process -- picks up from there.

You do not have to configure this -- it is baked into the dev-agent prompt generated for every iteration.

### `CLAUDE.md` / `AGENTS.md` (sentinel-based merge, v0.7.0+)

cf² regenerates a block of iteration-specific context for the dev agent every iteration. To avoid destroying user-authored content, it uses sentinel markers:

```
<!-- cfcf:begin -->
# cfcf Iteration N Instructions
…generated each iteration…
<!-- cfcf:end -->

# My project notes
…your own content, never touched by cfcf…
```

Rules:
- File doesn't exist → cfcf creates it with the marked block only.
- File exists *without* markers → cfcf prepends the marked block, preserves your content below untouched.
- File exists *with* markers → cfcf updates only the content between markers. Your content outside is inviolate, byte-for-byte.
- You removed the markers by hand → cfcf falls back to the "prepend" branch on the next iteration (no data loss, just re-inserts the sentinel section).

**Rule of thumb:** Anything between the sentinel markers is cfcf-owned and will be overwritten. Anything outside is yours.

### The CLI shows real-time progress

```
Project:  my-project
Mode:     dark factory (iteration loop)

Iteration loop started (max 10 iterations)
Will pause for review every 3 iterations

preparing [iteration 1]
dev_executing [iteration 1] 3m 22s
judging [iteration 1] 1m 05s
reflecting [iteration 1] 55s
preparing [iteration 2]
dev_executing [iteration 2] 2m 48s
judging [iteration 2] 58s
reflecting [iteration 2] 1m 10s
…

paused [iteration 3]

=== Loop PAUSED ===
Project:    my-project
Iteration:  3/10
Reason:     cadence
Last judge: PROGRESS (quality: 8/10)
Last reflect: stable · "Auth layer is coming together cleanly."
```

### The web GUI shows even more

- A pulsing blue dot + phase label (e.g. `my-project: reflect #3`) appears in the top bar whenever *any* agent is running anywhere.
- The History tab shows each iteration plus a separate row per reflection run. Clicking a row expands it to show the full parsed signals (determination, quality, test counts, key concerns, reflection opt-out, iteration health, plan-modified vs rejected-with-reason, etc.).
- The PhaseIndicator component labels each step with `(cf²)` or `(agent)` so you can tell at a glance which phases are deterministic plumbing vs LLM invocations.

### Monitoring (anytime during execution)

```bash
# Quick status
cfcf status --project my-project

# Watch the current iteration's live log
tail -f ~/.cfcf/logs/<project-id>/iteration-NNN-dev.log
tail -f ~/.cfcf/logs/<project-id>/reflection-NNN.log

# Check the latest judge assessment
cat cfcf-docs/judge-assessment.md

# Check the latest reflection analysis
cat cfcf-docs/reflection-analysis.md

# View iteration history (rebuilt from iteration-logs each iteration)
cat cfcf-docs/iteration-history.md

# Browse per-iteration changelogs
ls cfcf-docs/iteration-logs/

# Read the cross-role decision log
cat cfcf-docs/decision-log.md
```

### Notifications

When running unattended, cf² can notify you via terminal bell + native macOS/Linux notifications when a loop pauses, completes, or an agent fails. Configured during `cfcf init`. See `docs/guides/cli-usage.md` under "Notifications" for details.

When the decision log grows past 50 iterations, cf² fires a single informational notification suggesting you consider archiving it. No auto-trim -- the log is yours.

### When cf² involves the user

| Situation | What happens |
|-----------|-------------|
| **Pause cadence** (every N iterations) | cf² shows a summary. User reviews, provides feedback, resumes or stops. |
| **Agent has questions** | Dev agent flagged `user_input_needed` in signal file. cf² presents the questions. |
| **Judge flags anomaly** | Token exhaustion, circling, regression detected. cf² alerts user. |
| **Judge says STALLED** | No progress for N consecutive iterations. cf² alerts user. |
| **Reflection flags `recommend_stop`** | Reflection believes the loop is fundamentally stuck. cf² pauses and alerts the user. This takes precedence over a judge `PROGRESS` vote. |
| **Success** | All criteria met. cf² runs documenter, merges to main, pushes, notifies user. |
| **Max iterations reached** | cf² stops and reports final state. |

### User actions at pause points

```bash
# Review
cat cfcf-docs/judge-assessment.md
cat cfcf-docs/reflection-analysis.md
cat cfcf-docs/plan.md

# Resume (optionally with feedback for the next iteration)
cfcf resume --project my-project
cfcf resume --project my-project --feedback "Focus on error handling"

# Stop the loop
cfcf stop --project my-project
```

---

## Step 7: Reflection On Demand (Optional)

Outside the iteration loop, you can invoke the Reflection role manually:

```bash
cfcf reflect --project my-project
cfcf reflect --project my-project --prompt "focus on the auth-layer drift"
```

This is useful when you:
- Want a strategic health-check on a long-running project without running another iteration.
- Added new requirements and want reflection to suggest plan changes before kicking off the next loop.
- Want to see whether the reflection agent would recommend stopping (its `recommend_stop` signal).

Ad-hoc reflection does NOT modify `loop-state.json` and does NOT write an `iteration-log` (no iteration happened). It DOES write `reflection-analysis.md`, update `cfcf-reflection-signals.json`, and append a `decision-log.md` entry so the strategic note survives for the next loop.

---

## Step 8: Documentation (Automatic + On-Demand)

### Automatic (post-SUCCESS)

When the judge determines SUCCESS, cf² automatically runs the **Documenter** agent before completing the loop. The documenter reads the final codebase and produces polished documentation:

- `docs/architecture.md` -- system architecture, components, data flow
- `docs/api-reference.md` -- API endpoints, data models, error handling
- `docs/setup-guide.md` -- prerequisites, installation, running, testing
- `docs/README.md` -- project overview and quick start

These build on the doc stubs created by the architect and maintained by the dev agent.

### On-demand

You can also run the documenter manually at any time:

```bash
cfcf document --project my-project
```

This is useful for regenerating docs after manual code changes, or if you want to run it on a project that didn't go through the full loop.

---

## Step 9: Inspect Results

After the process completes (success, max iterations, or user stop):

```bash
# See the per-iteration commits -- dev / judge / reflect appear as a three-commit story
cd /path/to/my-project
git log --oneline --all | grep "cfcf iteration"

# Read the final handoff
cat cfcf-docs/iteration-handoff.md

# Read the judge's final assessment
cat cfcf-docs/judge-assessment.md

# Read the latest reflection analysis
cat cfcf-docs/reflection-analysis.md

# Review the full iteration history (rebuilt from iteration-logs)
cat cfcf-docs/iteration-history.md

# Browse per-iteration changelogs
ls cfcf-docs/iteration-logs/
cat cfcf-docs/iteration-logs/iteration-3.md

# Browse archived reflection analyses
ls cfcf-docs/reflection-reviews/

# Check the cross-role decision log
cat cfcf-docs/decision-log.md

# Read the generated documentation
cat docs/architecture.md
cat docs/setup-guide.md

# View any iteration's full agent log
cat ~/.cfcf/logs/<project-id>/iteration-NNN-dev.log
cat ~/.cfcf/logs/<project-id>/reflection-NNN.log
```

---

## Extending a Finished Project

cf² is designed for the "add more work later" case. The flow for extending a successful project:

```
1. Edit problem-pack/problem.md + success.md with the new requirements.
2. cfcf review --project my-project
   → architect enters re-review mode, reads the full history, appends
     new pending iterations to plan.md (or says "plan is still valid")
3. (Optional) cfcf reflect --project my-project
   → ad-hoc reflection confirms health + notes any strategic concerns
4. cfcf run --project my-project
   → loop picks up the next pending iteration in the appended plan
```

Because the non-destructive rules are applied to both architect re-review *and* reflection-during-loop, completed work from prior iterations is never lost.

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
| Run `cfcf review` (Solution Architect) | Before launching iterations, or to re-review after adding requirements | Optional (recommended) |
| Launch `cfcf run` | When Problem Pack is ready | Yes (once per development cycle) |
| Review results at pause points | When cf² pauses and asks | Recommended |
| Provide feedback at pause points | When cf² pauses and asks | Optional but valuable |
| Run `cfcf reflect` | Ad-hoc strategic health-check, or between extending-loop invocations | Optional |

---

## What cf² Handles Automatically

| Task | When |
|------|------|
| Scaffold `problem-pack/` templates | On `cfcf project init` |
| Solution Architect review (first-run or re-review) | On `cfcf review` (user-triggered, advisory) |
| Assemble context (sentinel-merged CLAUDE.md/AGENTS.md + cfcf-docs/) | Before each iteration |
| Preserve user content in CLAUDE.md/AGENTS.md outside sentinel markers | Every iteration |
| Rebuild `iteration-history.md` from committed iteration-logs | Before each iteration |
| Create git feature branches | Before each iteration |
| Launch dev agent with proper flags | Each iteration |
| Capture and store agent logs | During each iteration |
| Parse handoff document + signal file | After each iteration |
| Launch judge agent | After each iteration |
| Launch reflection agent (unless judge opts out and safeguard not hit) | After each judge |
| Non-destructively validate plan rewrites by reflection or architect | Each time plan.md changes |
| Produce three separate commits per iteration (dev / judge / reflect) | Each iteration |
| Determine next action (continue/stop/alert) | After each iteration |
| Merge to main on iteration completion | After each iteration (auto-merge mode) |
| Archive judge assessments + reflection analyses | After each iteration |
| Emit pulsing activity indicator in web UI | Whenever any agent is running anywhere |
| Alert user when input is needed | When detected |
| Warn when decision log crosses 50 entries | Once per loop run |
| Run documenter on SUCCESS | After judge says SUCCESS |
| Persist loop state to disk | On every phase transition |
| Monitor and report progress via CLI | Continuously during execution |

---

## Quick Reference

```bash
# One-time setup
cfcf server start                                  # Start server
cfcf init                                          # First-run config (five agent roles)

# Per-project setup
cfcf project init --repo <path> --name <name>      # Register project
# Edit problem-pack/problem.md and success.md      # USER WRITES THESE

# Solution Architect review (optional, recommended)
cfcf review --project <name>                       # Get feedback + plan outline
                                                    # (re-review-aware on existing projects)
# Read cfcf-docs/architect-review.md               # Review suggestions
# Refine problem-pack/ files, repeat if desired

# Launch the dark factory
cfcf run --project <name>                          # cf² takes over

# Monitor (while running)
cfcf status --project <name>                       # Current state
tail -f ~/.cfcf/logs/<id>/iteration-NNN-dev.log    # Live dev output
tail -f ~/.cfcf/logs/<id>/reflection-NNN.log      # Live reflection output

# At pause points
cfcf resume --project <name>                       # Continue after review
cfcf resume --project <name> --feedback "..."      # Continue with direction
cfcf stop --project <name>                         # Stop the process

# Strategic health-check (ad-hoc, no iteration)
cfcf reflect --project <name>
cfcf reflect --project <name> --prompt "focus on X"

# Documentation (on-demand, also runs auto post-SUCCESS)
cfcf document --project <name>                     # Generate polished docs

# Manual mode (testing)
cfcf run --project <name> -- <cmd>                 # Run a specific command

# Management
cfcf project show <name>                           # Project config
cfcf project list                                  # All projects
cfcf config show                                   # Global config
cfcf server stop                                   # Stop server
```
