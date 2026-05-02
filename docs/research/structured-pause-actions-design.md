# Structured Pause Actions — Design

**Status:** design, implementation-ready. Drives `feat/structured-pause-actions`.
**Date:** 2026-05-01.
**Cross-refs:** `iteration-loop.ts` (`makeDecision`, `resumeLoop`), `web/src/components/FeedbackForm.tsx`, [`docs/research/reflection-role-and-iterative-planning.md`](reflection-role-and-iterative-planning.md).

---

## Problem

When the harness pauses for user arbitration, today's contract is:

- **One input channel**: a single textarea ("Provide feedback or direction for the next iteration").
- **One output behavior**: resume the loop, inject the text into the next dev agent's prompt as context.

This silently misroutes any user intent that isn't "continue with another iteration." Surfaced 2026-05-01 in the tracker workspace: user typed *"Judge and Reflection agree, proceed to the Documentation phase and close the loop"* — harness fired the dev agent for iter-6 instead.

The harness needs a **structured action** signal from the user to drive its decision; the **free text** stays as context for whichever agent runs next (or as a history note when no agent runs).

---

## Pause cases (the universe)

Every place the harness can pause and ask for user input. From `iteration-loop.ts`:

| # | Trigger | `pauseReason` | Question source |
|---|---|---|---|
| **A1** | Pre-loop architect review didn't satisfy `readinessGate` | `anomaly` | top-5 `gaps` from architect signals |
| **A2** | Dev agent set `user_input_needed: true` with `questions[]` | `user_input_needed` | `devSignals.questions` |
| **A3** | Judge set `user_input_needed: true` | `user_input_needed` | `judgeSignals.key_concern` |
| **A4** | Judge `determination: ANOMALY` | `anomaly` | `judgeSignals.key_concern` |
| **A5** | Judge `determination: STALLED` + `onStalled=alert` policy | `anomaly` | (none — just reason text) |
| **A6** | Reflection `recommend_stop: true` (post-fix: only when judge ≠ SUCCESS, OR `iteration_health` ≠ converging/stable) | `anomaly` | `reflectionSignals.key_observation` |
| **A7** | Pause cadence reached (`pauseEvery > 0`) | `cadence` | (none — routine check-in) |
| **A8** | Judge signal file missing/malformed | `anomaly` | "Judge did not produce signals" |
| **A9** | Judge `determination` is an unknown enum value | `anomaly` | (none — defensive fallback) |

Stop cases (no user input today, no change here):
- **B1** Max iterations reached → `action: stop` + notification
- **B2** Judge `SUCCESS` → `action: stop` (proceeds to documenter if `autoDocumenter`)

---

## Structured `ResumeAction` enum

5 actions cover every case. Free text remains optional alongside the action.

```typescript
type ResumeAction =
  | "continue"            // resume; text → next dev agent prompt
  | "finish_loop"         // run remaining configured phases (documenter if autoDocumenter=true);
                          //   text → documenter prompt
  | "stop_loop_now"       // immediate termination, NO further phases regardless of config;
                          //   text → history note
  | "refine_plan"         // architect runs first w/ text (sync), then dev iteration continues
  | "consult_reflection"; // reflection runs w/ text, harness re-decides on its signals
```

**Naming rationale (decided 2026-05-01):** `finish_loop` vs `stop_loop_now` is clearer than `stop_and_document` vs `stop` — the former pair frames the choice as "honour the configured loop end-state" vs "explicit immediate termination." `finish_loop` respects `autoDocumenter=false` (just stops); `stop_loop_now` always skips the documenter even if `autoDocumenter=true`. Both must be documented in `docs/guides/manual.md`.

**The escape hatch — `consult_reflection`.** Covers the long-tail case where the user has nuanced feedback that doesn't map cleanly to one of the four explicit actions. Reflection reads the user's text + current loop state, outputs structured signals (`recommend_stop`, `iteration_health`, `plan_modified`, plus a new `harness_action_recommendation`), and the harness re-runs `makeDecision` with the fresh reflection output. Effectively turns reflection into the user's interpreter for free-text intent.

---

## Action × case applicability matrix

✓ = makes sense; ◐ = sensible in some sub-cases; ✗ = doesn't apply (button hidden in UI).

| Case | continue | finish_loop | stop_loop_now | refine_plan | consult_reflection |
|---|---|---|---|---|---|
| **A1** Pre-loop review blocked | ✓ (after edits) | ✗ | ✓ | ✓ (re-review) | ✗ (no iters yet) |
| **A2** Dev needs input | ✓ | ✗ (mid-iter) | ✓ | ✗ | ✗ (judge hasn't run) |
| **A3** Judge needs input | ✓ | ✓ | ✓ | ✓ | ✓ |
| **A4** Judge ANOMALY | ✓ | ✗ | ✓ | ✓ | ✓ |
| **A5** Judge STALLED + alert | ✓ | ✗ | ✓ | ✓ | ✓ |
| **A6** Reflection stuck | ✓ | ◐ | ✓ | ✓ | ✓ (re-spawns reflection w/ user feedback) |
| **A7** Cadence | ✓ | ✓ | ✓ | ✓ | ✓ |
| **A8** Judge signals missing | ✗ (broken) | ✗ | ✓ | ✓ (re-run) | ✗ (no judge data) |
| **A9** Unknown judge | ✗ | ✗ | ✓ | ✓ | ✗ |

The applicability set per case is computed at pause time and surfaced as the visible buttons in the UI. Keeps options honest — user only sees actions that meaningfully advance the loop. **At least one applicable action must be picked to resume — there is no "Resume" button independent of an action choice.** The textarea remains optional (free-text context for whichever destination the action routes to).

---

## Free text routing per action

Free text is **always optional**. Where it goes depends on the action:

| Action | Text destination | Effect |
|---|---|---|
| `continue` | `state.userFeedback` → next iteration's dev prompt context (existing) | Dev agent reads it as guidance for the next iteration |
| `finish_loop` | Documenter prompt context (only when `autoDocumenter=true`) | Documenter reads it as user's framing of what to emphasise in final docs. If `autoDocumenter=false`, text is captured to history as audit (see below). |
| `stop_loop_now` | History note — appended to **both** `history.json` (structured `loop-stopped` event) **and** `iteration-history.md` (human-readable narrative). | Audit trail: "user stopped at iter N: {text}" |
| `refine_plan` | Architect prompt context | Architect reads it as user's direction for plan refinement; runs in re-review mode |
| `consult_reflection` | Reflection prompt context | Reflection reads it as user's interpretation request; outputs new signals (incl. `harness_action_recommendation`) |

When no agent runs after the action (`stop` only), the text is preserved verbatim in workspace history. Nothing is lost.

---

## Required signal updates

Only **`ReflectionSignals`** needs a new field; other agent signals stay as-is.

```typescript
export interface ReflectionSignals {
  iteration: number;
  plan_modified: boolean;
  iteration_health: IterationHealth;
  key_observation: string;
  recommend_stop?: boolean;

  /**
   * NEW (consult_reflection mode).
   * When the harness invoked reflection in response to a `consult_reflection`
   * resume action, reflection includes a structured recommendation for what
   * the harness should do next. Ignored when reflection runs as part of the
   * normal iteration cadence.
   *
   * - "continue"            → next dev iteration with reflection's plan tweaks
   * - "stop_and_document"   → loop is done; jump to documenter
   * - "stop"                → loop is unrecoverable; terminate
   * - "pause_for_user"      → reflection couldn't decide; bounce back to user
   *                           with a new key_observation explaining what's
   *                           ambiguous (the user's text + current state
   *                           weren't enough)
   */
  harness_action_recommendation?:
    | "continue"
    | "stop_and_document"
    | "stop"
    | "pause_for_user";
}
```

**Reflection prompt extension**: when invoked via `consult_reflection`, the system prompt gains a section describing the user's text + the pause context that triggered the consultation, and asks reflection to set `harness_action_recommendation`. Outside consult mode, the field is omitted (or always undefined) and the harness ignores it.

---

## State + API extensions

```typescript
// LoopState
interface LoopState {
  // ... existing
  resumeAction?: ResumeAction;   // user's chosen action on this resume
}

// resumeLoop signature
export async function resumeLoop(
  workspaceId: string,
  feedback?: string,
  action: ResumeAction = "continue",   // default = back-compat
): Promise<LoopState>;

// HTTP API
POST /api/workspaces/:id/resume
body: { feedback?: string, action?: ResumeAction }   // default action = "continue"

// CLI
cfcf resume [--feedback <text>] [--action <continue|stop_and_document|stop|refine_plan|consult_reflection>]
```

Default `action: "continue"` everywhere preserves back-compat: any caller that doesn't know about the new actions gets the old behavior.

---

## Decision flow on resume

`runLoop` branches on `state.resumeAction` after `resumeLoop` clears the pause:

```
resumeLoop(action, feedback?)
  ↓
runLoop reads state.resumeAction
  ↓
switch (action):
  case "continue":            → existing path (next iter dev agent)
  case "stop_and_document":   → skip iter spawn; jump to documenter phase
                                (respects autoDocumenter=false → just stops)
  case "stop":                → terminate; append history note; no documenter
  case "refine_plan":         → spawn architect (re-review mode) with feedback
                                → on architect exit, continue normally to next iter
  case "consult_reflection":  → spawn reflection with feedback as input
                                → re-run makeDecision with the new reflectionSignals
                                → if reflection returned harness_action_recommendation,
                                  follow it; otherwise default to its
                                  recommend_stop / key_observation surface
```

After consumption, `state.resumeAction = undefined` (mirrors the existing `userFeedback` clear at line 1325).

---

## UI surface

`FeedbackForm.tsx` becomes contextual:

```
┌─────────────────────────────────────────────────────────────┐
│ Loop paused: <pauseReasonTitle>                             │
│                                                             │
│ Questions needing your input:                               │
│   • <question 1>                                            │
│   • <question 2>                                            │
│                                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Optional context for the next agent (or audit note)... │ │
│ │                                                         │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ Choose an action (required to resume):                      │
│  [ Continue ]  [ Finish loop ]  [ Stop loop now ]           │
│  [ Refine plan ]  [ Ask Reflection to decide ]              │
│                                                             │
│ ↑ buttons shown only when applicable for this pause case.   │
└─────────────────────────────────────────────────────────────┘
```

Buttons hidden per the matrix above. For cadence pauses (A7), all 5 are shown — the routine check-in is where the user is most likely to want to wrap up. For broken states (A8/A9), only `Stop loop now` and `Refine plan` are shown. **No "Resume" without an action choice** — the user must explicitly click one of the displayed buttons.

A small `pauseReasonAllowedActions(pauseReason, signals)` helper computes the visible set; same logic powers CLI `cfcf resume --action` validation (rejects actions that don't apply to the current pause).

---

## Implementation checklist

1. **Types** (`packages/core/src/types.ts`):
   - Add `ResumeAction` type
   - Add `harness_action_recommendation` to `ReflectionSignals`
2. **State + resume** (`iteration-loop.ts`):
   - Add `resumeAction` to `LoopState`
   - Update `resumeLoop` signature + clear-on-consume
   - Branch in `runLoop` on resume action (5 cases)
3. **Helper** (`iteration-loop.ts`): `pauseReasonAllowedActions(pauseReason, signals): ResumeAction[]`
4. **Reflection runner** (`reflection-runner.ts`):
   - New `runConsultMode(workspace, userFeedback, pauseContext)` entry point
   - Prompt template extension for consult mode
   - Parse `harness_action_recommendation` from output signals
5. **Documenter runner** + **Architect runner**: accept optional `userFeedback` parameter (passed into prompt context)
6. **History** (`workspace-history.ts`): new event type `loop-stopped` capturing `userFeedback` when action=`stop`
7. **API** (`server/src/app.ts`): extend `POST /api/workspaces/:id/resume` body schema
8. **CLI** (`cli/src/commands/resume.ts`): add `--action` flag with validation
9. **Web UI** (`web/src/components/FeedbackForm.tsx`): rewrite as contextual button matrix; new prop `allowedActions: ResumeAction[]`
10. **Web API client** (`web/src/api.ts`): pass action through to `POST /resume`
11. **Tests**:
    - Per-action behavior in `runLoop` (5 unit tests)
    - `pauseReasonAllowedActions` matrix (9 cases × 5 actions = matrix test)
    - Reflection consult mode roundtrip (signal parsing)
    - API + CLI argument validation

Estimated total: **~2 days** of focused work; ~15-20 unit tests added; no breaking changes to public APIs (default `action: "continue"` preserves existing behavior).

---

## Decisions (locked 2026-05-01)

1. **`refine_plan` flow**: synchronous architect spawn → automatic continue to the next dev iteration. No mid-flow re-pause. Architect's existing plan-validation guardrails (`plan-validation.ts`) catch destructive rewrites.

2. **Action rename for `stop_and_document` ↔ `stop`**: `finish_loop` (respects `autoDocumenter` config) vs `stop_loop_now` (immediate termination, no further phases). Clearer semantics; both must be documented in `docs/guides/manual.md` as part of this work item.

3. **`consult_reflection` after A6 (reflection just ran)**: **allowed**. Reflection re-spawns with the user's new feedback as fresh input. Provides full flexibility — user can push back on the reflection's previous output with additional context. Adds a "consult was re-invoked with user feedback" entry to the workspace history for traceability.

4. **`stop_loop_now` history note**: written to **both** `history.json` (structured `loop-stopped` event with `userFeedback` field) **and** `iteration-history.md` (human-readable narrative paragraph). Two surfaces; one truth.

5. **No bare "Resume" button**: at least one of the 5 applicable actions **must** be selected to resume. The textarea is optional context; the action button is required. Forces clarity of user intent — no silent "Resume" defaulting to `continue`. Applies uniformly across all pause cases including A7 cadence.

---

## Out of scope for v1

- **Conditional actions based on free-text content** (the original Layer 2 LLM interpreter for pure free-text). `consult_reflection` covers the same need with cleaner semantics + fewer moving parts (reuses existing reflection agent + signal vocabulary).
- **User-defined custom actions** (e.g., "run my custom hook"). Ship the 5 above; revisit if dogfooding shows missing patterns.
- **Multi-step actions** (e.g., "refine plan AND stop and document"). Compose by re-pausing — user picks one action at a time.

---

## Acceptance

- All 9 pause cases (A1–A9) surface in the UI with a contextual button set per the matrix
- `cfcf resume --action <enum>` works from CLI with validation
- `consult_reflection` round-trip: reflection reads user feedback, sets `harness_action_recommendation`, harness honours it
- Free text reaches the right agent (or history) per the routing table — no more silent misroutes
- Existing default behavior (resume with text) preserved when no `action` is specified
- 15+ new unit tests covering the matrix + per-action behavior + reflection consult mode
