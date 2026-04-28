# Product Architect — design baseline

**Status**: Implementation baseline. PA v1 ships in iter-5 on `iteration-5/product-architect-spec` (the original `iteration-5/product-architect` branch was deleted with PR #21 during the verb-rename pivot; commit `86a01c7` was recovered from reflog before the rename).
**Plan item**: 5.14.
**Builds on**: [`docs/research/help-assistant.md`](help-assistant.md) (HA established the role-based-agent architecture + the launcher seam PA reuses).
**Related**: [`docs/decisions-log.md`](../decisions-log.md) entries on role-based memory + the Pattern A/B comparison.

## Verb shape: `cfcf spec` (decided 2026-04-28)

Open question #1 resolved: **PA is invoked via the top-level `cfcf spec [task...]` verb**, NOT `cfcf help architect`. PA is a first-class cf² SDLC role — peer to dev / judge / Solution Architect / reflection / documenter — and belongs alongside `cfcf review` / `cfcf run` / `cfcf reflect` / `cfcf document`, not under the `cfcf help` namespace (which is for cf²-itself documentation + the Help Assistant).

The chosen verb follows the same pattern as the other role-output top-level verbs:

| Verb | What the role outputs |
|---|---|
| `cfcf spec` (PA) | Problem Pack (`{problem,success,process,constraints}.md`) |
| `cfcf review` (Solution Architect) | Plan outline + readiness verdict |
| `cfcf reflect` (reflection) | Cross-iteration analysis |
| `cfcf document` (documenter) | Final docs |

Field name correspondingly renamed `helpArchitectAgent` → `productArchitectAgent`.

## Interactivity: the one trait inherited from HA

PA differs from `cfcf review` / `cfcf reflect` / `cfcf document` in one important way: **PA runs interactively**. The configured agent CLI's TUI takes over the user's current shell until exit, exactly like `cfcf help assistant`. The other SDLC role verbs run **non-interactively** — they spawn a fire-and-forget agent process and communicate via structured signal files (`cfcf-iteration-signals.json`, `cfcf-architect-signals.json`, etc.).

Why interactive for PA?
- **Spec authoring is iterative by nature.** "What's the success criterion for the auth flow?" → user answers → PA drafts → user pushes back → PA refines. A fire-and-forget signal-file workflow can't substitute for that loop.
- **The user is the source of truth on intent.** Unlike dev (who works against fixed specs) or reflection (which analyses a fixed history), PA is co-authoring with the user. It needs the user in the room.
- **The output is small + reviewable.** The four Problem Pack files are short enough that the user can eyeball each draft and respond inline. There's no need for a structured "verdict" signal file.

So PA inherits HA's launcher seam (Pattern A/B mechanics, `inherit` stdio, no `--dangerously-skip-permissions`) but lives in the SDLC-role namespace verb-wise. This is the one operational similarity to HA; everything else (memory schema, file ownership, scope) is PA-specific.

---

## TL;DR

The **Product Architect (PA)** is the second cf² role using the HA architecture (interactive, role-scoped, Clio-memory-backed). Where HA helps users *operate* cf², PA helps users *start a project on* cf². It's a specialised assistant focused exclusively on problem definition + test cases + success criteria — what cf² calls the **Problem Pack**.

The PA's scope is deliberately narrow:

- **In scope**: identify/create the repo, run `cfcf workspace init`, iteratively refine `cfcf-docs/{problem,success,process,constraints}.md`, then hand off.
- **Out of scope**: implementing features, writing code, designing architecture (the existing **Solution Architect** role does that, post-handoff).

The hard constraint is **PA refuses to drift into implementation**, even if the user insists. PA's job ends when the Problem Pack is good enough to feed the loop; from there the user runs `cfcf review` (Solution Architect) or `cfcf run` directly.

PA is invoked via `cfcf spec [task...]` (decided 2026-04-28; see §"Verb shape" above).

---

## Why a separate role from HA

Three reasons HA can't just answer "help me start a project" by itself:

1. **PA needs to MUTATE the user's repo.** Writing `cfcf-docs/problem.md` etc. requires write access to a specific dir. HA is read-only-by-default with permission-gated mutations; that's the wrong defaults for a role whose job IS to write spec files.

2. **PA needs DURABLE per-workspace context.** Refining specs is multi-session. The user iterates with PA over days/weeks; each session needs to know what's been agreed, what's still open, what's been rejected. HA's session-scoped tempfile pattern (`model_instructions_file`) is wrong for this — PA wants the persistent `AGENTS.md`/`CLAUDE.md` auto-load convention.

3. **PA must enforce its own scope.** The hard "no implementation" rule is opinionated guidance the system prompt encodes. HA is general; PA is specialised.

The role-based architecture from HA makes adding PA cheap: same launcher seam, different system prompt, different Clio memory project, different durable-instruction file. The infrastructure is already there.

---

## What PA does

### The flow

```
┌──────────────────────────────────────────────────────────────┐
│ Phase 0: Discovery                                           │
│ - PA: "What are you trying to build?"                        │
│ - User: free-form description                                │
│ - PA: clarifying questions, ask for examples                 │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ Phase 1: Repo bootstrap                                      │
│ - PA detects: am I in a git repo? Is it cfcf-managed?        │
│ - If no repo: PA offers to create one (with permission)      │
│ - If repo exists but no workspace: PA runs                   │
│   `cfcf workspace init` (with permission)                    │
│ - If workspace exists: PA opens cfcf-docs/                   │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ Phase 2: Spec iteration (the bulk of PA's work)              │
│ - Draft problem.md based on the discovery conversation       │
│ - Draft success.md (test cases + acceptance criteria)        │
│ - Draft process.md (constraints, must-haves)                 │
│ - Draft constraints.md (what NOT to do)                      │
│ - Iterate with the user; write each draft to the file        │
│   (with permission); ask follow-ups; refine                  │
│ - Persist conversation context in cfcf-memory-pa across      │
│   sessions (so the next session resumes where this one left  │
│   off)                                                       │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ Phase 3: Hand-off                                            │
│ - PA reviews the Problem Pack with the user one final time   │
│ - PA explains the loop: cfcf review (architect re-review)    │
│   OR cfcf run (start the dev/judge/reflect loop)             │
│ - PA exits cleanly                                           │
└──────────────────────────────────────────────────────────────┘
```

The flow is iterative within Phase 2; the user moves freely between drafting / refining the four files until satisfied.

### What PA writes

**To the user's repo** (with permission, via the agent CLI's bash/edit tools):

- `cfcf-docs/problem.md`
- `cfcf-docs/success.md`
- `cfcf-docs/process.md`
- `cfcf-docs/constraints.md`
- (optional) `cfcf-docs/decision-log.md` — initial seed entries from the spec conversation
- (NOT) `cfcf-docs/plan.md` — that's the Solution Architect's territory

**To Clio memory**:

- `cfcf-memory-pa` — PA-specific: spec-iteration history per workspace, decision rationales, "things we considered and rejected"
- `cfcf-memory-global` (shared with HA) — user-wide preferences PA learned during the session ("user prefers TDD", "user always wants pytest", "user works in TypeScript by default")

### What PA refuses to do

The system prompt encodes hard refusals. Even if the user pushes:

- "Just write the implementation" → "That's the dev role's job during the iteration loop. I focus on specs. Run `cfcf run` after we finish the Problem Pack."
- "Design the architecture" → "That's the Solution Architect's job. Run `cfcf review` after we finish here."
- "Add `cfcf-docs/plan.md`" → "The architect agent owns the plan. I focus on what + why; the plan is how."
- "Write tests for me" → "Tests come from the dev/judge cycle. I describe the success criteria; the agents implement + verify."

The user CAN override and have PA do these things, but PA pushes back first and explains why the boundary exists.

---

## Architecture

### Reuses HA's launcher

PA uses `packages/core/src/help-assistant/launcher.ts`'s per-adapter argv builder, extended with a per-role parameter. Same code path, different inputs:

- HA: `model_instructions_file` tempfile (Pattern A)
- PA: `cfcf-docs/AGENTS.md` (codex) / `cfcf-docs/CLAUDE.md` (claude-code) auto-loaded from cwd (Pattern B)

The launcher gains a `role` parameter that selects which pattern to use. Pattern definitions live in a shared module so future roles can be added by adding a row.

### Pattern B: durable AGENTS.md/CLAUDE.md

PA's role briefing lives in `<workspace-repo>/cfcf-docs/AGENTS.md` (and a CLAUDE.md sibling for claude-code). Both agent CLIs auto-load these files when the agent runs with `--cd <workspace-repo>/cfcf-docs/`. The launcher:

1. Resolves the workspace's repo path
2. Writes (or refreshes) `cfcf-docs/AGENTS.md` and `cfcf-docs/CLAUDE.md` with the PA role briefing if they don't already exist (or if they're stale — version-stamp the file header)
3. Spawns the agent with `--cd <repo>/cfcf-docs/` so the AGENTS.md/CLAUDE.md auto-load picks up the PA briefing
4. Optionally passes a per-call task hint as the positional `[PROMPT]` arg

The user's existing iteration-time `AGENTS.md` (at the repo root, used by cf² runs) is at a *different* path so the two roles don't collide. Codex's auto-load walks parent dirs, but the PA's `cfcf-docs/AGENTS.md` is loaded LAST (deepest scope wins) — so PA's directives effectively override anything inherited.

### `productArchitectAgent` config field

By symmetry with `helpAssistantAgent`. Backfilled to `architectAgent`'s adapter when missing (the existing Architect agent's profile — broad-context, strong-reasoning — is closest to PA's).

```ts
interface CfcfGlobalConfig {
  // ... existing roles ...
  helpAssistantAgent?: AgentConfig;   // shipped in v0.15.0
  productArchitectAgent?: AgentConfig; // iter-5 (5.14)
}
```

`cfcf init` interactive flow gains a 7th role picker (or stays at 6 with PA defaulting silently to the Architect's config — open question §10).

---

## Clio memory schema

### `cfcf-memory-pa` Project

Per-workspace context that persists across PA sessions. Schema convention (no extra metadata required beyond what we already have):

| Doc title pattern | Content | metadata |
|---|---|---|
| `Spec session: <date>` | Conversation summary of one PA session | `{role: "pa", artifact_type: "spec-session", workspace_id: "<id>"}` |
| `Spec decision: <topic>` | A specific spec decision (what + why) | `{role: "pa", artifact_type: "spec-decision", workspace_id: "<id>"}` |
| `Spec rejection: <idea>` | Things considered + rejected | `{role: "pa", artifact_type: "spec-rejection", workspace_id: "<id>"}` |
| `Workspace summary` | Living summary of the spec process | `{role: "pa", artifact_type: "workspace-summary", workspace_id: "<id>"}` |

PA reads `cfcf clio metadata search --filter '{"role":"pa","workspace_id":"<id>"}'` on session start to load the workspace's accumulated context.

### `cfcf-memory-global` (shared)

PA writes user-wide preferences here so OTHER roles benefit (HA reads them too). Examples:

- "User prefers TDD; specs should describe test-first behaviour"
- "User works primarily in TypeScript; default test framework is vitest"
- "User explicitly avoids monorepos"

Schema: `{role: "user-preference", source_role: "pa", confidence: "high|medium|low"}`. Other roles can vote on / refine entries.

---

## System prompt

The PA system prompt is shorter than HA's — it doesn't embed the full help bundle (PA doesn't help with cf² usage; only with spec writing). Key sections:

```
# You are the cf² Product Architect (PA)

You are a specialised role within cf². Your job is to help the user
define a NEW project on cf² -- specifically, to author the Problem Pack
files (problem.md / success.md / process.md / constraints.md) the
dev/judge/reflect loop will satisfy.

You are NOT here to write code, design architecture, or implement
features. Decline politely + redirect when the user asks.

# Scope

In scope:
  - Discovery: clarifying what the user wants to build
  - Bootstrap: identifying / creating the repo, running cfcf
    workspace init (with permission)
  - Iteratively drafting + refining the four Problem Pack files
  - Reading + writing Clio memory (cfcf-memory-pa workspace-scoped,
    cfcf-memory-global user-wide)

Out of scope (decline + redirect):
  - "Write the implementation" -> dev role, run cfcf run
  - "Design the architecture" -> Solution Architect, run cfcf review
  - "Add cfcf-docs/plan.md" -> architect's territory
  - "Write the tests" -> success.md describes; dev/judge implement
  - "Optimise the code" -> dev role
  - General cf² usage questions -> Help Assistant (cfcf help assistant)

# The boundary

Even if the user insists on going past the boundary:
  - Push back politely + explain why the boundary exists
  - Offer the right path forward (cfcf review / cfcf run / cfcf
    help assistant)
  - The user CAN override after the explanation -- you do what they
    ask, but you've made the trade-off explicit

# Permission model

[same as HA: per-command permission prompts; the agent CLI's default]

# Memory

[Clio memory layout, same shape as HA's section but pointing at
 cfcf-memory-pa + cfcf-memory-global]

# Workspace state

[the four Problem Pack files' current contents, if any]

# Your behaviour at session start

1. Greet the user briefly (one sentence)
2. Read your Clio memory: cfcf clio metadata search ... for this workspace
3. If memory exists: summarise where we left off + ask what to focus on
4. If no memory yet: ask what the user wants to build

# Your behaviour at session end

Before exit, if anything important was decided:
  - Ask the user if you should write a Spec decision / rejection /
    session summary to cfcf-memory-pa for next time
  - With user approval, run cfcf clio docs ingest --project
    cfcf-memory-pa ...
```

Approximately 5-8 KB. Plus the workspace-state injection (the current Problem Pack files' contents, if any) — variable, ranges from 0 to ~30 KB. Total well under any agent's context window.

---

## CLI surface

### `cfcf spec [task...]`

```bash
cfcf spec                                          # interactive PA session on cwd
cfcf spec --repo <path>                            # explicit repo path
cfcf spec --agent claude-code                      # override config.productArchitectAgent
cfcf spec --print-prompt                           # debug: emit prompt + exit
cfcf spec "Tighten the success.md auth criteria"   # opens with this task as user's first message
```

PA refuses to launch when `<repo>/cfcf-docs/` doesn't exist (Pattern B requires it as the auto-load anchor) and prints a `cfcf workspace init` hint. **`--bootstrap` mode**, where PA itself runs `cfcf workspace init` (with permission), is on the v2 roadmap — see §10.

---

## Implementation plan

### What ships in iter-6

- `packages/core/src/product-architect/` — system-prompt assembler, workspace-state reader, Clio-memory reader (parallel to `help-assistant/`)
- `packages/cli/src/commands/spec.ts` (NEW, top-level `cfcf spec`)
- `productArchitectAgent` field on `CfcfGlobalConfig`, backfilled to `architectAgent`'s adapter
- Launcher refactor: extract per-pattern argv builder so HA (Pattern A) + PA (Pattern B) share the seam without duplication
- `cfcf-docs/AGENTS.md` + `cfcf-docs/CLAUDE.md` PA briefing files: written/refreshed by the launcher; sentinel-marked so user content outside the markers is preserved (same convention as the rc-edit + iteration-time CLAUDE.md/AGENTS.md)
- Tests: prompt assembler, workspace-state reader, the per-role launcher dispatch
- `cfcf doctor` "Product Architect prerequisites" check

### What's deferred to iter-7+

- Web UI Product Architect button + UI flow for "I want to start a new project"
- "Cross-role memory voting" — when one role learns a preference, others can confirm/refine it
- Smarter memory retrieval (currently dumps the whole project; later: query-driven)
- Multi-user workspace memory (when cf² is used by teams; preferences may be per-user not per-workspace)

---

## Open questions for review

(Captured here for iter-6 kickoff. Not blocking the PA design baseline.)

1. **Verb shape** ✅ RESOLVED 2026-04-28: `cfcf spec [task...]` (top-level, peer to `cfcf review` / `cfcf reflect` / `cfcf document`). `cfcf help architect` was rejected: PA is a first-class SDLC role, not a help-namespace concept. `cfcf workspace plan` was rejected: PA's work is creative role output, not workspace-lifecycle admin, AND "plan" collides with `plan.md` (Solution Architect's output). See §"Verb shape" at the top of this doc.

2. **PA agent default**:
   - `productArchitectAgent` defaults to `architectAgent`'s adapter (broad context, strong reasoning)
   - Or: defaults to `devAgent` (HA's choice — interactive Q&A profile)
   - **Lean**: architect agent default. PA's spec-iteration workload is closer to architect's "review + plan" profile than dev's "implement + test" one.

3. **PA model default**:
   - HA defaults to Haiku (Q&A workload). PA is more substantive — spec iteration, multi-turn reasoning, judgement calls.
   - **Lean**: Sonnet for claude-code (HA = Haiku; PA = Sonnet). For codex, account-default + `/fast` hint same as HA.

4. **`--bootstrap` mode flag vs separate verb**:
   - `cfcf spec --bootstrap` (one verb, mode flag)
   - `cfcf workspace bootstrap` (different verb)
   - **Lean**: mode flag. Same role, same agent, same memory; the bootstrap step is the FIRST iteration of a normal PA session.

5. **AGENTS.md/CLAUDE.md sentinels**:
   - cf² already uses `<!-- cfcf:begin --> ... <!-- cfcf:end -->` sentinels in iteration-time CLAUDE.md/AGENTS.md (at repo root). PA's files at `cfcf-docs/AGENTS.md` should use the same convention so user content outside the markers is preserved.
   - Open: should the PA-managed file be ENTIRELY cf²-owned (no user content) so we can rewrite it freely? Or should we allow user customisation via additional content outside the sentinels?
   - **Lean**: allow user customisation outside sentinels (consistent with the rest of cf²'s file-management posture).

6. **Hand-off mechanics**:
   - When PA finishes, does it:
     - (a) just exit and tell the user to run `cfcf review` / `cfcf run`?
     - (b) offer to launch the next role for the user (with permission)?
   - **Lean**: (a) for v1. Cleaner separation; user explicitly chooses the next step. Revisit if dogfood says (b) is friction-free.

7. **Memory-merge with HA**:
   - PA writes user preferences to `cfcf-memory-global`. HA reads from the same project. What if HA's stored preferences contradict PA's?
   - **Lean**: most-recent-wins (timestamp-based) for v1. Add a "preference history" view in iter-7 so users can see / edit conflicting entries.

---

## What we explicitly considered but left out

- **Per-tool MCP servers** for capabilities like "search Clio", "read workspace state". Heavy infrastructure; the agent's existing bash tool can already invoke `cfcf clio search` etc. Defer to a future iteration if the bash-shell-out approach hits real limits.
- **PA-as-a-service** (server-side PA endpoint, called from web UI). v1 PA is CLI only, mirroring HA. Web button comes after CLI dogfood.
- **Templated Problem Pack starters** (industry-specific or framework-specific scaffolds). Useful product feature, not architectural; deferable.

---

## Glossary

- **Problem Pack** — the four user-owned Markdown files in `cfcf-docs/`: `problem.md`, `success.md`, `process.md`, `constraints.md`. The user (or PA on their behalf) writes them; cf² agents read them every iteration.
- **Solution Architect** — the existing cf² role (`cfcf review`) that reviews the Problem Pack + workspace state and emits a readiness verdict + plan outline. PA writes the Problem Pack; Solution Architect reviews it. Different jobs, sequential roles.
- **Pattern A / Pattern B** — the two system-prompt-injection mechanisms documented in `help-assistant.md` §"Alternative approaches considered". A = ephemeral tempfile + `model_instructions_file`; B = durable `AGENTS.md` / `CLAUDE.md` auto-load + `--cd`.
- **`cfcf-memory-pa` / `cfcf-memory-global`** — Clio Projects scoping the role-specific + cross-role persistent context. Convention recorded in HA's design doc and decisions log.
