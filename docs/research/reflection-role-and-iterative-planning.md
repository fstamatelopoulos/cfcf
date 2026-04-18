# Reflection role and iterative planning — design doc

**Status:** **Finalized 2026-04-18.** All Q1–Q7 and U1–U5 resolved. Ready for a clean implementation session.
**Depends on:** current cfcf v0.4 (shipped) + iter-5 distribution items (landing on `iteration-5/distribution`).
**Supersedes / absorbs:** plan item 5.6 (Tier 3 Strategic Reflection); absorbs the per-project "lessons" substrate that v0.2 put in a separate Cerefox doc.
**Related vision doc:** "CF-CF: Cerefox Code Factory — Requirements & Vision v0.2" (Cerefox knowledge base, project "Cerefox Agent", document id `34646577-117a-412b-8beb-b8be54ee64d1`). Retrieve via the Cerefox MCP tool: `cerefox_get_document(document_id="34646577-117a-412b-8beb-b8be54ee64d1")`. See §12 for the detailed relationship.

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

1. **Produce a `reflection_needed` signal** (`true` / `false` / omit). Setting `false` is an **affirmative claim** that (a) the iteration made clean, on-plan progress, (b) no new risks emerged that warrant strategic review, and (c) prior iterations have not shown a drift pattern this iteration continued. Omitting the field or setting `true` runs reflection. The judge instruction template spells out this reasoning explicitly so the judge doesn't opt out thoughtlessly; the `reflectSafeguardAfter` ceiling catches an over-aggressive judge.

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

### 4.3 `cfcf-docs/iteration-logs/` — repurposed

The empty `iteration-logs/` directory (today created by context-assembler but never populated) is **repurposed** to hold per-iteration **agent-authored changelogs**, not raw agent output.

| Raw logs | Iteration-log (this folder) |
|---|---|
| `~/.cfcf/logs/<project>/iteration-NNN-dev.log` | `<repo>/cfcf-docs/iteration-logs/iteration-NNN.md` |
| Full stdout/stderr of the agent process, potentially megabytes | 1-page changelog-style summary written by the dev agent at end of iteration |
| Not in the repo (size, PII risk) | In the repo (small, human-curated, safe) |
| Consumed by humans during debugging | Consumed by judge / reflection / dev-of-next-iteration as context |

**File format — `iteration-NNN.md`:**

```markdown
# Iteration N — <short title>

**Branch:** cfcf/iteration-N
**Started:** 2026-04-18T12:00:00Z
**Finished:** 2026-04-18T12:34:56Z
**Agent:** codex:gpt-5

## Summary
One or two sentences describing what this iteration accomplished.
This is the line that gets prepended to iteration-history.md.

## Changes

### Added
- `src/auth/tokenRefresh.ts` — new async token refresh module with exponential backoff
- Test scenarios for token refresh edge cases (empty queue, concurrent requests)

### Modified
- `src/api/client.ts` — switched from inline token handling to the new refresh module
- `tests/auth.test.ts` — replaced fake-timers setup with real-time yield

### Removed
- `src/auth/legacy.ts` — superseded by the new module

## Tests
- Ran: `bun test packages/core`
- Passed: 178 / 180
- Failed: 2 (test_session_expiry, test_concurrent_refresh) — see handoff for next steps

## Commits
- a1b2c3d — feat(auth): add tokenRefresh module
- e4f5g6h — refactor(api): delegate token handling to refresh module
- 7i8j9k0 — test(auth): real-time yields for race-prone tests

## Plan items closed
- [x] Iteration 3, item 1: "Implement token refresh"
- [x] Iteration 3, item 2: "Replace fake timers with real-time yields in auth tests"
```

**Why introduce this artifact:**

1. **Context density.** Raw logs are high-volume, low-signal. A 1-page curated changelog is exactly the context the judge, reflection agent, and next-iteration dev agent need.
2. **Audit trail that survives loop restarts.** Because this file lives in the repo (and is committed with the iteration's changes), it is preserved across `cfcf stop` / restart cycles — unlike `loop-state.json`.
3. **Fixes the `iteration-history.md` bug.** `iteration-history.md` can be deterministically rebuilt each iteration by reading the `iteration-N.md` files in the repo and concatenating their `## Summary` sections newest-first. No more dependence on `state.iterations` memory being intact.
4. **Clean inputs to reflection.** The reflection agent can read all `iteration-logs/iteration-*.md` files to get a curated, agent-written history of the whole project — much better than raw terminal output.

**Who writes it:**

The **dev agent** writes `iteration-logs/iteration-N.md` at the end of its iteration, as one of its required output artifacts (alongside `iteration-handoff.md` and the iteration signals file). The dev-agent instruction template is extended to include this.

**Relationship to `iteration-handoff.md`:**

| `iteration-handoff.md` | `iteration-logs/iteration-N.md` |
|---|---|
| Forward-looking: "next iteration should …" | Backward-looking: "this iteration did …" |
| Open questions, blockers, user-input needs | Changes, tests, commits |
| Consumed primarily by judge + user | Consumed primarily by reflection + future-iteration dev |
| Reset each iteration (single file) | Accumulates per iteration (file-per-iteration) |

Both are produced by the dev agent; neither replaces the other.

**`iteration-history.md` rebuild algorithm:**

At the start of each iteration, the context-assembler regenerates `iteration-history.md` from the repo:

```
iteration-history.md contents :=
  "# Iteration History"
  +
  for i = N-1 down to 1:
    if cfcf-docs/iteration-logs/iteration-i.md exists:
      extract the "## Summary" body
      prepend as:
        "## Iteration i — <title>
         <summary>
         [full log: cfcf-docs/iteration-logs/iteration-i.md]"
```

So the history is always current, always ordered newest-first, and always readable without dependence on `loop-state.json`.

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

## 8. Resolved design decisions (Q1–Q7)

All confirmed by the user on 2026-04-18.

### Q1. Does the reflection agent see raw agent output?

**Resolved:** Yes — the reflection agent receives the **tail of the last iteration's dev log** (~500 lines, SLM-compressed if needed in a future iteration) in addition to the judge's interpretation. Raw evidence + judge interpretation = two independent data points. Implementation: context-assembler adds a "raw tail" section to the reflection prompt separate from the structured context.

### Q2. Can reflection modify problem/success/constraints/hints?

**Resolved:** **No.** `problem.md`, `success.md`, `constraints.md`, `hints.md` are user-owned and explicitly protected. If reflection thinks they should change, it appends a `decision-log.md` entry of category `risk` flagging the issue and may set `recommend_stop: true` in its signals to pause the loop and notify the user. The user is the only editor of these four files.

### Q3. Does reflection see the git log of iteration branches?

**Resolved:** Yes — a compact summary (one line per commit: hash + date + message) covering every `cfcf/iteration-*` branch. If the agent wants to dig into a specific commit it can `git show <hash>`; the default context keeps token usage predictable.

### Q4. Reflection output in the web UI History tab?

**Resolved:** Yes. A new row type per reflection event, alongside iteration/review/document rows. The "Result" column shows `iteration_health` with color coding: converging=green, stable=blue, stalled=yellow, diverging=red, inconclusive=grey. Row expands to an inline `ReflectionAnalysis` component (mirrors the `ArchitectReview` pattern from iter-4) that renders the parsed `cfcf-reflection-signals.json`.

### Q5. Can reflection escalate to the user?

**Resolved:** Yes, via `recommend_stop: true` in the signals file. The harness then pauses the loop and fires a `loop.paused` notification with reason `"reflection flagged loop as stuck"`. The user reviews, decides whether to resume, and can provide feedback via `cfcf resume --feedback "..."` (existing mechanism).

### Q6. Judge / reflection disagreement precedence

**Resolved:** Reflection wins. Its broader context makes its "stop" signal more trustworthy than the judge's "continue." The harness pauses; the user arbitrates. This precedence rule is what proves the value of the reflection signals file — without it the disagreement has nowhere to be recorded.

### Q7. Missing `plan.md` when reflection runs

**Resolved:** Reflection creates one. Shouldn't happen in practice (architect or dev-iter-1 creates it), but defensively: reflection reads problem/success, writes a phases-as-iterations plan like the architect would, and continues. Logs a `decision-log.md` entry (category `strategy`) documenting the bootstrap.

---

## 9. Resolved: user open questions (U1–U5)

All confirmed by the user on 2026-04-18.

### U1. `reflectSafeguardAfter` default value

**Resolved: default `3`.** The judge may set `reflection_needed: false` for at most 3 consecutive iterations; on the 4th the harness forces reflection regardless. Per-project override allowed.

### U2. Reflection output commit separation

**Resolved: three commits per iteration** when reflection modifies the plan:

- `dev(iter N): <summary>` — code changes, `iteration-logs/iteration-N.md`, `iteration-handoff.md`, signals.
- `judge(iter N): <determination>` — `judge-assessment.md`, judge signals, archival of prior judge output.
- `reflect(iter N): <health>: <key_observation>` — `reflection-analysis.md`, reflection signals, **and** any changes to `plan.md` + `decision-log.md` made by reflection.

Each commit is produced by the harness after the corresponding phase completes. `git log --oneline` reads as a clean three-line story per iteration. When the judge rides on a single iteration with no reflection (judge opted out, under the safeguard ceiling), only two commits are produced.

### U3. Reflection on iteration 1

**Resolved: never auto-skip.** Reflection runs on every iteration unless the judge explicitly sets `reflection_needed: false`. Iteration 1 is included — reflection there serves as a sanity check on the initial plan and the judge's first call.

**Implication for the judge instruction template:** the judge must be taught to reason carefully before opting out. The template (`cfcf-judge-instructions.md`) will include guidance along these lines:

> You may set `reflection_needed: false` ONLY when you are confident that:
> 1. The iteration made clean, on-plan progress that matches the current `plan.md` item(s).
> 2. No new risks, concerns, or surprising behaviors emerged that warrant strategic review.
> 3. Prior iterations have not shown a pattern of drift that this iteration continued.
>
> When in doubt, omit the field or set `true`. The cost of an unnecessary reflection pass is cheap compared to the cost of a strategic drift going unchecked. If you consistently opt out, cfcf will force reflection after `reflectSafeguardAfter` consecutive skips.

The safeguard ceiling (U1) catches an over-aggressive judge.

### U4. Decision-log archiving

**Resolved: no auto-archive. Issue a warning instead.** `decision-log.md` grows unbounded in the repo. At iteration 50 (hardcoded, reviewable), the harness:
- Appends a soft warning to `iteration-history.md` noting that the decision log is getting large.
- Fires a `loop.paused` — **wait, no**, we don't want to pause the loop for this. Instead, emits an **informational notification** via the existing notification dispatcher with event type `project.decision_log_large`. Treat it as a new optional event type users can opt into.

No actual trimming — the user owns the decision log and decides when to archive. If they want to archive, they can do it manually (`cp decision-log.md decision-log.archive-iter-50.md && echo "[archived at iter 50]" >> decision-log.md`). A future helper CLI like `cfcf archive-log` could automate this but is not in scope.

### U5. Manual reflection on user demand

**Resolved: yes, include in the initial implementation.** New CLI command:

```bash
cfcf reflect --project <name>           # run reflection once, ad-hoc
cfcf reflect --project <name> --prompt "focus on the auth module drift"
```

Runs the same reflection runner as the loop-triggered path, but independent of an iteration. Does NOT write an `iteration-logs/iteration-N.md` (no iteration happened), and does NOT modify `loop-state.json`. Writes `reflection-analysis.md` + signals as usual; archives any prior reflection analysis; appends a `decision-log.md` entry of category `strategy` noting the manual trigger.

**CLI parity note:** this surfaces the broader need to audit CLI ↔ web-GUI parity as more roles are added. Tracked as a follow-up item (see §13 Not-in-scope / follow-ups).

---

## 10. Implementation ordering

Three PRs, ordered by dependency. Each is self-contained and mergeable.

### PR 1 — iteration-log artifacts + decision-log expanded charter + metadata format

- **New artifact: `cfcf-docs/iteration-logs/iteration-N.md`.** Dev agent writes this at end of iteration (changelog-style, see §4.3). Extend the dev agent's instruction template (`CLAUDE.md` / `AGENTS.md` generator in `context-assembler.generateInstructionContent`) and `process.md` with the required file + format.
- **Rebuild `iteration-history.md` from iteration-logs.** Context-assembler now reads `cfcf-docs/iteration-logs/iteration-*.md` (newest-first) and concatenates their `## Summary` sections. Fixes the loop-restart bug.
- **Repurpose the existing `iteration-logs/` mkdir** (currently empty) — it now serves the iteration-log artifact, not raw logs.
- **decision-log.md expanded charter.** Rewrite `packages/core/src/templates/decision-log.md` with the new charter + entry format guidance (timestamp + `[role: X]` + `[iter: N]` + `[category: Y]` tags).
- Update all four runner instruction templates to tell their agent:
  - How to format decision-log entries.
  - Which categories they own.
  - What NOT to put here (changelog → iteration-N.md; progress → plan.md).
- Tests: updated context-assembler tests for iteration-history rebuild + new iteration-log artifact, updated template tests.
- Backward compatible: existing `decision-log.md` files with un-tagged entries still work. New entries follow the new format. Pre-existing projects without `iteration-logs/*.md` files fall back to showing "No previous iterations" in `iteration-history.md` — same as today.

### PR 2 — Reflection role (agent + runner + signal + templates + config + manual CLI)

- New `packages/core/src/reflection-runner.ts` (shape mirrors `architect-runner.ts` and `documenter-runner.ts`).
- New templates: `cfcf-reflection-instructions.md`, `cfcf-reflection-signals.json`, `reflection-analysis.md` placeholder.
- New `ReflectionSignals` type in `types.ts`.
- New `reflectionAgent: AgentConfig` + `reflectSafeguardAfter: number` on both `CfcfGlobalConfig` and `ProjectConfig`. Backfill for pre-5.6 configs.
- `cfcf init` extended to ask for reflection agent + model, with the guidance text from §7.2.
- Context assembler: new `assembleReflectionContext()` that pulls the full decision log, all prior reflection analyses, all archived judge assessments, all `iteration-logs/iteration-*.md`, compact git log of iteration branches (Q3), the dev log tail of the last iteration (Q1), and the current plan.
- **New CLI command `cfcf reflect` (U5):**
  - `cfcf reflect --project <name>` — runs reflection ad-hoc against current state.
  - `cfcf reflect --project <name> --prompt "<focus hint>"` — optional user-supplied hint passed to the reflection agent.
  - Does NOT write `iteration-logs/iteration-N.md`. Does NOT modify `loop-state.json`. Appends a `decision-log.md` entry of category `strategy` noting the manual trigger.
- Web API endpoint: `POST /api/projects/:id/reflect` for web-UI parity (calls the same runner).
- Web types + existing log-streaming endpoint covers reflection logs the same way as architect/documenter (sequence-numbered: `reflection-NNN.log`).
- **NOT YET wired into the iteration loop.** Callable only via `cfcf reflect` CLI or the new API endpoint. This isolates the role for testing before PR 3 adds loop orchestration.
- Tests: unit tests for signal parsing, template resolution, config default propagation, manual-trigger path (no loop state mutation, no iteration-log artifact).

### PR 3 — Wire reflection into the iteration loop

- Judge signals extended: `reflection_needed`, `reflection_reason` fields.
- Update judge instruction template with the "set to false only when" checklist from §2.3 so the judge opts out thoughtfully.
- Iteration loop: after judge, evaluate the trigger logic (§2.2); if reflection runs, call `runReflection()`.
- Non-destructive plan validation before accepting reflection's rewrite (see §6.3 criteria).
- **Three separate commits per iteration** (U2): `dev(iter N): ...`, `judge(iter N): ...`, `reflect(iter N): ...`. The harness produces each after the corresponding phase completes.
- Loop-state extended: `iterationsSinceLastReflection` counter (reset when reflection runs, incremented when judge opts out).
- **Decision-log size warning** (U4): when `iterationsSinceLastReflection` + total iteration count >= 50, emit a one-line warning into `iteration-history.md` and fire an optional notification event `project.decision_log_large` via the existing dispatcher. No auto-trim.
- Iteration history event type: new `"reflection"` kind (alongside `"review"`, `"iteration"`, `"document"`). Web UI History tab gets a new row type and a `ReflectionAnalysis` detail component (mirror of `ArchitectReview`; renders the parsed `cfcf-reflection-signals.json`).
- Tests: judge signal extension, reflection trigger logic (4 cases: needed=true, needed=false + under safeguard, needed=false + at safeguard, needed=missing), non-destructive validation (accept / reject cases), three-commit sequence assertion on a real git repo fixture.

Total implementation estimate: ~1500–2000 lines of new code + tests, ~5–7 days of focused work. Each PR is independently valuable — you could ship PR 1 alone as a polish pass, and PR 2 alone as a "manual reflection CLI" preview, before committing to the full loop integration in PR 3.

---

## 11. Risks

- **Cost creep.** Reflection on every iteration doubles the frontier-model spend. Mitigated by (a) judge opt-out, (b) user can tune `reflectSafeguardAfter`, (c) reflection can be mapped to a cheaper model if the user accepts quality tradeoff.
- **Plan churn.** Over-aggressive reflection may rewrite the plan every iteration, confusing the dev agent. Mitigated by the default guidance in the reflection instructions to *preserve* the plan unless pattern evidence warrants a change.
- **Loop latency.** Reflection is sequential — it extends each iteration's wall-clock time. For users running overnight loops this is fine; for tighter feedback loops it adds minutes. Mitigated by opt-out.
- **Reflection-judge contradiction noise.** If judge says "continue" and reflection says "stall", the user gets mixed signals. Mitigated by the precedence rule in Q6 and clear UI presentation.

---

## 12. Relationship to the v0.2 vision doc

"v0.2 vision doc" refers to **"CF-CF: Cerefox Code Factory — Requirements & Vision v0.2"**, authored April 1 2026. It introduced cfcf's three-tier evaluation model (mechanical / judge / reflection). It lives in the **Cerefox knowledge base** under the "Cerefox Agent" project and is retrievable via the Cerefox MCP tool:

- **Title:** `CF-CF: Cerefox Code Factory -- Requirements & Vision v0.2`
- **Cerefox project:** `Cerefox Agent`
- **Document ID:** `34646577-117a-412b-8beb-b8be54ee64d1`
- **Retrieve via MCP:** `cerefox_get_document(document_id="34646577-117a-412b-8beb-b8be54ee64d1")`
- **Related earlier draft (v0.1):** `CF-CF: Cerefox Code Factory -- Requirements & Vision v0.1`, ID `5d6a3720-c25f-4208-b64b-bf4d8ef39e9f` (same project). v0.1 predates the three-tier evaluation model.
- **Related broader agent concept:** `Cerefox Agent — Full Vision Document v0.1`, ID `b027a566-41f7-45e1-acc4-7ae4f36323e2` (same project). Origin of the OODA+R loop and the memory-first design philosophy that cfcf inherits.

A local mirror of the v0.2 file is **not** kept in this repo — the authoritative copy is in Cerefox. When working on this design doc, retrieve the full v0.2 text from Cerefox to verify the relationship claims below.

### Where this doc diverges from v0.2

This design is consistent with but sharper than the v0.2 three-tier model:

| v0.2 | This doc |
|---|---|
| Tier 3 Reflection every N iterations (default N=5) | Reflection every iteration unless judge opts out; safeguard forces it every N (default N=3) |
| Plan edits via `should_update_plan` + `suggested_plan_changes` structured flags | Reflection rewrites `plan.md` directly (non-destructively); flags are simpler (`plan_modified: bool`) |
| Cross-project `[CF-CF] Lessons Learned` Cerefox doc | Project-local `decision-log.md` with multi-role entries; cross-project aggregation deferred to iter-6 item 6.9 |
| SLM workers for log compression | Still deferred; may be added when token pressure demands it |
| v0.2 Open Question #9 ("reflection-triggered strategy shifts — how aggressive?") was left unanswered | Resolved here: reflection can rewrite the pending plan freely but never auto-stops. Only `recommend_stop: true` + user arbitration (Q5, Q6). |

---

## 13. Not in scope / follow-ups

### Deferred to later iterations
- Cross-project learnings aggregation (iter-6 item 6.9).
- SLM-based log compression for the reflection prompt (may surface if token usage becomes a problem).
- User-edit of reflection output before commit (manual intervention gate).
- Applying reflection to non-coding tasks (iter-6 item 6.11 — separate research).
- Auto-archiving of `decision-log.md` at thresholds (warning only in this scope per U4; a `cfcf archive-log` helper could land later).

### CLI ↔ web-GUI parity audit (raised by U5)

Adding `cfcf reflect` brings total CLI commands to: `init`, `server start/stop/status`, `project init/list/show/delete`, `config show/edit`, `run`, `resume`, `stop`, `review`, `document`, `reflect`. Every one of these has (or should have) a web-GUI equivalent. A parity audit is its own task — flagged here so the next iteration can pick it up.

Suggested placement: new plan item in iteration 6 ("CLI ↔ web-GUI parity audit"), paired with item 6.2 (`cfcf log` CLI) and 6.3 (`cfcf push` CLI) which also surface parity gaps.
