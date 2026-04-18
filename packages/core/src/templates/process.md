# cfcf Process Definition

You are a dev agent working on a cfcf-managed project. This document defines how you operate within each iteration.

## Iteration Model

Each iteration is a single, uninterrupted execution. You read context, formulate a plan, execute, and produce artifacts. You do not interact with the user during the iteration.

## Iteration Scope -- one phase per iteration

cfcf is designed for **incremental progress across many short iterations**, not one giant end-to-end run. Treat each iteration as one checkpointed chunk of work:

1. **Read `cfcf-docs/plan.md` first.** The plan is the shared source of truth between iterations. It is how the next iteration knows where you left off.
2. **If the plan is not yet mapped to iterations** (e.g. first real iteration, or the architect produced a phase-based outline), your first job is to map phases to iterations. Each iteration should be a concrete, testable chunk -- typically one phase or a small group of tightly related tasks. Err on the side of smaller iterations.
3. **Execute only the next pending iteration.** Do not try to complete every phase in one run. Do not skip ahead. Do the single next chunk well.
4. **Before you exit, update `cfcf-docs/plan.md`:**
   - Mark completed items with `[x]` and add a brief note of what was actually done (files touched, tests added, deviations from the plan).
   - Leave everything else pending so the next iteration picks up from there.
   - If you discovered new work, add it as new pending items in the appropriate phase.
5. **If the plan is missing** (no architect ran, no prior iterations), create it yourself from `problem.md` / `success.md` before you start coding, then follow the same rule: do one chunk, update plan, exit.

This is what makes the judge's per-iteration assessment meaningful and makes the loop resumable after a pause.

## What to Read (in order)

1. **CLAUDE.md** (or your agent's equivalent) -- iteration-specific instructions and Tier 1 context
2. **cfcf-docs/problem.md** -- what needs to be built or fixed
3. **cfcf-docs/success.md** -- how success is measured
4. **cfcf-docs/plan.md** -- current plan from previous iterations (if any)
5. **cfcf-docs/iteration-history.md** -- compressed summaries of previous iterations
6. **cfcf-docs/judge-assessment.md** -- feedback from the judge on the last iteration
7. **cfcf-docs/user-feedback.md** -- feedback from the user (if any)
8. **cfcf-docs/decision-log.md** -- past decisions and lessons
9. **cfcf-docs/constraints.md**, **hints.md**, **style-guide.md** -- if present
10. **cfcf-docs/context/** -- additional context files as needed

## What to Produce

### Files you MUST update every iteration:

- **cfcf-docs/plan.md** -- Update with your iteration plan and progress
- **cfcf-docs/decision-log.md** -- Append decisions made, approaches tried, lessons learned
- **cfcf-docs/iteration-handoff.md** -- Fill in the handoff template (see below)
- **cfcf-docs/cfcf-iteration-signals.json** -- Fill in the structured signal file

### Project documentation you MUST maintain:

The following docs live in the project's `docs/` directory. If they exist (created by the Solution Architect or a previous iteration), update them to reflect your changes. If they don't exist, create them.

- **docs/architecture.md** -- System architecture: components, data flow, tech stack, directory structure. Update when you add new components, change the architecture, or make significant structural decisions.
- **docs/api-reference.md** -- API endpoints, request/response formats, data models, error handling. Update when you add or modify API endpoints. Skip if the project has no API.
- **docs/setup-guide.md** -- Prerequisites, installation steps, how to run/test/build. Update when you add dependencies, change build steps, or modify configuration.

### Files you must NOT modify:

- cfcf-docs/process.md (this file)
- cfcf-docs/problem.md
- cfcf-docs/success.md
- cfcf-docs/constraints.md
- cfcf-docs/iteration-history.md
- cfcf-docs/judge-assessment.md
- cfcf-docs/user-feedback.md

## Success Criteria

Defined in cfcf-docs/success.md. Your goal is to make all criteria pass.

## How to Signal Issues

- Write human-readable questions in the handoff doc under "Open Questions for User"
- Set `user_input_needed: true` and populate the `questions` array in `cfcf-iteration-signals.json`
- Write blockers under "Blockers or Concerns" in the handoff doc and in the `blockers` array in the signal file

## Commit Discipline

Commit frequently with meaningful messages. Do not squash.

## Test Discipline

Run tests before completing the iteration. Document results in the handoff.

## What Happens After You Finish

cfcf will commit your work, run a judge assessment, and either proceed to the next iteration or pause for user review.
