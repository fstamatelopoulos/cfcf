# Reflection role and iterative planning — design doc

**Status:** Draft for discussion — target implementation is iteration-6 clean session.
**Depends on:** current cfcf v0.4 (shipped) + iter-5 distribution items (landing).
**Supersedes / absorbs:** plan item 5.6 (Tier 3 Strategic Reflection), portions of 5.7 (cross-project knowledge — only the per-project learnings substrate).
**Related vision doc:** `[CF-CF] Requirements & Vision v0.2` (Cerefox project, id `34646577-117a-412b-8beb-b8be54ee64d1`) — the "three-tier evaluation model" this doc refines.

---

## 1. Why this matters

Today cfcf has a dev→judge→decide loop. The judge assesses the latest iteration and tells the harness whether to continue, pause, or stop. The **plan** (`cfcf-docs/plan.md`) is maintained by the dev agent — which means the plan is being revised by the same role that just finished executing against it, with only one iteration's worth of context.

This creates two problems that we've seen in practice:

1. **The plan is revised by whoever is closest to the current work.** The dev agent is optimizing for the next piece of code; it doesn't have the context to recognize that the **strategy** needs to change (e.g., three iterations in a row touching the same module = wrong decomposition).
2. **No role is responsible for noticing the loop is stalling.** The judge looks at one iteration at a time. The dev agent doesn't look across iterations. If the whole loop is running into a dead end, nobody is watching.

The Reflection role is the agent that owns both of these concerns:

- **Reads the full run history**, not just the current iteration.
- **Rewrites the remaining part of the plan** if the evidence warrants it.
- **Reports iteration health** (converging / stable / stalled / diverging) so future features can react.

This doc captures the flow, role contract, file layout, signal schemas, and implementation ordering.

---

## 2. Flow overview

### 2.1 New per-iteration sequence

```
┌──────────────────────────────────────────────────────────┐
│  ITERATION N                                             │
│                                                          │
│  1. PREPARE   cfcf assembles context (incl. latest       │
│               plan, judge assessment, reflection         │
│               output, decision-log tail)                 │
│                                                          │
│  2. DEV       Dev agent reads context, executes the      │
│               NEXT PENDING CHUNK from plan.md, marks     │
│               completed items [x] with brief note.       │
│                                                          │
│  3. JUDGE     Judge assesses THIS iteration only. Sets   │
│               signals incl. new `reflection_needed`.     │
│                                                          │
│  4. REFLECT?  cfcf decides:                              │
│                                                          │
│     IF judge.reflection_needed === true                  │
│        OR judge.reflection_needed is missing             │
│        OR (iterations-since-last-reflection              │
│            >= reflectSafeguardAfter)                     │
│     THEN: run reflection.                                │
│     ELSE: skip reflection (judge vouched for the plan).  │
│                                                          │
│  5. REFLECT   Reflection agent reads FULL history (plan, │
│     (cond.)   decision-log, iteration-history, all       │
│               prior judge assessments + reflection       │
│               analyses, problem pack). May rewrite the   │
│               pending part of plan.md. Writes a new      │
│               reflection-analysis.md and signals file.   │
│                                                          │
│  6. DECIDE    Harness uses judge + reflection signals to │
│               continue / pause / stop the loop.          │
└──────────────────────────────────────────────────────────┘
```

### 2.2 The reflection-frequency model

**Default: reflection runs every iteration.** This is the "always think before moving on" posture.

**Opt-out by the judge.** When the judge is confident the plan is on track and the iteration produced clean progress, it sets `reflection_needed: false`. The harness skips reflection for that iteration — a cost/latency optimization.

**Safeguard against judge complacency.** The config field `reflectSafeguardAfter: number` (default `3`) is a ceiling on the number of consecutive iterations the judge can skip reflection. If the judge opts out three times in a row, the fourth iteration runs reflection regardless. This catches the failure mode where the judge is being consistently optimistic while the strategy is silently drifting.

This is a flip from the v0.2 vision doc (which defaulted to reflection every 5 iterations). The rationale for the flip: reflection is cheap relative to dev work, and catching a wrong strategic direction 4 iterations later wastes 4 iterations. We'd rather pay for reflection on every iteration that the judge doesn't explicitly vouch for.

### 2.3 The judge's two new duties

1. **Produce a `reflection_needed` signal** (`true` / `false` / omit). Setting `false` is an affirmative claim that the plan is correct and the strategy is healthy. Omitting the field or setting `true` runs reflection.

2. **Produce a `reflection_reason` string** when `reflection_needed: true`. The reflection agent reads this as a prompt for where to focus (e.g., "the token refresh approach failed three ways; consider whether the whole auth layer decomposition is wrong").

### 2.4 The dev agent's unchanged duties

- Still reads `plan.md` as the source of truth.
- Still marks completed items `[x]` with a brief note.
- **New:** also reads `reflection-analysis.md` (latest) so it sees any strategic changes made to the pending plan.
- **New (optional):** may append a lesson to `decision-log.md` with the new timestamped + tagged format (see §5).

---

## 3. Reflection role contract

### 3.1 When it runs

Inside the iteration loop, immediately after the judge finishes and before the `DECIDE` step. Not outside the loop; not on user command (for now — `cfcf reflect` CLI is a follow-up if we find we want ad-hoc reflections).

### 3.2 What it reads

- `cfcf-docs/problem.md`, `success.md`, `constraints.md`, `hints.md` — the original problem pack
- `cfcf-docs/plan.md` — current plan with progress
- `cfcf-docs/judge-assessment.md` — latest judge output (this iteration)
- `cfcf-docs/iteration-reviews/iteration-*.md` — all archived prior judge assessments
- `cfcf-docs/iteration-history.md` — compressed summaries
- `cfcf-docs/decision-log.md` — full append-only journal from all roles
- `cfcf-docs/reflection-reviews/reflection-*.md` — all prior reflection analyses (if any)
- Current git log of `cfcf/iteration-*` branches — reflection can inspect actual code evolution

### 3.3 What it writes

Three outputs per run, all under `cfcf-docs/`:

1. **`reflection-analysis.md`** — human-readable analysis (latest). Archived to `reflection-reviews/reflection-<iter>.md` the next iteration, mirroring judge-assessment behavior.
2. **`cfcf-reflection-signals.json`** — machine-readable signals the harness acts on.
3. **`plan.md`** — the reflection agent may rewrite the **pending** portion. Strict non-destructive rule: completed items `[x]` and their notes stay untouched. See §6.
4. **`decision-log.md`** — appends a timestamped + tagged entry summarizing what it changed and why.

It does NOT write code. It does NOT modify problem.md / success.md / constraints.md.

### 3.4 What it produces in the analysis

The `reflection-analysis.md` covers:

- **Pattern analysis** across iterations ("three iterations have touched the auth layer, all failed on async test X").
- **Health classification** (converging / stable / stalled / diverging) with reasoning.
- **Plan changes** — summary of what was rewritten in the pending portion and why. If no changes were made, a one-line "no changes; plan looks correct."
- **Recommendation for the next iteration** — which pending item to pick up next and any specific focus.
- **Risks or concerns** that don't rise to "rewrite the plan" but the next iteration should know about.

---

## 4. File layout changes

### 4.1 New files / folders under `cfcf-docs/`

| Path | Written by | Lifecycle |
|---|---|---|
| `cfcf-reflection-instructions.md` | cfcf (from template) | Written per-iteration when reflection runs, like judge-instructions |
| `cfcf-reflection-signals.json` | Reflection agent | Reset to template before each run; parsed by cfcf after |
| `reflection-analysis.md` | Reflection agent | Written per run; latest persists, previous archived |
| `reflection-reviews/reflection-N.md` | cfcf | Archive of past reflection analyses, keyed by iteration number |

### 4.2 Files whose charter changes

| Path | Before | After |
|---|---|---|
| `decision-log.md` | Dev agent appends "decisions made" | **All agent roles** (dev, judge, architect, reflection) append entries with `[role: X] [iter: N] [category: Y]` tags. See §5 for the expanded charter. |
| `plan.md` | Dev agent maintains it | Dev agent maintains *completed* items; Reflection agent rewrites *pending* items. Both follow a non-destructive discipline (see §6). |
| `iteration-history.md` | Dev agent reads (cfcf regenerates) | Fixed: now sourced from `history.json` (iter-4) so it survives loop restarts. Still dev-read-only. |

### 4.3 Files to deprecate

| Path | Reason |
|---|---|
| `cfcf-docs/iteration-logs/` | Empty directory created by context-assembler and never populated. Real logs live in `~/.cfcf/logs/`. Drop the mkdir. |

### 4.4 Signal file schema changes

**`cfcf-judge-signals.json` — add two fields:**

```json
{
  // ... existing fields ...
  "reflection_needed": true | false,    // NEW: optional. Judge sets false to skip reflection.
                                        // Omitted = default = reflection runs.
  "reflection_reason": "string"         // NEW: optional. Prompt for the reflection agent
                                        // when reflection_needed=true.
}
```

Existing judge consumers default to safe behavior if these fields are missing (reflection runs). Backward compatible.

**`cfcf-reflection-signals.json` — new file:**

```json
{
  "iteration": 4,
  "plan_modified": true,                  // Did the reflection agent rewrite any pending items?
  "iteration_health": "converging"        // one of: converging | stable | stalled | diverging
                                          //    | inconclusive (not enough history yet)
  "key_observation": "string",            // One-line summary for the iteration log
  "recommend_stop": false                 // OPTIONAL: if the reflection concludes the loop is
                                          // fundamentally stuck, signal the user (not auto-stop)
}
```

The harness acts on:
- `plan_modified` → commit the plan change separately from code changes, with a distinct message.
- `iteration_health` → log, surface in the web UI History tab, future features may react.
- `recommend_stop` → if true, the loop pauses and notifies the user via the notification channels (`loop.paused` event with reason = "reflection flagged loop as stuck"). Never auto-stops — always human-gated.

---

## 5. Decision log — expanded charter

### 5.1 The single-file decision

We use `cfcf-docs/decision-log.md` for decisions, lessons learned, pattern observations, and strategy shifts — one journal, multiple authors. Rationale: the semantic line between "decision" and "lesson" is thin, and every entry already needs author/timestamp/category metadata for useful retrieval. Two files would just be one file with an extra routing step.

The filename stays `decision-log.md` to minimize churn in existing projects.

### 5.2 What it is NOT

- **Not a changelog.** Git commit history already records what changed. This file is about the *why* and *what we learned*.
- **Not an iteration log.** `~/.cfcf/logs/<project>/iteration-NNN-*.log` has raw agent output. This file is post-digested.
- **Not the plan.** `plan.md` is forward-looking; this is backward-looking.

### 5.3 Entry format

Every entry is a level-2 heading with metadata, followed by one or more paragraphs or bullet points.

```markdown
## 2026-04-18T12:34:56Z  [role: dev]  [iter: 3]  [category: lesson]

Async race condition in token refresh cannot be tested with fake timers alone
— the HTTP mock runs on real-time. Switched to a real `setTimeout(0)` yield
plus a 50ms budget. Related test: test_token_refresh.
```

Required metadata:
- **Timestamp** — ISO 8601 UTC, appearing as the start of the heading line.
- **`[role: X]`** — one of `dev | judge | architect | reflection | user`.
- **`[iter: N]`** — iteration number (use `0` for pre-iteration architect review, `-` for user entries that are cross-iteration).
- **`[category: Y]`** — one of `decision | lesson | observation | strategy | risk | resolved-question`.

Optional:
- **`[tag: ...]`** — free-form tag for cross-reference (e.g., `[tag: auth]`, `[tag: performance]`).

### 5.4 Who writes what (guidance to each role)

| Role | Typical category | What to write | What NOT to write |
|---|---|---|---|
| **Dev** | `decision`, `lesson` | Non-obvious implementation choices, bugs discovered and their fixes, tech-debt taken on, tradeoffs accepted | Routine progress (that's `plan.md` notes); library picks unless they were contested |
| **Judge** | `observation`, `risk` | Pattern noticed in this iteration only (e.g., "dev re-introduced a variable from iter-1 that judge-1 flagged"); risks not covered by tests | Strategic recommendations (that's reflection's job) |
| **Architect** | `risk`, `resolved-question` | Risks identified during pre-loop review; ambiguities the user resolved | Implementation advice (goes in hints.md before the loop starts) |
| **Reflection** | `strategy`, `observation` | Strategic shifts made to the plan and why; cross-iteration patterns; health classification rationale | Per-iteration tactical notes (that's judge's job) |
| **User** | any | Manual corrections, direction changes during paused loops | — |

### 5.5 Context assembly rules

Each role reads only the tail of `decision-log.md` that is relevant:

- **Dev agent** reads the last ~50 entries across all categories.
- **Judge** reads the last ~20 entries (tactical recency).
- **Reflection** reads the **entire file** — it is the one role whose job depends on the long view.
- **User** surfaces filtered views via a future `cfcf log` CLI.

The cfcf context-assembler is responsible for slicing the file for each role. The file itself grows unbounded; we rely on the file's own structure (newest last) and the assembler's slicing.

---

## 6. Plan editing rules — non-destructive

### 6.1 What "non-destructive" means

The reflection agent may rewrite *pending* items in `plan.md`. It must never:

- Delete or edit completed items (`[x]`) or the dev agent's notes attached to them.
- Delete or edit iteration headers for completed iterations (e.g., `## Iteration 1 — Foundation` once all items under it are done).
- Rewrite the file such that the git diff cannot be read as "pending items changed."

The reflection agent may:
- Add new iteration sections (`## Iteration 5 — <new phase>`).
- Remove pending iteration sections entirely (replacing them with a strategic note).
- Reorder pending iterations.
- Change the scope of pending iterations.
- Add or remove pending items within pending iterations.
- Annotate pending items with rationale.

### 6.2 Audit trail

When the reflection agent modifies the plan:

1. It writes the new `plan.md`.
2. It appends a `decision-log.md` entry (category `strategy`) describing *what changed and why*.
3. The cfcf harness makes a **separate git commit** with message `reflect(iter N): <key_observation>`. The commit touches only `plan.md` and `decision-log.md` (and the reflection analysis/signals). It is distinct from the prior dev commit and the (future) judge commit, so `git log` reads as a clean story.

If the git history is later inspected, anyone can `git log -- cfcf-docs/plan.md` to see every plan revision with its author (commit message) and rationale (pointed to by the decision-log entry).

### 6.3 Failure mode: reflection rewrites but the agent returns garbage

If the reflection agent produces an unparseable `plan.md` (e.g., it corrupted the markdown structure), cfcf reverts the `plan.md` change only and logs a warning. The iteration continues with the previous plan. This is the same defensive posture we use for malformed signal files.

Validation criteria (to be implemented):
- The file must parse as markdown.
- The set of completed items `[x]` in the new file must be a superset of the completed items in the old file.
- Every iteration header (`## Iteration N`) present in the old file must still be present in the new file (even if rewritten).

---

## 7. Configuration

### 7.1 New config fields

**On `CfcfGlobalConfig`:**

```typescript
reflectionAgent?: AgentConfig;        // { adapter, model }
reflectSafeguardAfter?: number;       // default: 3
```

**On `ProjectConfig` (per-project override):**

```typescript
reflectionAgent?: AgentConfig;        // default: globalConfig.reflectionAgent
reflectSafeguardAfter?: number;       // default: globalConfig.reflectSafeguardAfter ?? 3
```

### 7.2 Init flow

`cfcf init` is extended to ask for a reflection agent + model, with guidance:

> "Reflection is the strongest-context role — it reviews the full project history and can rewrite the pending plan. We recommend using the strongest model available (Claude Opus / GPT-5 / equivalent). **Matching the reflection agent's adapter to the dev agent's adapter has been observed to produce better-aligned plan revisions**, but is not required."

### 7.3 Config tab (web UI) — future

- Fifth role visible in the Config tab (currently shows dev / judge / architect / documenter).
- `reflectSafeguardAfter` as an integer input with help text.
- Read-only in iter-5; editable in iter-6+ (pending per the roadmap).

---

## 8. Open questions and proposed answers

### Q1. Does the reflection agent ever see the failing test output directly, or only the judge's summary?

**Proposed:** It sees the last iteration's **dev log tail** (last ~500 lines, compressed if needed) in addition to the judge assessment. Judge interpretation is one data point; raw evidence is another. This is a context-assembly change — the reflection prompt includes a "raw tail" section separate from the structured context.

### Q2. What if the reflection agent wants to change `success.md` (e.g., "the original criteria are over-specified and harmful")?

**Proposed for iter-6:** Strictly not allowed. `success.md` is user-defined and under user control; if reflection thinks it should change, it appends a `decision-log.md` entry of category `risk` flagging the issue, and optionally sets `recommend_stop: true` to pause and notify the user. The user is the only one who edits `problem.md` / `success.md` / `constraints.md`. Same for `hints.md` — user-owned.

### Q3. Do we pass the reflection agent the signed `git log` of each iteration branch, or just the compiled history?

**Proposed:** Pass a compact summary (one line per commit: hash + date + message) for the iteration branches. If the agent wants to dig deeper it can `git show <hash>`, but the default context is the summary to keep token usage predictable.

### Q4. Should reflection output be visible on the web UI History tab?

**Proposed:** Yes — add a row per reflection event similar to judge/iteration rows. Make `iteration_health` the "Result" column with its own color scheme (converging=green, stable=blue, stalled=yellow, diverging=red, inconclusive=grey). Click to expand → `reflection-analysis.md` rendered inline, same pattern as the `ArchitectReview` component for iter-4 architect signals.

### Q5. Can the reflection agent escalate to the user?

**Proposed:** Yes, via `recommend_stop: true` in the signals file. The harness then pauses the loop and fires a `loop.paused` notification with reason `"reflection flagged loop as stuck"`. The user reviews, decides whether to resume, and can optionally provide feedback via `cfcf resume --feedback "..."` (existing mechanism).

### Q6. What if the judge and reflection disagree — judge says "continue", reflection says `recommend_stop: true`?

**Proposed:** Reflection wins. Its broader context makes its "stop" signal more trustworthy than the judge's "continue." The harness pauses; user arbitrates.

### Q7. What if `plan.md` is missing when reflection runs?

**Proposed:** Reflection creates one. This shouldn't happen in practice (architect or dev-iter-1 creates it), but defensively: reflection reads problem/success, writes a phases-as-iterations plan like the architect would, and continues. Logged to `decision-log.md`.

---

## 9. Open questions for the user (push back welcome)

### U1. `reflectSafeguardAfter` default value

I'm proposing `3` — meaning judge can skip reflection at most 3 iterations in a row before the harness forces it. You could argue for `2` (tighter safety net) or `5` (trust the judge more). Thoughts?

### U2. Reflection output commit separation

I'm proposing three commits per iteration when reflection rewrites the plan: `dev(iter N): ...`, `judge(iter N): ...`, `reflect(iter N): ...`. Today we have `dev(iter N)` only (judge outputs are committed together with dev). Should judge continue to ride on the dev commit, or get its own? The clean story is three separate commits, but it triples the commit noise. I lean three separate commits.

### U3. Reflection on iteration 1?

Iteration 1 has one data point — the first iteration. Reflection there can only validate the plan, not observe patterns. Should we skip reflection on iteration 1 automatically, or let it run (likely producing `iteration_health: inconclusive` + no plan changes)? I lean skip-on-iter-1 to save cost.

### U4. Context assembly slicing for decision-log.md

If `decision-log.md` grows unbounded, do we auto-archive entries older than N iterations into a sibling `decision-log.archive.md`? I lean yes, with N = 50 iterations as the threshold, to keep the live file cheap to slice.

### U5. Manual reflection on user demand

A future `cfcf reflect --project <name>` CLI that runs reflection ad-hoc against the current state — useful when the user suspects drift but the judge hasn't signaled it. Worth including in the initial implementation, or defer?

---

## 10. Implementation ordering

Three PRs, ordered by dependency. Each is self-contained and mergeable.

### PR 1 — decision-log.md expanded charter + metadata format + bug fixes

- Rewrite `packages/core/src/templates/decision-log.md` with the new charter + entry format guidance.
- Update all four runner instruction templates to tell their agent:
  - How to format entries (timestamp + role tag + iter tag + category tag).
  - Which categories they own.
  - What NOT to put here.
- Context-assembler change: read `history.json` and feed the compressed per-iteration summary into `iteration-history.md` on every iteration — fixes the bug where `iteration-history.md` shows "No previous iterations" after a loop restart.
- Drop the empty `iteration-logs/` directory creation.
- Tests: updated template tests, new context-assembler test for history-from-history.json.
- Backward compatible: existing `decision-log.md` files with un-tagged entries still work. New entries follow the new format.

### PR 2 — Reflection role (agent + runner + signal + templates + config)

- New `packages/core/src/reflection-runner.ts` (shape mirrors `architect-runner.ts` and `documenter-runner.ts`).
- New templates: `cfcf-reflection-instructions.md`, `cfcf-reflection-signals.json`, `reflection-analysis.md` placeholder.
- New `ReflectionSignals` type in `types.ts`.
- New `reflectionAgent: AgentConfig` + `reflectSafeguardAfter: number` on both `CfcfGlobalConfig` and `ProjectConfig`.
- `cfcf init` extended to ask for reflection agent + model.
- Context assembler: new `assembleReflectionContext()` that pulls the full decision log, all prior reflection analyses, all archived judge assessments, history.json, and the current plan.
- Web types + API endpoint: `/api/projects/:id/reflections` and SSE log streaming parity.
- **NOT YET wired into the loop.** Only callable via a manual `cfcf reflect` command (if we include U5) or via a direct API endpoint for testing. This lets us validate the role in isolation before adding loop orchestration.
- Tests: unit tests for signal parsing, template resolution, config default propagation.

### PR 3 — Wire reflection into the iteration loop

- Judge signals extended: `reflection_needed`, `reflection_reason` fields.
- Update judge instruction template to explain the new signals.
- Iteration loop: after judge, evaluate the trigger logic (§2.2); if reflection runs, call `runReflection()`.
- Non-destructive plan validation before accepting reflection's rewrite.
- Separate git commit for reflection changes.
- Loop-state extended: `iterationsSinceLastReflection` counter.
- Iteration history event type: new `"reflection"` kind (alongside `"review"`, `"iteration"`, `"document"`). Web UI History tab gets a new row type and detail component (renders `reflection-analysis.md`).
- Tests: judge signal extension, reflection trigger logic (4 cases: needed=true, needed=false + under safeguard, needed=false + at safeguard, needed=missing), non-destructive validation (accept / reject cases).

Total implementation estimate: ~1500–2000 lines of new code + tests, ~5–7 days of focused work. Each PR is independently valuable — you could ship PR 1 alone as a polish pass, and PR 2 alone as a "manual reflection CLI" preview, before committing to the full loop integration in PR 3.

---

## 11. Risks

- **Cost creep.** Reflection on every iteration doubles the frontier-model spend. Mitigated by (a) judge opt-out, (b) user can tune `reflectSafeguardAfter`, (c) reflection can be mapped to a cheaper model if the user accepts quality tradeoff.
- **Plan churn.** Over-aggressive reflection may rewrite the plan every iteration, confusing the dev agent. Mitigated by the default guidance in the reflection instructions to *preserve* the plan unless pattern evidence warrants a change.
- **Loop latency.** Reflection is sequential — it extends each iteration's wall-clock time. For users running overnight loops this is fine; for tighter feedback loops it adds minutes. Mitigated by opt-out.
- **Reflection-judge contradiction noise.** If judge says "continue" and reflection says "stall", the user gets mixed signals. Mitigated by the precedence rule in Q6 and clear UI presentation.

---

## 12. Relationship to the v0.2 vision doc

This design is consistent with but sharper than the v0.2 three-tier model:

| v0.2 | This doc |
|---|---|
| Tier 3 Reflection every N iterations (default N=5) | Reflection every iteration unless judge opts out; safeguard forces it every N (default N=3) |
| Plan edits via `should_update_plan` + `suggested_plan_changes` structured flags | Reflection rewrites `plan.md` directly (non-destructively); flags are simpler (`plan_modified: bool`) |
| Cross-project `[CF-CF] Lessons Learned` Cerefox doc | Project-local `decision-log.md` with multi-role entries; cross-project aggregation deferred to iter-6 item 6.9 |
| SLM workers for log compression | Still deferred; may be added when token pressure demands it |

The v0.2 doc's unanswered Open Question #9 ("reflection-triggered strategy shifts — how aggressive?") is resolved here as: reflection can rewrite the pending plan freely but never auto-stops. Only `recommend_stop: true` + user arbitration.

---

## 13. Not in scope (intentionally deferred)

- Cross-project learnings aggregation (iter-6 item 6.9).
- SLM-based log compression (may surface if token usage becomes a problem).
- User-edit of reflection output before commit.
- `cfcf reflect` ad-hoc CLI (pending U5).
- Applying reflection to non-coding tasks (iter-6 item 6.11 — separate research).
