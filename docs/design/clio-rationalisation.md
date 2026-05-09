# Item 6.9 — Rationalising Clio usage across agent roles

> Design doc for item 6.9. Started 2026-05-09 on
> `iteration-6/clio-rationalisation-6.9`.

## Problem

Clio (cf²'s local SQLite memory layer with FTS + hybrid search) shipped
in item 5.7 and has been extended through 5.11–5.13 (versioning,
soft-delete, audit, edit-metadata) and 6.18 (web UI). It works, agents
*can* use it via `cfcf clio search` and `cfcf clio docs ingest`, and
the iteration loop already auto-ingests reflection / architect /
iteration-summary docs after each phase commits.

But: **the iteration agents themselves don't know about Clio.** None
of the role-instruction templates (`cfcf-architect-instructions.md`,
`cfcf-judge-instructions.md`, `cfcf-documenter-instructions.md`,
`cfcf-reflection-instructions.md`, `process.md` for dev) mention Clio.
The standalone `clio-guide.md` exists and is referenced from the
context-assembler's "What to Read" list — but it's a Tier-2 cue card,
not directives baked into each role's primary instructions. Agents
that haven't been given an explicit "search Clio before doing X" rule
default to reading repo files with grep + their existing context bag.

The user-facing concern (item 6.9, reframed 2026-05-02): we're not
getting the cross-workspace transfer benefit Clio was built for.
Reflection writes lessons. Architect writes risks. Decision-log
captures lessons. All ingested. Nothing reads them.

This doc is the design for fixing that — primarily through
instruction-template additions, with a small structural piece around
per-workspace memory projects.

## What's already in place (audited 2026-05-09)

✅ **`cf-system-*` namespace + system-project locks** (item 6.18 round-2):

| Project | Owner | Purpose |
|---|---|---|
| `cf-system-default` | cfcf | Auto-route fallback when `workspace.clioProject` is unset |
| `cf-system-memory-global` | All roles + user | Cross-workspace knowledge + user preferences |
| `cf-system-pa-memory` | Product Architect | PA per-workspace memory (workspace-summary + per-session scratchpads) |
| `cf-system-ha-memory` | Help Assistant | HA cross-session Q&A history |

Edit + delete locked at the backend (`LocalClio.editProject` /
`deleteProject` throw on these names). Auto-created at boot via
`ensureSystemProjects()`. Single-source-of-truth constants in
`packages/core/src/clio/system-projects.ts`.

✅ **Auto-ingest at iteration boundaries** (`packages/core/src/clio/loop-ingest.ts`):

- `ingestReflectionAnalysis` — after reflection completes
- `ingestArchitectReview` — after architect re-review
- `ingestDecisionLogEntries` — appended decision-log entries
- `ingestIterationSummary` — compact end-of-iteration synthesis
- Under `clio.ingestPolicy = "all"`: also iteration-log + iteration-handoff + full judge-assessment

Each ingest is stamped with the canonical actor `<role>|<agent>|<model>`.
Routes to the workspace's `clioProject` (user-pickable) or
`cf-system-default` if unset.

✅ **Pre-iteration Clio context preload** (`writeClioRelevant`): every
iteration generates `cfcf-docs/clio-relevant.md` with top-k hits matched
against `problem.md`. Agents reading the iteration's context get a
pre-curated set of Clio matches without having to run a query.

✅ **Web UI Memory tab** (item 6.18) — full surface for users to browse,
search, ingest, audit, manage Projects, restore from trash.

✅ **Audit log for mutations** — every `ingest` / `update` / `delete` /
`restore` / `edit-metadata` is recorded with the actor stamp.

## What's NOT in place (the actual gaps)

❌ **None of the iteration-role templates mention Clio.** Agents don't
know:
   - That Clio exists.
   - When to search it.
   - When to ingest into it.
   - Which Project to write to.
   - The actor-stamp convention.

❌ **No per-workspace memory Project convention.** Today
`workspace.clioProject` defaults to undefined → fallback to
`cf-system-default`, which is shared across every unscoped workspace.
There's no isolated per-workspace bucket where this workspace's lessons
accumulate over its lifetime. (The implicit auto-ingest goes to the
workspace's `clioProject` if set, else to the shared default.)

❌ **No standardised search-before-decide heuristics.** Each role makes
its own call about whether to search; in practice that means none of
them search.

❌ **System projects appear in user pickers** (workspace-creation
"Change Clio Project" dialog, etc.) — partially addressed (Memory
page's Projects tab shows them with a `(system)` badge), but the
project-picker dropdown still lists everything unfiltered.

❌ **No read-audit log** — search / docs-get hits aren't recorded. Hard
to answer "which roles search Clio most often?" or "which queries
return zero hits?". Cerefox parity gap.

## Design

### 1. Memory tier model

We're standardising on **three memory tiers** the agents know about by
name. The user's brainstorm has these baked in:

**Global (cross-workspace)** — `cf-system-memory-global`
- Knowledge that should transfer across every project the user runs.
- Examples: user preferences ("user prefers TypeScript", "Pacific time
  zone"), broadly-applicable lessons ("opus + tool-heavy roles tends
  to over-edit", "always commit before bun-link to avoid stale
  embedded web bundle"), product-design heuristics that aren't
  domain-specific.
- Read by: every role on every iteration.
- Written by: any role when they hit something durable + portable.

**Per-workspace memory** — NEW: `cf-workspace-<workspace-id>` (auto-created)
- Knowledge specific to ONE workspace, accumulated across multiple
  iterations and multiple `cfcf run` sessions over the lifetime of
  the workspace.
- Examples: design constraints discovered while solving this problem,
  failed approaches that didn't work in this codebase, the
  user's specific quirks for THIS project ("user wants tests
  co-located, not in `__tests__/`"), patterns the dev figured out in
  iteration 3 that iteration 8 needs to remember.
- Read by: every role in the workspace, on every iteration.
- Written by: any role when the knowledge is workspace-bound.

**Iteration-scoped (already exists)** — auto-ingested with
`tier: "episodic"` metadata
- Per-iteration raw trace (iteration-log, iteration-handoff,
  judge-assessment, reflection-analysis).
- Routes to whichever Project the workspace ingests into (the
  per-workspace project after this change).
- Read across iterations of the same workspace; not generally read
  cross-workspace.

The existing `cf-system-pa-memory` and `cf-system-ha-memory` stay as
specialised PA / HA memory and don't change behaviour. The four
existing system projects remain.

### 2. Per-workspace project convention

**Current default**: `workspace.clioProject = undefined` →
auto-ingest routes to `cf-system-default`.

**Proposed default**: at `cfcf workspace init` time, auto-create a Clio
Project named `cf-workspace-<workspace-id>` and set the workspace's
`clioProject` to that name. The user can still override via the
"Change Clio Project" dialog (e.g. to share memory across a related
group of workspaces — `cf-team-foo`).

`cf-system-default` stays as the **safety-net** fallback for back-compat
with existing workspaces that have no `clioProject` set; new workspaces
won't land there.

Agents read a **fixed pair of projects** per query:
- The workspace's effective project (`clioProject` or
  `cf-workspace-<id>`)
- `cf-system-memory-global`

This gives them workspace-specific + cross-workspace knowledge in one
search without the user having to explicitly scope.

The `cf-workspace-*` prefix is **not** added to the system-project
lock list — workspaces are user-deletable (and the Project should go
with them when the workspace is deleted, eventually). That's a
different naming convention than `cf-system-*`.

### 3. Search-before-decide pattern (the canonical agent guidance)

Every iteration role gets a new "Use Clio before deciding" section in
its instructions, with a role-tuned set of triggers:

**Dev** (`process.md`):
- Before introducing a new dependency / framework / pattern → search
  the workspace + global memory for prior decisions on similar choices.
- When a test flakes in a non-obvious way → search the symptom + the
  failing test name.
- When an architectural decision feels familiar → search before
  re-deriving.
- After making a decision worth remembering → ingest a short note as
  a `decision` or `lesson` to the per-workspace project (or global if
  it's a portable preference).

**Judge** (`cfcf-judge-instructions.md`):
- Before flagging a regression → search for prior occurrences of the
  same pattern (was it a known flake? a previously-decided trade-off?).
- After noticing a recurring pattern across iterations → ingest as
  a `risk` or `observation` to the per-workspace project.

**Solution Architect** (`cfcf-architect-instructions.md`):
- Before scoping a new phase → search for the user's preferences on
  similar problems (estimation style, what they consider "MVP").
- Before flagging a risk → search for prior occurrences in this
  workspace and globally.
- After producing a review → the auto-ingest covers the architect-review
  artefact; the architect doesn't ingest manually.

**Reflection** (`cfcf-reflection-instructions.md`):
- Before identifying a strategic shift → search for prior reflections
  in the same domain.
- After producing the analysis → the auto-ingest covers the
  reflection-analysis artefact; reflection doesn't ingest manually.
- However: reflection is the natural author of `lesson` and `strategy`
  decision-log entries — those auto-ingest as part of the decision-log
  hook. No new behaviour, just emphasis.

**Documenter** (`cfcf-documenter-instructions.md`):
- Before writing a section → search for the user's tone / style
  preferences from prior workspaces (kept in global memory).
- Doesn't generally ingest; the docs themselves are the artefact and
  they live in `docs/` not Clio.

**Product Architect** (already wired via `cf-system-pa-memory`):
- Reads `cf-system-memory-global` for user preferences across
  workspaces. Already does this; `cf-system-pa-memory` adds per-workspace
  PA scratchpads.

**Help Assistant** (already wired via `cf-system-ha-memory`):
- Reads global + per-workspace for user-context. Already wired.

### 4. Ingest patterns (what each role writes vs reads)

Most ingest paths are already covered by the iteration-loop's auto-ingest
hooks. The new instruction-template guidance focuses on **two paths**:

**On-demand ingest** (rare): when the agent decides a fact is worth
remembering AND the auto-ingest paths don't capture it. Examples:
- Dev figured out a non-obvious environment quirk that future
  iterations of THIS workspace should know → ingest to per-workspace
  project as `tier: "semantic"`, `artifact_type: "lesson"`.
- Reflection notices a user-preference pattern across multiple
  workspaces ("user dislikes long planning iterations, prefers
  shipping early") → ingest to global project.

**Decision-log entries** (already auto-ingested): the existing
decision-log hook picks up tagged entries. Roles should be told the
canonical tag categories (`lesson`, `strategy`, `risk`, `observation`,
`resolved-question`) so the auto-ingest's metadata is useful.

**Heuristic**: agents should default to the existing auto-ingest paths
(write to `cfcf-docs/decision-log.md`, write to the iteration-log,
etc.) rather than directly invoking `cfcf clio docs ingest`. The
auto-ingest gets the actor stamp, the project routing, and the
metadata right. Direct `cfcf clio docs ingest` is reserved for the
rare "I have something that doesn't fit any auto-ingested artefact"
case.

### 5. Search guidance — Clio vs grep

This is the explicit heuristic the templates will spell out:

| Searching for… | Use… |
|---|---|
| A symbol or string in the **current codebase** | `grep` (exact, fast, no context overhead) |
| A pattern across **iteration-logs / decision-log / reflection-reviews** in the current workspace | Either, but Clio's hybrid search is faster on a large workspace + handles paraphrases (`"flaky test"` matches a doc that says `"intermittent failure"`) |
| Knowledge from **prior workspaces** | Clio (only Clio has cross-workspace data) |
| **User preferences** from previous projects | Clio, scoped to `cf-system-memory-global` |
| A **known-keyword** match in cf²'s own docs | Either; `cfcf help <topic>` is faster for the in-shell guides |
| A **conceptual question** ("how should I think about X?") | Clio with a natural-language query — semantic search degrades gracefully to FTS when the embedder isn't installed |

The default Clio invocation in role instructions:

```bash
cfcf clio search "<natural-language question>" --match-count 5
```

Without `--project`, Clio searches across all projects. For the
workspace-scoped case the agent passes
`--project cf-workspace-<id>,cf-system-memory-global` (note: needs
support for a comma-separated project list — see §7 implementation).

### 6. Project-picker filtering

User-facing pickers (workspace-creation Clio Project dropdown,
"Change Clio Project" dialog, Memory sidebar's Project filter) should
hide the `cf-system-*` namespace from the **selectable** list — they
remain visible in the Memory tab's Projects tab where the user can
inspect them. Currently the Projects tab shows them with a `(system)`
badge but the pickers don't filter. This is part of the original 6.9
scope; we'll wire the filter as part of this PR.

The `cf-workspace-<id>` project IS selectable but shouldn't be
necessary in normal flows — it's the workspace's own bucket and the
user usually wants to either keep it as-is (default) or pick a shared
team/project name (e.g. `cf-team-foo`) for cross-workspace grouping.

### 7. Read-audit (deferred decision)

Cerefox's `usage_log` records every search + docs-get with the
requestor + query. cfcf's audit log records mutations only.

**Decision: defer to a follow-up.** Rationale:
- Adding read-audit doubles the audit volume + introduces a privacy
  question (do we log the query text? agent prompts may quote
  problem.md content; some workspaces will have sensitive context).
- The cross-role pattern guidance shipped here is the actual user value;
  read-audit is internal observability for analytics that we don't
  have a current consumer for.
- If we ship read-audit later we'll want a config flag to disable it
  (privacy-conscious users) + a separate retention policy.

Tracked as a future Backlog item (`F.X — Clio read-audit log + privacy
gating`). Not in scope for the 6.9 PR.

## Per-role Clio interaction matrix

The actual instructions we'll bake into each role's template, organised
by **action** (read vs write) and **mechanism** (auto-ingested by the
loop vs direct call from the agent). The "Mechanism" column is the
load-bearing one: most ingest paths are already automatic — the agents
just need to know **what to write to which canonical file** and the
loop's auto-ingest hooks pick it up. Direct `cfcf clio docs ingest` is
reserved for the rare cross-workspace-portable case that doesn't fit
any auto-ingested artefact.

### Default Clio Project routing (post-Phase-2)

- **Per-workspace project** = `cf-workspace-<workspace-id>` (auto-created
  at `cfcf workspace init`, auto-routed by `loop-ingest.ts`).
- **Global memory project** = `cf-system-memory-global` (cross-workspace,
  hand-curated by all roles + the user).
- **PA-specific** = `cf-system-pa-memory` (PA's own per-workspace
  scratchpad + workspace-summary).
- **HA-specific** = `cf-system-ha-memory` (HA's Q&A history).

When a role searches without a `--project` filter, Clio searches all
projects (back-compat behaviour). When the agent wants the recommended
"workspace + global" pair, it passes
`--project cf-workspace-<id>,cf-system-memory-global` (multi-project
search added in Phase 2).

### Write matrix — what each role produces, and where it lands

| Role | Trigger | What they write | Canonical destination | Mechanism |
|---|---|---|---|---|
| **All iteration roles** | Every run | Tagged entries appended to `cfcf-docs/decision-log.md` (`[lesson]`, `[risk]`, `[observation]`, `[strategy]`, `[resolved-question]`) | per-workspace project | Auto-ingest (`ingestDecisionLogEntries`) |
| **All iteration roles** | Discovered cross-workspace-portable user preference (e.g. "user prefers vertical-slice tests", "always commit before bun-link") | Short note via `cfcf clio docs ingest --project cf-system-memory-global --author "<role-stamp>" --tier semantic --artifact-type lesson` | global memory | **Direct** (no auto path) |
| **Dev (`process.md`)** | Every iteration | `cfcf-docs/iteration-logs/iteration-N.md` (curated changelog) | per-workspace project | Auto-ingest (`ingestIterationLog` under `clio.ingestPolicy = "all"`) |
| **Dev** | Every iteration | `cfcf-docs/iteration-handoff.md` (forward-looking notes for next iteration's dev) | per-workspace project | Auto-ingest (`ingestIterationHandoff` under "all") |
| **Dev** | Decision worth remembering (env quirk, failed approach, "we tried X, didn't work") | `decision-log.md` `[lesson]` entry — describe what was tried, what failed, what worked instead | per-workspace project | Auto-ingest |
| **Judge** | Every iteration | `cfcf-docs/judge-assessment.md` | per-workspace project | Auto-ingest (under "all" policy) |
| **Judge** | Every iteration | `cfcf-docs/cfcf-judge-signals.json` → loop synthesises an iteration-summary doc | per-workspace project | Auto-ingest (`ingestIterationSummary`, ALWAYS — not gated by ingestPolicy) |
| **Judge** | Notices regression / recurring flake / drift across iterations | `decision-log.md` `[risk]` or `[observation]` entry | per-workspace project | Auto-ingest |
| **Solution Architect** | Every review (pre-loop, refine_plan, manual) | `cfcf-docs/architect-review.md` | per-workspace project | Auto-ingest (`ingestArchitectReview`) |
| **Solution Architect** | Plan-level decision (technology pick, scope-out, phase split) | `decision-log.md` `[decision]` entry | per-workspace project | Auto-ingest |
| **Solution Architect** | User-stated architecture preference that's portable ("user always wants vertical slices over horizontal layers") | Direct ingest to global memory | global memory | **Direct** |
| **Reflection** | Every reflection run | `cfcf-docs/reflection-reviews/reflection-N.md` | per-workspace project | Auto-ingest (`ingestReflectionAnalysis`) |
| **Reflection** | Strategic shift detected (loop is drifting; recommend pivot) | `decision-log.md` `[strategy]` entry | per-workspace project | Auto-ingest |
| **Reflection** | Cross-iteration lesson that's portable across workspaces ("opus + tool-heavy roles tends to over-edit") | Direct ingest to global memory as `lesson` | global memory | **Direct** |
| **Documenter** | After SUCCESS (or `cfcf document`) | Polished docs in `docs/` of the user's repo | — (the docs ARE the artefact; they live in the repo, not Clio) | None |
| **Documenter** | Discovered docs-style preference ("user wants Mermaid diagrams, not ASCII") | Direct ingest to global memory | global memory | **Direct** |
| **Product Architect** (`cfcf spec`) | Every session | `<repo>/.cfcf-pa/session-<id>.md` (live scratchpad) | `cf-system-pa-memory` | Already wired (PA prompt-assembler + memory protocol) |
| **Product Architect** | Session end ("save before you go?") | `cf-system-pa-memory` workspace-summary refresh | `cf-system-pa-memory` | Already wired |
| **Product Architect** | User stated a portable preference ("I always want a 'glossary' section in problem.md") | Direct ingest to global memory | `cf-system-memory-global` | Already wired |
| **Product Architect** | Problem-Pack-level decision (scope cut, success-criteria change) | `decision-log.md` `[decision]` entry — flows to per-workspace project | per-workspace project | Auto-ingest (PA runs in the user's repo with full FS access) |
| **Help Assistant** (`cfcf help assistant`) | Every turn | Q&A history append | `cf-system-ha-memory` | Already wired |
| **Help Assistant** | User stated a portable preference | Direct ingest to global memory | `cf-system-memory-global` | Already wired |

### Read matrix — when each role searches Clio

The agents already get a top-k preload via `cfcf-docs/clio-relevant.md`
(generated by `writeClioRelevant` at iteration boundary, matched
against `problem.md`). The role-specific triggers below are for
**additional, on-demand** searches when the preload isn't enough.

| Role | Search trigger | Query shape | Project scope |
|---|---|---|---|
| **All iteration roles** | Pre-curated context (preloaded into every iteration) | — | — (read `cfcf-docs/clio-relevant.md` directly) |
| **All iteration roles** | About to introduce a new dependency / framework / pattern | `"<dependency name> OR <pattern name>"` | workspace + global |
| **All iteration roles** | About to flag a risk that sounds familiar | `"<risk description>"` | workspace + global |
| **All iteration roles** | About to make a stylistic choice (commit message style, test naming, comment density) | `"user preference <topic>"` | global only |
| **Dev** | Test flaking in non-obvious way | `"<failing test name> OR <symptom>"` | workspace |
| **Dev** | About to add or replace a tool | `"<tool name>"` + global | workspace + global |
| **Judge** | Before flagging a regression — was it a known flake? | `"<symptom>"` | workspace |
| **Judge** | Recurring pattern across N iterations — has reflection seen this before? | `"<pattern description>"` | workspace |
| **Solution Architect** | Before scoping a new phase | `"user prefers <approach>"` / `"prior architect on <problem domain>"` | global + workspace |
| **Solution Architect** | Before flagging a risk | `"<risk pattern>"` | workspace + global |
| **Reflection** | Before identifying a strategic shift | `"<symptom> OR <approach>"` reflections | workspace |
| **Reflection** | Cross-iteration lesson — does it apply globally? | `"<pattern>"` | global (decide whether to also write back) |
| **Documenter** | Before writing a section | `"docs style preference <topic>"` | global |
| **Product Architect** | Spec authoring — has this user expressed preferences on this kind of problem before? | `"<problem-domain> preferences"` | global + cf-system-pa-memory |
| **Help Assistant** | Each user query | The query itself (semantic search over recent Q&A) | cf-system-ha-memory + global |

### Constraints (what NOT to do — go in `clio-guide.md`)

- **Never purge** (`cfcf clio docs delete --hard` not available to agents). Soft-delete only; restore is reversible.
- **Don't ingest secrets / credentials / API keys** — Clio is plaintext SQLite, not encrypted. If you find them in scope, scrub them or skip the ingest.
- **Don't ingest large transient files** (full log files, raw stdouts > 50 KB). Decision-log entries are short summaries, not raw traces.
- **Always pass `--author "<role>|<agent>|<model>"` on direct ingest** so the audit log + future analytics can attribute writes correctly. Auto-ingest paths handle this for you.
- **Don't search every turn** — token + latency cost. The preloaded `clio-relevant.md` handles the "I just want some context" case; on-demand search is for specific triggers.
- **Don't write the same lesson twice** — Clio dedups by sha256 of full content, but you should still phrase deliberately. If a prior search returned the lesson, you don't need to re-ingest it.

## Implementation plan

Two phases. Phase 1 is the bulk of the user-visible work; phase 2 is
the structural per-workspace-project + picker filtering.

### Phase 1 — Instruction template additions (the main delivery)

Edit each role-instruction template to add:

1. A **"Use Clio for context"** section near the top of "What to Read"
   — a 2-3 sentence reminder that Clio holds cross-workspace knowledge
   AND the workspace's accumulated memory, with the canonical search
   command + the role's specific triggers.

2. A **"When to write to Clio"** section in "What to Produce" — emphasising
   that auto-ingested artefacts (decision-log entries, iteration-log,
   reflection-analysis) are the primary write surface; direct
   `cfcf clio docs ingest` is for the rare leftover case.

3. The **canonical search heuristic table** (Clio vs grep) referenced
   from the role's instructions but *not duplicated* — single source
   in `clio-guide.md` (already referenced from each role's "What to
   Read" via context-assembler), expanded with the new table.

4. The **memory-tier mental model** (global / per-workspace /
   episodic) injected from `clio-guide.md`.

Templates touched (the four iteration-role templates + dev's
`process.md`):
- `cfcf-architect-instructions.md`
- `cfcf-judge-instructions.md`
- `cfcf-reflection-instructions.md`
- `cfcf-documenter-instructions.md`
- `process.md` (dev role)

`clio-guide.md` gets the new sections (memory tiers, search heuristic
table, role-specific cheat sheets).

### Phase 2 — Per-workspace Project auto-create + picker filter

1. **`cfcf workspace init`**: when the user doesn't explicitly pass
   `--project <name>`, auto-create `cf-workspace-<workspace-id>` and set
   it as the workspace's `clioProject`. Existing workspaces unchanged.
2. **Picker filter**: hide `cf-system-*` from the
   workspace-creation Clio Project dropdown + the "Change Clio
   Project" dialog. They remain visible in the Memory page's Projects
   tab + accessible via `cfcf clio projects list`.
3. **Multi-project search**: extend `cfcf clio search` to accept a
   comma-separated `--project` list so an agent can search both its
   per-workspace project AND `cf-system-memory-global` in one call.
4. **Auto-ingest routing**: confirm `loop-ingest.ts` correctly resolves
   the workspace's project (already does — `resolveClioProject` reads
   `workspace.clioProject?.trim() || DEFAULT_PROJECT`).

### Phase 3 — Tests + docs

- Unit tests for the per-workspace-project auto-create path (fresh
  workspace gets a `cf-workspace-<id>` project; existing workspaces
  unchanged).
- Tests for the multi-project search path.
- Update the `clio-quickstart.md` guide with the memory-tier model.
- Update CLAUDE.md with the per-workspace-project convention.

## Out of scope (intentionally)

- **Read-audit log** — deferred (see §7).
- **Cerefox remote-backend adapter** — original 6.9 framing; the
  `MemoryBackend` interface already exists for it. Ship if/when a
  Cerefox-backed cf² is wanted.
- **Embedder swap UI from the role templates** — embedder management
  stays user-driven via Settings → Model registry / `cfcf clio
  embedder install`. Agents use whatever's active.
- **PA / HA memory protocol changes** — `cf-system-pa-memory` and
  `cf-system-ha-memory` stay as-is; the global memory project they
  read is now ALSO the global memory project iteration roles read.

## Risks + mitigations

- **Agents over-search.** Every Clio call costs a few hundred ms +
  tokens to read the result. Mitigation: the role triggers are
  specific ("before introducing a new dep", "before flagging a
  regression") — not blanket "search every turn". The clio-relevant.md
  pre-load already gives them a top-k baseline without a query.
- **Agents under-ingest.** They'll skip the on-demand ingest path
  because the heuristic is fuzzy. Mitigation: lean on the existing
  auto-ingest paths; the on-demand ingest is genuinely rare.
- **`cf-workspace-<id>` proliferation.** Every new workspace gets its
  own project. After 50 workspaces the picker has 50 entries.
  Mitigation: hide them from the picker by default (only the
  user-pickable shared-grouping projects stay visible — same idea as
  the system-project filter); they remain accessible via the Memory
  tab + CLI.
- **Privacy** — embedded queries could leak problem.md content if
  read-audit ships naively. Already deferred to a separate item with
  an explicit privacy gate.

## Effort estimate

- Phase 1 (template additions + clio-guide.md expansion): ~1 session.
- Phase 2 (workspace-init auto-create + picker filter + multi-project
  search): ~1 session.
- Phase 3 (tests + docs): ~0.5 session.

Total: ~2.5 sessions. Phase 1 alone is shippable as the headline
delivery; Phase 2 is the structural cleanup; Phase 3 is housekeeping.

## Open questions for the user

1. **Per-workspace project name**: `cf-workspace-<workspace-id>` (UUID
   suffix, opaque) vs `cf-workspace-<sanitised-workspace-name>`
   (human-readable, can collide if workspace names collide). Lean
   toward the UUID form for collision-safety; the user rarely needs to
   type this name. Confirm?

2. **Auto-create on existing workspaces**: when the user upgrades to
   the version with this change, should existing workspaces (with
   `clioProject` unset, currently routing to `cf-system-default`)
   migrate to a `cf-workspace-<id>` project? Or stay as-is until the
   user manually changes them? Lean toward staying as-is (no mass
   migration; new workspaces get the new default; users can pick
   explicitly via the Change dialog if they want).

3. **Multi-project `--project` syntax**: `--project a,b,c` (comma)
   vs `--project a --project b --project c` (repeated flag). Lean
   toward comma-separated for terseness in agent prompts; commander.js
   needs a small parser tweak.

4. **Phase rollout**: ship Phase 1 + Phase 2 in the same PR (one
   v0.23.0 release with all the guidance + the structural change), or
   split (Phase 1 → v0.23.0, Phase 2 → v0.23.1)? Lean toward one PR
   since the guidance references the structural pieces.
