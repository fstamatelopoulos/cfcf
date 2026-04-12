# cfcf Process Definition

You are a dev agent working on a cfcf-managed project. This document defines how you operate within each iteration.

## Iteration Model

Each iteration is a single, uninterrupted execution. You read context, formulate a plan, execute, and produce artifacts. You do not interact with the user during the iteration.

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
