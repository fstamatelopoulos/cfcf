# cfcf: Agent Process & Context Definition

*cfcf and cf² are used interchangeably. Both are pronounced "cf square." `cfcf` in code; cf² in docs.*

**Status:** Living Document
**Date:** April 2026
**Authors:** Fotis Stamatelopoulos, Claude
**Related Documents:** cfcf Requirements & Vision, cfcf Tech Stack, cfcf Development Plan

---

## 1. Purpose

This document defines the concrete process that governs each iteration: what files cfcf injects into the repo, what the agent is expected to do, what artifacts the agent produces, and how cfcf collects results. This is the operational contract between cfcf (the harness) and the dev agent.

---

## 2. Two Scenarios

In both scenarios, cf² handles the scaffolding and automation, but **the user is responsible for providing the problem definition** -- cf² cannot know what to build without the user populating the Problem Pack files. See `../guides/workflow.md` for the complete step-by-step workflow.

### 2.1 Blank Slate Project

The user starts a new project from scratch:

1. **User** creates or provides a local git repo.
2. **User** runs `cfcf project init` -- cf² scaffolds `problem-pack/` with template files.
3. **User** populates the Problem Pack: writes `problem.md` (what to build), `success.md` (how to measure success), and optionally `constraints.md`, `hints.md`, `style-guide.md`, and `context/` files.
4. **User** triggers `cfcf run` -- cf² assembles context, injects `cfcf-docs/` and `CLAUDE.md`, and launches the agent.
5. No existing source code -- the agent builds from scratch based on the user's problem definition.

### 2.2 Existing Project

The user has an existing repo with source code, tests, CI, etc.:

1. **User** runs `cfcf project init` pointing at the existing repo -- cf² scaffolds `problem-pack/`.
2. **User** populates the Problem Pack, including context files that describe the existing codebase, architectural decisions, and the new features or changes required.
3. **User** triggers `cfcf run` -- cf² assembles context and launches the agent.
4. The agent works within the existing codebase, guided by the user's problem definition and context.

The iteration process is identical in both cases. The difference is only in the initial context: the existing project has more context files describing what already exists. See `technical-design.md` section 2 for the rationale behind the local-process execution model.

---

## 3. File Artifacts: What cfcf Injects Into the Repo

### 3.1 CLAUDE.md (or Agent Equivalent)

The primary instruction file for the agent. cfcf generates this from the assembled context. It contains:

- **Role and identity**: What the agent is (a dev agent working on iteration N of a cfcf-managed project)
- **Process instructions**: Concise step-by-step process the agent must follow (read context → formulate plan → execute → produce handoff)
- **File pointers**: Explicit list of which files to read and in what order
- **Guardrails**: What the agent must NOT do (e.g., do not modify cfcf-docs/ files marked as read-only, do not delete test files)
- **Iteration-specific directive**: What this specific iteration should focus on (derived from the previous judge assessment and/or user feedback)
- **Handoff instructions**: How to fill in the iteration handoff document

For non-Claude agents, cfcf generates the equivalent instruction file for that agent's convention.

### 3.2 cfcf-docs/ Folder

This folder lives in the repo root and contains all cf²-managed context. All files are tracked in git. The folder is structured by who writes each file and when.

```
cfcf-docs/
  # --- User-provided context (user must edit before first iteration) ---
  # These are copied from the Problem Pack on project init.
  # The user MUST populate problem.md and success.md with real content.
  # cf² copies templates; the user replaces the template content.
  problem.md              # Problem/goal definition - USER MUST EDIT
  success.md              # Success criteria and test scenarios - USER MUST EDIT
  constraints.md          # Guardrails, limitations, boundaries (optional) - user edits if needed
  hints.md                # Technical hints, preferred approaches (optional) - user edits if needed
  style-guide.md          # Code style guidelines (optional) - user edits if needed
  context/                # Additional context files (optional) - user adds as needed
    *.md                  # Architecture docs, API specs, data models, etc.

  # --- Process definition (cf² provides, user may customize) ---
  process.md              # How the agent should operate (copied from cf² template)

  # --- Agent-writable files (dev agent updates these each iteration) ---
  plan.md                 # Evolving implementation plan (agent creates/updates)
  decision-log.md         # Decisions made, approaches tried, lessons learned
  iteration-handoff.md    # Current iteration's completion report (agent fills in, cf² resets template each iteration)
  cfcf-iteration-signals.json  # Machine-readable signals from dev agent to cf²
                               # cf² reads this after each iteration to detect:
                               # questions for user, test results, blockers, self-assessment.
                               # cf² resets the template before each iteration.

  # --- Judge output (judge agent writes, cf² manages lifecycle) ---
  judge-assessment.md     # The CURRENT/LATEST judge review (cf² overwrites before each judge run)
  cfcf-judge-signals.json # Machine-readable judge signals to cf²
                          # cf² reads this to make deterministic decisions:
                          # SUCCESS/PROGRESS/STALLED/ANOMALY determination,
                          # whether to continue, stop, or alert the user.
  cfcf-judge-instructions.md  # Instructions for the judge agent (cf² generates each iteration)
  iteration-reviews/      # ARCHIVED judge assessments (cf² copies here after each iteration)
    iteration-1.md        # cf² moves judge-assessment.md → iteration-1.md after iteration 1
    iteration-2.md        # cf² moves judge-assessment.md → iteration-2.md after iteration 2
    ...                   # This preserves the full history of judge feedback

  # --- cf²-managed context (cf² regenerates each iteration, agents read) ---
  iteration-history.md    # Aggressively compressed summaries of ALL previous iterations (Tier 2 context)
  user-feedback.md        # User's latest feedback/direction from a pause review (cf² writes when user provides input)

  # --- Detailed logs (Tier 3 reference, agent reads on demand) ---
  iteration-logs/         # Detailed per-iteration summaries
    iteration-1-summary.md
    iteration-2-summary.md
    ...
```

**Signal file lifecycle:**

1. **Before each iteration**: cf² resets `cfcf-iteration-signals.json` to the template (empty/default values).
2. **During iteration**: The dev agent populates the signal file with structured data (test results, questions, blockers, self-assessment).
3. **After dev agent exits**: cf² reads and parses the signal file. If `user_input_needed: true`, cf² alerts the user with the questions. If malformed or missing, cf² treats it as an anomaly.
4. **Judge phase**: cf² spawns the judge agent. The judge writes `cfcf-judge-signals.json` with its determination.
5. **After judge exits**: cf² reads the judge signal file to decide: continue, stop, alert user, etc.
6. **Archiving**: cf² copies `judge-assessment.md` → `iteration-reviews/iteration-N.md` before the next iteration begins, preserving the full review history.

### 3.3 File Categories and Permissions

| File | Written by | Read by | Updated when | Notes |
|------|-----------|---------|-------------|-------|
| CLAUDE.md | cf² | Dev agent | Every iteration (regenerated) | Agent instruction file |
| process.md | cf² (initial) | Dev agent | Rarely | User may customize |
| **problem.md** | **User** | Dev agent, Judge | **Before first iteration** | **User MUST populate** |
| **success.md** | **User** | Dev agent, Judge | **Before first iteration** | **User MUST populate** |
| constraints.md | User | Dev agent | Before first iteration (optional) | User creates if needed |
| hints.md | User | Dev agent | User updates between iterations | User creates if needed |
| style-guide.md | User | Dev agent | Before first iteration (optional) | User creates if needed |
| context/*.md | User | Dev agent | User adds as needed | Architecture, API specs, etc. |
| plan.md | Dev agent | Dev agent, Judge, User | Every iteration | Agent evolves it |
| decision-log.md | Dev agent | Dev agent, Judge | Every iteration | Agent appends |
| iteration-handoff.md | Dev agent | cf², Judge | Every iteration | cf² resets template each iteration |
| cfcf-iteration-signals.json | Dev agent | cf² | Every iteration | cf² resets template, agent fills in |
| judge-assessment.md | Judge agent | Dev agent, User | Every iteration | cf² archives to iteration-reviews/ |
| cfcf-judge-signals.json | Judge agent | cf² | Every iteration | cf² reads for flow control |
| cfcf-judge-instructions.md | cf² | Judge agent | Every iteration | cf² generates |
| iteration-history.md | cf² | Dev agent | Every iteration | Compressed summaries |
| user-feedback.md | cf² (from user) | Dev agent | At pause cadence | cf² writes when user provides input |
| iteration-reviews/*.md | cf² (archived) | Dev agent, User | After each iteration | History of all judge assessments |
| architect-review.md | Solution Architect | Dev agent, Judge, User | Pre-iteration (`cfcf review`) | Persists across iterations |
| cfcf-architect-signals.json | Solution Architect | cf² | Pre-iteration | Readiness gate |
| docs/architecture.md | Architect (initial) / Dev agent / Documenter | Dev agent, Judge, User | Every iteration + polished post-SUCCESS | System architecture, components, data flow |
| docs/api-reference.md | Architect (initial) / Dev agent / Documenter | Dev agent, Judge, User | Every iteration (if API exists) + polished post-SUCCESS | Endpoints, models, errors |
| docs/setup-guide.md | Architect (initial) / Dev agent / Documenter | Dev agent, Judge, User | Every iteration + polished post-SUCCESS | Prerequisites, install, run, config |
| docs/README.md | Documenter | User | Post-SUCCESS | Project overview, quick start |
| cfcf-documenter-instructions.md | cf² | Documenter | Before each documenter run | cf² generates (sequence-numbered) |

---

## 4. Pre-Iteration: Solution Architect Review

The **Solution Architect** is an advisory tool for the user -- not a gate that cf² enforces. The user invokes it when they want feedback on their Problem Pack, iterates on the feedback, and decides when to move on to development. The user can launch development at any time, with or without the architect's blessing.

### 4.0.1 Purpose

The Solution Architect reviews the problem definition, success criteria, constraints, and context files. It catches issues that would waste iteration cycles: vague requirements, missing success criteria, conflicting constraints, gaps in context. Think of it as a senior colleague reviewing your spec before you hand it to the team.

### 4.0.2 Process (User-Driven)

The user drives this process. It is iterative and optional:

1. **User invokes**: `cfcf review --project <name>`
2. cf² spawns the Solution Architect agent (configurable agent + model)
3. The architect reads all Problem Pack files and produces its assessment
4. **User reads**: `cfcf-docs/architect-review.md` -- human-readable feedback
5. **User decides**: refine the Problem Pack based on feedback, or move on
6. **User may repeat**: run `cfcf review` again after making changes, as many times as desired
7. **User launches development** whenever ready: `cfcf run --project <name>` -- no permission needed from the architect

### 4.0.3 Architect Outputs

**Human-readable assessment** (`cfcf-docs/architect-review.md`):
- Readiness assessment: is the problem definition clear and actionable?
- Identified gaps or ambiguities
- Suggested clarifications or missing context
- Recommended approach or architectural considerations
- Risk factors and potential blockers

**Machine-readable signals** (`cfcf-docs/cfcf-architect-signals.json`):
```json
{
  "readiness": "NEEDS_REFINEMENT",
  "gaps": ["Success criteria don't cover error cases"],
  "suggestions": ["Consider adding API rate limiting to constraints"],
  "risks": ["No database migration strategy specified"],
  "recommended_approach": "Start with Express + Zod for validation, add auth middleware"
}
```

Readiness values: `READY` | `NEEDS_REFINEMENT` | `BLOCKED`

The signal file is primarily useful for future web UI integration (showing readiness status in the dashboard). The user reads the Markdown review for actionable feedback.

### 4.0.4 Key Design Principles

- **Advisory, not blocking.** The architect provides advice. The user decides when to proceed. `cfcf run` works regardless of the architect's readiness assessment.
- **User-invoked, not cf²-invoked.** cf² never invokes the architect automatically. The user runs `cfcf review` when they want feedback.
- **Iterative.** The user can run the review multiple times as they refine the Problem Pack. Each run overwrites the previous assessment.
- **Persistent.** The `architect-review.md` persists in the repo and is available to dev agents and the judge as additional context in subsequent iterations.

---

## 5. The Iteration Process

### 5.1 Pre-Iteration (cfcf does this)

1. **Ensure git state**: Verify we're on the cfcf branch. If iteration 1, create the branch off current HEAD.
2. **Generate CLAUDE.md** (or agent equivalent): Assemble the agent instruction file from current context using the tiered context strategy (see section 9).
3. **Update cfcf-managed files**:
   - Regenerate `iteration-history.md` from stored iteration logs (aggressively compressed summaries with references to detailed logs).
   - Write latest `judge-assessment.md` from previous iteration's judge output.
   - Write latest `user-feedback.md` if user provided feedback at a pause.
   - Write `cfcf-iteration-signals.json` template (for the agent to populate).
   - Write `cfcf-judge-instructions.md` (judge process instructions, generated by cfcf).
4. **Spawn dev agent**: Launch the agent CLI in non-interactive mode (e.g., `claude --dangerously-skip-permissions -p "..."`).
5. **Begin log capture**: Stream and store all stdout/stderr to `~/.cfcf/.../agent-logs.txt`.

### 5.2 During Iteration (agent does this)

The agent follows the process defined in CLAUDE.md and process.md:

1. **Read context** (in order):
   - CLAUDE.md (process instructions and iteration directive)
   - cfcf-docs/problem.md (what needs to be built/fixed)
   - cfcf-docs/success.md (how success is measured)
   - cfcf-docs/plan.md (current plan from previous iterations, if any)
   - cfcf-docs/iteration-history.md (what happened in previous iterations)
   - cfcf-docs/judge-assessment.md (feedback from the judge)
   - cfcf-docs/user-feedback.md (feedback from the user)
   - cfcf-docs/decision-log.md (past decisions and lessons)
   - cfcf-docs/constraints.md, hints.md, style-guide.md (if present)
   - cfcf-docs/context/ (additional context as needed)

2. **Formulate iteration plan**: Based on all context, decide what this iteration will accomplish. Update `cfcf-docs/plan.md` with the iteration-specific plan and any changes to the overall plan.

3. **Execute**: Write code, run tests, debug, iterate internally. The agent works autonomously until it decides this iteration's work is complete.

4. **Run tests**: Ensure all test scenarios from success.md pass (or document which ones don't and why).

5. **Update decision log**: Append to `cfcf-docs/decision-log.md` with decisions made, approaches tried, what worked/didn't.

6. **Produce handoff document**: Fill in `cfcf-docs/iteration-handoff.md` (see structure below).

7. **Write signal file**: Populate `cfcf-docs/cfcf-iteration-signals.json` with structured data. This is the machine-readable complement to the human-readable handoff doc.

   ```json
   {
     "iteration": 3,
     "agent": "claude-code",
     "status": "completed",
     "user_input_needed": true,
     "questions": ["Should the API use REST or GraphQL?"],
     "tests_run": true,
     "tests_passed": 14,
     "tests_failed": 2,
     "tests_total": 16,
     "self_assessment": "medium",
     "blockers": ["missing API spec for the payment endpoint"]
   }
   ```

8. **Exit**: The agent process exits. The iteration is complete.

### 5.3 Post-Iteration (cfcf does this)

1. **Detect completion**: Agent process exited.
2. **Read artifacts**: Parse the handoff document, signal file, decision log updates, and plan updates from the repo.
3. **Commit dev work**: Commit all changes (including cfcf-docs/ updates) to the cfcf branch. This commit captures the dev agent's complete output.
4. **Store agent logs**: Copy agent stdout/stderr to `~/.cfcf/logs/` (too large for repo).
5. **Run judge agent**: Spawn the judge agent in the same repo directory (see section 5). The judge runs after the dev commit, so its file writes are in a separate commit.
6. **Commit judge work**: Commit the judge's assessment and signal files.
7. **Process judge signals**: Parse `cfcf-docs/cfcf-judge-signals.json` for deterministic decision-making.
8. **Decide next step**:
   - **Success**: Judge determination = SUCCESS → push to remote, stop iterating, report to user.
   - **Continue**: Judge determination = PROGRESS → prepare next iteration.
   - **Stalled**: Judge determination = STALLED → apply configured policy (continue/stop/alert user).
   - **Anomaly**: Judge determination = ANOMALY (token exhaustion, circling, regression) → alert user, wait for input.
   - **User input needed**: Dev or judge signals `user_input_needed = true` → alert user with questions, wait for responses.
   - **Max iterations**: Iteration count reached configured maximum → stop, report to user.
   - **User pause**: Pause cadence reached → alert user, wait for feedback.
9. **Archive judge assessment**: Move current `judge-assessment.md` to `iteration-reviews/iteration-N.md`. Store agent logs to `~/.cfcf/logs/`.

---

## 6. The Agent Judge

The judge is a **separate agent** (not an API call) that runs in the same repo directory after each iteration. It is encouraged to be a **different agent** than the dev agent (e.g., Codex judges Claude Code's work, or vice versa). This provides cross-agent review and avoids API costs -- it uses the user's existing agent subscriptions.

**Why agent-based, not API-based:**
- **No API cost**: Uses the user's existing CLI agent subscription (e.g., Claude Code Pro, Codex).
- **Full repo access**: The judge can inspect source code, run tests, look at build output -- not limited to what cfcf passes in a prompt.
- **Minimal cfcf plumbing**: cfcf spawns the judge agent with instructions and reads its output files.
- **Cross-agent review**: A different agent may catch issues the dev agent's blind spots miss.

**Configuration:** The user configures which agent and model to use for the judge role independently from the dev agent. Defaults TBD.

### 6.1 Judge Inputs

The judge runs in the same repo directory. It has access to everything the dev agent produced. cfcf writes judge-specific instructions to `cfcf-docs/cfcf-judge-instructions.md` which tells the judge:

- Where to find the handoff document (`cfcf-docs/iteration-handoff.md`)
- Where to find the problem and success definitions (`cfcf-docs/problem.md`, `cfcf-docs/success.md`)
- The current plan (`cfcf-docs/plan.md`)
- The decision log (`cfcf-docs/decision-log.md`)
- Where to find the git diff (the judge can run `git diff HEAD~1`)
- Previous judge assessments (`cfcf-docs/iteration-reviews/`)
- Where to write its output

### 6.2 Judge Output

The judge produces TWO outputs:

1. **Human-readable assessment**: `cfcf-docs/iteration-reviews/iteration-N.md` (for context in future iterations and for human review)
2. **Machine-readable signal file**: `cfcf-docs/cfcf-judge-signals.json` (for cfcf's deterministic decision-making)

#### Assessment document (Markdown):

The judge writes a structured document to `cfcf-docs/iteration-reviews/iteration-N.md`:

```markdown
# Iteration N Judge Assessment

## Success Determination
- [ ] SUCCESS: All success criteria from success.md are met
- [ ] PROGRESS: Meaningful progress toward success criteria
- [ ] STALLED: No meaningful progress or regression
- [ ] ANOMALY: Abnormal situation detected (see details)

## Test Results Analysis
- Tests passing: X/Y
- New tests passing since last iteration: ...
- Tests regressing since last iteration: ...
- Test coverage assessment: ...

## Quality Assessment
- Score: [1-10]
- Code quality observations: ...
- Architectural concerns: ...

## Anomaly Flags
- [ ] Agent appears to have run out of tokens
- [ ] Agent is requesting user input (open questions detected)
- [ ] Agent is circling the same approach repeatedly
- [ ] Agent made no meaningful code changes
- [ ] Agent deleted or broke previously working code

## Tactical Guidance for Next Iteration
- What the next iteration should focus on: ...
- What approaches to avoid: ...
- Specific suggestions: ...

## Summary
One-paragraph summary of iteration outcome for the iteration history log.
```

#### Signal file (JSON):

The judge also writes `cfcf-docs/cfcf-judge-signals.json`:

```json
{
  "iteration": 3,
  "determination": "PROGRESS",
  "anomaly_type": null,
  "quality_score": 7,
  "tests_verified": true,
  "tests_passed": 14,
  "tests_failed": 2,
  "tests_total": 16,
  "should_continue": true,
  "user_input_needed": false,
  "key_concern": "Error handling is incomplete but improving"
}
```

The signal file is the primary input for cfcf's decision logic. The Markdown assessment is for humans and for context in future iterations.

### 6.3 What cfcf Does With the Judge Output

The judge output feeds into **deterministic** cfcf decisions:

| Judge says | cfcf does |
|-----------|-----------|
| SUCCESS | Stop iterating. Report success to user. |
| PROGRESS | Continue to next iteration. |
| STALLED (for N consecutive iterations) | Alert user. Optionally stop. |
| ANOMALY: token exhaustion | Stop iterating. Alert user. No point in another iteration. |
| ANOMALY: user input needed | Pause. Alert user via all configured channels. Wait. |
| ANOMALY: circling | Include strong guidance in next iteration. After M circles, alert user. |

The judge informs but does not decide. cfcf maps judge output categories to deterministic actions.

### 6.4 Signal File Error Handling

If a signal file is missing or contains malformed JSON:
- cfcf treats this as an **anomaly** and alerts the user.
- cfcf does NOT attempt to infer signals from the Markdown documents -- it reports the error and asks the user to review the handoff/assessment Markdown directly.
- The user may want to make the signal file format more prominent in the agent instructions if this occurs repeatedly.
- Future enhancement: allow the user to manually provide a corrected signal file for the historical record.

---

## 7. Iteration Handoff Document Template

This is the template that cfcf places at `cfcf-docs/iteration-handoff.md` for the agent to fill in.

```markdown
# Iteration Handoff: Iteration #[N]

## Summary
<!-- What was accomplished in this iteration? 2-3 sentences. -->

## Changes Made
<!-- List of files created, modified, or deleted. Brief description of each change. -->

## Test Results
<!-- Which tests pass? Which fail? Any new tests created? -->

## Plan Status
<!-- What items from plan.md were completed? What remains? -->

## Open Questions for User
<!-- Questions that require human judgment or clarification.
     If this section has content, cfcf will alert the user. -->

## Hints for Next Iteration
<!-- What should the next iteration focus on? What to avoid?
     Technical suggestions, known pitfalls, etc. -->

## Blockers or Concerns
<!-- Anything that might prevent progress.
     E.g., "ran out of context", "test infrastructure missing",
     "conflicting requirements in problem.md" -->

## Self-Assessment
<!-- Honest evaluation: is the project converging toward success?
     Rate confidence: HIGH / MEDIUM / LOW -->
```

---

## 8. Where Files Live

### 8.1 In the Repo (primary -- tracked in git)

All structured cfcf files live in the repo under `cfcf-docs/`. This is the source of truth. Everything is version-controlled.

```
<project-root>/
  cfcf-docs/
    # Static context (user-provided, cfcf copies from Problem Pack on init)
    process.md                     # Process definition template (copied from cfcf core)
    problem.md                     # Problem/goal definition
    success.md                     # Success criteria
    constraints.md                 # Guardrails (optional)
    hints.md                       # Technical hints (optional)
    style-guide.md                 # Code style (optional)
    context/                       # Additional context files

    # Evolving artifacts (agent-writable)
    plan.md                        # Evolving implementation plan
    decision-log.md                # Decisions, approaches, lessons
    iteration-handoff.md           # Current iteration handoff (overwritten each iteration)
    cfcf-iteration-signals.json    # Current iteration signals (overwritten each iteration)

    # Judge output
    judge-assessment.md            # Latest judge assessment (overwritten each iteration)
    cfcf-judge-signals.json        # Latest judge signals (overwritten each iteration)
    cfcf-judge-instructions.md     # Judge instructions (cfcf regenerates each iteration)
    iteration-reviews/             # Archived judge assessments (cfcf moves here after each iteration)
      iteration-1.md
      iteration-2.md
      ...

    # Solution Architect output (pre-iteration review)
    architect-review.md            # Solution Architect's assessment (persists across iterations)
    cfcf-architect-signals.json    # Machine-readable readiness signals

    # cfcf-managed context (regenerated by cfcf each iteration)
    iteration-history.md           # Compressed summaries of all previous iterations
    user-feedback.md               # User's latest feedback/direction
    iteration-logs/                # Detailed per-iteration summaries
      iteration-1-summary.md
      iteration-2-summary.md
      ...

  CLAUDE.md                        # Agent instruction file (regenerated each iteration by cfcf)
```

### 8.2 Outside the Repo (backup only)

cfcf keeps agent logs (stdout/stderr) under `~/.cfcf/` since these are very large and would bloat the repo. This is a backup, not the source of truth.

```
~/.cfcf/
  logs/
    <project-id>/
      iteration-001-dev.log      # Full dev agent stdout/stderr
      iteration-001-judge.log    # Full judge agent stdout/stderr
      iteration-002-dev.log
      ...
      architect-001.log          # Nth architect review run
      architect-002.log
      documenter-001.log         # Nth documenter run
      documenter-002.log
```

### 8.3 No External Persistent Memory (for now)

A richer external memory layer (cross-project knowledge, semantic search, Cerefox integration) is a future extension. The need for it will appear organically as cfcf evolves. For now, keeping everything in the repo is simpler and more transparent.

---

## 9. Process Definition: What Goes Into process.md

The `cfcf-docs/process.md` file is a concise, agent-readable description of the iteration process. cfcf ships with a default process template (under `process-templates/default/` in the cfcf source). On `cfcf init`, the template is **copied into the repo** so it becomes part of the project's version history. The user or agents can modify it over time -- changes are tracked in git like any other file.

The process.md file's purpose is to ensure the agent understands its role and the expected workflow regardless of which agent is used.

### 9.1 Template Vision

The long-term vision for process templates:

- **cfcf ships multiple template flavors**: e.g., test-driven development, greenfield exploration, refactoring-focused, documentation-focused. Each template defines a different process emphasis and agent instruction style.
- **Users select a template** during `cfcf init` (or change it for the next iteration at any time via config). Which template is active is recorded in the project config.
- **Community templates**: Users or the community can create and publish custom templates. A user adds a template to their cfcf deployment and selects it per-project.
- **Templates are living documents**: Once copied into the repo, the template evolves with the project. The user or agents may modify it and changes are tracked in git. The original template name/version is recorded for reference.
- **Per-project customization**: Different projects in the same cfcf installation can use different templates simultaneously.

For v0.1, cfcf ships a single default template. The template selection and community publishing infrastructure is a future enhancement.

Key contents:

1. **Your role**: You are a dev agent working on iteration N of a cfcf-managed project.
2. **The iteration model**: Each iteration is a single uninterrupted execution. You read context, plan, execute, and produce artifacts. You do not interact with the user during the iteration.
3. **Files you must read** (with order guidance).
4. **Files you must update**: plan.md, decision-log.md, iteration-handoff.md.
5. **Files you must not modify**: process.md, problem.md, success.md, constraints.md, iteration-history.md, judge-assessment.md, user-feedback.md.
6. **Success criteria**: Defined in success.md. Your goal is to make all criteria pass.
7. **How to signal issues**: Write human-readable questions in the handoff doc under "Open Questions for User". Also set `user_input_needed: true` and populate the `questions` array in `cfcf-iteration-signals.json`. Write blockers under "Blockers or Concerns" in the handoff doc and in the `blockers` array in the signal file.
8. **Commit discipline**: Commit frequently with meaningful messages. Do not squash.
9. **Test discipline**: Run tests before completing the iteration. Document results in the handoff.
10. **What happens after you finish**: cfcf will commit your work, run a judge assessment, and either proceed to the next iteration or pause for user review.

---

## 10. What Is Code-Based vs. Judge-Based in the Loop

A key design question: which parts of the post-iteration analysis are done by cfcf (deterministic code) and which require the agent judge?

### Code-based (cfcf deterministic logic)

- Agent process lifecycle (spawn, monitor, capture exit)
- Log capture and storage
- Git operations (branch, commit, diff extraction, push)
- Iteration counting and max-iteration enforcement
- Pause cadence enforcement
- Handoff document parsing (structural: are the sections filled in?)
- Mapping judge output categories to actions (the decision table above)
- Context assembly for the next iteration
- User notification dispatch

### Judge-based (requires LLM)

- **Success determination**: Are the success criteria actually met? (Tests passing is necessary but not sufficient -- the judge assesses qualitative criteria too)
- **Progress assessment**: Is the project making meaningful progress or stalling?
- **Anomaly detection**: Did the agent run out of tokens? Is it circling? Are there blocking questions?
- **Quality assessment**: Is the code well-structured? Are there architectural concerns?
- **Tactical guidance**: What should the next iteration focus on?
- **Handoff document interpretation**: Understanding the agent's self-assessment and open questions

### The boundary

cfcf can detect simple signals mechanically (e.g., "tests passed", "handoff document exists", "no code changes detected"). But interpreting whether the project is converging, whether the approach is sound, and what to try next requires the judge. The judge's signal file format (section 5.2) is designed to make its assessments parseable by cfcf's deterministic logic.

---

## 11. Tiered Context Strategy

Each iteration requires the agent to re-read context from scratch (fresh process, no session continuity). To avoid spending a large fraction of the token window on bootstrapping, context is organized into tiers.

### Tier 1 -- MUST READ (embedded directly in CLAUDE.md, ~500 words)

This is inlined in the agent instruction file so the agent reads it immediately:

- Compressed problem summary (1-2 sentences from problem.md)
- Current plan status (last few items from plan.md)
- Last judge assessment (compressed to key points)
- Iteration-specific directive ("this iteration, focus on X")
- Pointer to signal file template and instructions to fill it in

### Tier 2 -- SHOULD READ (separate files, ~2000 words total)

CLAUDE.md instructs the agent to read these before starting work:

- `cfcf-docs/iteration-history.md` -- Aggressively compressed. Not "here's what happened in each iteration" but "current state: X works, Y doesn't, last approach was Z, judge said W." Includes references to detailed logs the agent may consult if needed.
- `cfcf-docs/decision-log.md` -- Summarized older entries, recent entries in full. Key decisions and lessons learned.
- `cfcf-docs/user-feedback.md` -- User's latest direction, if any.

### Tier 3 -- REFERENCE ONLY (full files, agent reads on demand)

CLAUDE.md lists these as "consult if needed":

- `cfcf-docs/problem.md` -- Full problem definition
- `cfcf-docs/success.md` -- Full success criteria
- `cfcf-docs/constraints.md`, `hints.md`, `style-guide.md`
- `cfcf-docs/context/` -- Architecture docs, API specs, etc.
- `cfcf-docs/iteration-logs/` -- Detailed per-iteration summaries and log references

### Token budget tracking

cfcf should track (best-effort) how much of the agent's token window is consumed by context reading vs. productive coding. This is measured in Iteration 2 of the cfcf development plan and optimized iteratively. Approaches:

- Parse token usage from agent CLI output (agent-specific, fragile but free)
- Estimate from file sizes (approximate)
- Track context file total size as a proxy metric over iterations

---

*This document will be refined as we build and test the iteration process with real agents.*
