# Decision & Lessons Log

**Charter.** This is the project's append-only journal for *why* things were
done and *what was learned*. Every cfcf role (dev, judge, architect,
reflection) and the user may add entries here.

## What this file IS

- **Decisions** -- non-obvious implementation choices, architectural picks,
  tradeoffs accepted.
- **Lessons** -- bugs discovered and their root causes, workarounds needed,
  surprising behaviors.
- **Observations** -- patterns noticed in an iteration or across iterations.
- **Strategy** -- shifts in approach, plan rewrites and their rationale.
- **Risks** -- concerns flagged that don't block progress but need tracking.
- **Resolved questions** -- ambiguities the user or a role clarified.

## What this file is NOT

- **Not a changelog.** Git commit history already records *what* changed.
  This file is about the *why* and *what we learned*.
- **Not an iteration log.** `cfcf-docs/iteration-logs/iteration-N.md` is the
  per-iteration changelog. `~/.cfcf/logs/` has raw agent output.
- **Not the plan.** `cfcf-docs/plan.md` is forward-looking; this is
  backward-looking.

## Entry format

Every entry is a level-2 heading with timestamp + role + iteration +
category tags, followed by one or more paragraphs or bullet points.

```markdown
## 2026-04-18T12:34:56Z  [role: dev]  [iter: 3]  [category: lesson]

Async race condition in token refresh cannot be tested with fake timers
alone -- the HTTP mock runs on real-time. Switched to a real
`setTimeout(0)` yield plus a 50ms budget. Related test: test_token_refresh.
```

**Required metadata:**

- **Timestamp** -- ISO 8601 UTC, appearing as the start of the heading line.
- **`[role: X]`** -- one of `dev | judge | architect | reflection | user`.
- **`[iter: N]`** -- iteration number (`0` for pre-iteration architect,
  `-` for cross-iteration user entries).
- **`[category: Y]`** -- one of:
  - `decision` -- a choice made (dev, architect)
  - `lesson` -- something learned the hard way (dev, judge)
  - `observation` -- a pattern noticed (judge, reflection)
  - `strategy` -- a plan-level shift (reflection, architect)
  - `risk` -- a concern worth tracking (architect, judge)
  - `resolved-question` -- an ambiguity clarified (architect, user)

**Optional:**

- **`[tag: ...]`** -- free-form tag for cross-reference
  (e.g., `[tag: auth]`, `[tag: performance]`).

## Who writes what

| Role | Typical categories | What to write | What NOT to write |
|---|---|---|---|
| **Dev** | `decision`, `lesson` | Non-obvious implementation choices, bugs discovered and their fixes, tech-debt taken on, tradeoffs accepted | Routine progress (that's `plan.md` notes); library picks unless contested |
| **Judge** | `observation`, `risk` | Patterns noticed in this iteration (e.g., dev re-introduced a variable a prior judge flagged); risks not covered by tests | Strategic recommendations (that's reflection's job) |
| **Architect** | `risk`, `resolved-question` | Risks identified during pre-loop review; ambiguities the user resolved | Implementation advice (goes in `hints.md` before the loop starts) |
| **Reflection** | `strategy`, `observation` | Strategic shifts made to the plan and why; cross-iteration patterns; health-classification rationale | Per-iteration tactical notes (that's judge's job) |
| **User** | any | Manual corrections, direction changes during paused loops | -- |

## Growth

This file grows unbounded. Each role reads only the tail it needs
(dev: last ~50 entries, judge: last ~20, reflection: entire file). When
iteration count crosses 50, cfcf will emit a size warning but will NOT
auto-archive -- the user owns the log.

---

<!-- New entries are appended below. -->
