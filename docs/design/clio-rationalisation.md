# Item 6.9 — Rationalising Clio usage across agent roles

> Design doc for item 6.9. Started 2026-05-09 on
> `iteration-6/clio-rationalisation-6.9`. **All open questions
> resolved 2026-05-09**; implementation can proceed.

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
  failed approaches that didn't work in this codebase, the user's
  specific quirks for THIS project ("user wants tests co-located, not
  in `__tests__/`"), patterns the dev figured out in iteration 3 that
  iteration 8 needs to remember, AND **PA's per-workspace memory file**
  (`PA-memory.md`, see "PA / HA memory simplification" below).
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

#### PA memory simplification (refined 2026-05-09)

Round-1 of this design kept `cf-system-pa-memory` as the dual-purpose
home for PA's per-workspace AND cross-workspace memory. **Refined**:

- `cf-system-pa-memory` keeps **only PA's cross-workspace state** —
  PA-specific role preferences, workflow heuristics PA learned across
  multiple workspaces, the agent-side stuff that's portable.
- PA's **per-workspace memory** (workspace-summary, session
  scratchpads, decisions made about THIS workspace's Problem Pack)
  moves into the workspace's own `cf-workspace-<id>` project as a
  `PA-memory.md` document. PA reads + writes this file the same way
  the dev role reads + writes iteration-log.md.
- Effect: when iteration roles search "cf-workspace-<id> +
  cf-system-memory-global" they pick up PA's workspace context too;
  PA's workspace-bound knowledge stops being siloed in a
  PA-only-readable project.

#### HA memory (kept, with staleness disclaimer)

The user raised a real concern: HA's saved Q&A history can go stale as
cf² evolves (an answer about feature X that's accurate today may be
wrong next month after the feature changes).

**Decision: keep `cf-system-ha-memory`, address staleness in HA's
prompt.** Reasoning:
- HA still benefits from cross-session conversation continuity ("you
  asked about X yesterday, here's a follow-up").
- HA still benefits from persisting user preferences ("user prefers
  terse explanations").
- HA's **answers** are synthesised fresh each turn from current docs +
  state — HA doesn't quote saved answers verbatim. The risk is
  bounded.

**Staleness mitigation in HA's prompt** (Phase 1):
- "Saved Q&A history is for conversation continuity, not as
  authoritative. Always verify against current docs / state before
  quoting an old answer."
- HA's saved entries get a `cfcfVersion` stamp so HA can deprioritise
  hits from older versions.

Drop is on the table for a later iteration if the staleness concern
turns out to bite in practice — for now, keep + warn.

The four existing system projects remain. **Lock list unchanged**:
`cf-system-default`, `cf-system-memory-global`, `cf-system-pa-memory`,
`cf-system-ha-memory`. The new `cf-workspace-<id>` projects are NOT
locked (workspaces are user-deletable; the project should go with the
workspace eventually — separate cleanup item).

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

### 3a. Default ingest policy (DECIDED 2026-05-09)

The `clio.ingestPolicy` global config field today defaults to
`"summaries-only"` (auto-ingests iteration-summary +
reflection-analysis + architect-review + decision-log entries; skips
iteration-log + iteration-handoff + full judge-assessment).

**Flipped to `"all"` in this PR.** Storage is cheap (~20-50 KB per
iteration); searchable full history across months is high-value
(matches the multi-loop-over-time use case where users come back to
the same workspace later). Existing workspaces auto-pick-up the new
default since none have an explicit override; with the clean wipe the
user is doing first, this is the cleanest moment to flip.

### 3b. Pre-iteration `clio-relevant.md` query (documented)

Each iteration generates `cfcf-docs/clio-relevant.md` via
`writeClioRelevant()` in `loop-ingest.ts`. The query is built from the
**first ~40 words of `problem.md`** (whitespace-normalised, punctuation
stripped, words ≤ 2 chars filtered out). It runs:

1. A **broad** semantic+FTS hybrid search across ALL Clio Projects,
   top-5 hits.
2. For each of `reflection-analysis` and `architect-review`
   artefact-types: a **scoped** search restricted to the workspace's
   own project, top-3 hits.

Result is rendered as a markdown doc with hit content, headings, and
scores. Agents read this file as part of Tier-2 context.

**Improvement opportunity** (not in this PR): the query could include
the current iteration's task description from `plan.md` (the next
pending `[ ]` item) for task-specific matches instead of
problem-domain-only matches. Track as a Backlog item if dogfood
suggests it's missing things.

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

### 6a. Grep-vs-Clio guidance (the rule for agents)

A clean rule based on TASK rather than source-of-truth:

| Task | Tool | Why |
|---|---|---|
| Read a specific known file (`decision-log.md`, `iteration-log-3.md`, `problem.md`, `architect-review.md`) | **Disk** (`cat` / Read tool) | Local, fast, full content. **Fresher than Clio for current-iteration files** — auto-ingest fires at iteration boundary; disk has the latest writes. |
| Search across THIS workspace's history (decisions, lessons, prior iterations on a topic) | **Clio** scoped to `cf-workspace-<id>` | Hybrid semantic+FTS handles paraphrases ("flaky" matches "intermittent"); results ranked by relevance. |
| Search across PRIOR workspaces (cross-workspace patterns, user preferences) | **Clio** scoped to `cf-system-memory-global` | Only Clio has cross-workspace data. |
| Search **code** in the current repo (symbols, function usages, imports) | **grep** | Clio doesn't index code; iteration logs may *mention* a symbol but the source itself isn't there. |

**No fallback chain** — they cover different ground. If Clio returns no
hits for `"caching decisions"`, the answer is *"no prior caching
decisions"*, not *"now grep what's already auto-ingested"* (the
workspace's `cfcf-docs/*` files ARE in Clio; grep would find the same
nothing because it's the same content).

**One exception** — current-iteration files written by THIS very run.
Auto-ingest happens at iteration boundary, so an agent reading its own
decision-log entries from earlier in the same iteration → disk (the
filesystem has the latest writes; Clio has the previous iteration's
snapshot until this iteration commits + the next iteration boots).

This rule goes in `clio-guide.md` as a top-level rubric, referenced
from each role template.

### 7. Audit log + usage log (REVISED 2026-05-09 — IN SCOPE FOR THIS PR)

Cerefox's `usage_log` records every read (search + docs-get) AND every
write (mutation). cfcf's `clio_audit_log` today records mutations
only — reads are invisible.

**Decision: implement Cerefox's two-table model verbatim.** After
inspecting Cerefox's schema (2026-05-09), the right design is clear —
**adopt the two-table split** rather than extending `clio_audit_log`
with read events.

#### Cerefox's two-table design (the reference)

Cerefox has TWO tables, distinct purposes:

**`cerefox_audit_log`** (mutations only — current cf² parity):
```
id, document_id, version_id, operation, author, author_type,
size_before, size_after, description, created_at
```
- Operations: `create`, `update-content`, `update-metadata`,
  `delete`, `status-change`, `archive`, `unarchive`
- Per-document scope; tracks WHAT changed about a doc + size deltas
  + free-form description
- Lens: "how has this doc evolved?"

**`cerefox_usage_log`** (reads AND writes — operational log):
```
id, logged_at, operation, access_path, requestor,
document_id, project_id, query_text, result_count, extra (JSONB)
```
- Operations include: `search`, `get_document`, `list_versions`,
  `list_projects`, `metadata_search`, `list_metadata_keys`,
  `get_audit_log`, `ingest`, `update-metadata`, `status-change`
- `access_path`: `'cli'` | `'webapp'` | `'local-mcp'` | `'remote-mcp'`
  | `'edge-function'`
- `requestor`: actor stamp (`<role>|<agent>|<model>` for cf²) or
  `'user'`
- `query_text`: search query (when applicable)
- `result_count`: hits returned
- Lens: "who's calling Clio and what are they asking?"

The same write event (`ingest`) appears in **both** tables — different
filters in the UI, different consumers. Cerefox also has a
`cerefox_usage_summary` RPC that returns aggregate JSON for analytics
dashboards (ops by day, by operation, by access_path, top documents,
top requestors).

Cerefox gates `usage_log` writes with a `cerefox_config.usage_tracking_enabled`
flag (off by default; opt-in). For cf² we'll keep it **always on** —
single-user space, no privacy gating needed — but preserve the
column structure so a future `CerefoxRemote` backend swap-in stays
clean.

#### cf² implementation

1. **Keep `clio_audit_log` as-is** (mutations only — already mirrors
   Cerefox).
2. **Add a sibling `clio_usage_log` table** mirroring Cerefox's
   schema:
   ```sql
   CREATE TABLE clio_usage_log (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     logged_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
     operation    TEXT NOT NULL,
     access_path  TEXT NOT NULL,    -- 'cli' | 'web' | 'agent-cli'
     requestor    TEXT,              -- actor stamp '<role>|<agent>|<model>' OR 'user'
     document_id  TEXT REFERENCES clio_documents(id) ON DELETE SET NULL,
     project_id   INTEGER REFERENCES clio_projects(id) ON DELETE SET NULL,
     query_text   TEXT,
     result_count INTEGER,
     extra        TEXT                -- JSON; latency, zero-hits flag, etc.
   );
   CREATE INDEX idx_usage_log_logged_at  ON clio_usage_log (logged_at DESC);
   CREATE INDEX idx_usage_log_operation  ON clio_usage_log (operation, logged_at DESC);
   CREATE INDEX idx_usage_log_requestor  ON clio_usage_log (requestor) WHERE requestor IS NOT NULL;
   CREATE INDEX idx_usage_log_document   ON clio_usage_log (document_id) WHERE document_id IS NOT NULL;
   ```
3. **Hooks** in `LocalClio` for every public read + write method:
   - Reads: `searchFts`, `searchHybrid`, `searchSemantic`, `getDocument`,
     `listVersions`, `listProjects`, `searchMetadata`, `listMetadataKeys`,
     `getAuditLog`.
   - Writes: existing `ingest` / `updateContent` / `updateMetadata` /
     `softDelete` / `restore` (already log to `clio_audit_log`; add a
     usage-log mirror).
   - All hooks fire-and-forget (try/catch swallow); usage logging
     never blocks the actual operation.
4. **`access_path` plumbing**:
   - `cli` — direct `cfcf clio …` invocations from the user's shell.
   - `agent-cli` — `cfcf clio …` invocations from inside an agent's
     spawn (detected via the existing actor-stamp; if `requestor` is
     a role-stamp it's `agent-cli`).
   - `web` — every `/api/clio/*` HTTP call.
5. **CLI surface**:
   ```
   cfcf clio audit                   # mutations only (today's behaviour, unchanged)
   cfcf clio usage                   # reads + writes (NEW)
   cfcf clio usage --reads           # filter to reads
   cfcf clio usage --writes          # filter to writes
   cfcf clio usage --actor "<stamp>" # who-did-what
   cfcf clio usage --zero-hits       # search queries that returned nothing
   cfcf clio usage --since 1d        # time window
   cfcf clio usage --json
   ```
   Plus aggregate command (mirrors Cerefox's `usage_summary` RPC):
   ```
   cfcf clio usage summary --since 7d
   ```
6. **HTTP surface**: `GET /api/clio/usage` and `GET /api/clio/usage/summary`
   with the same filter shapes.

**`get_document`** etc. via the web's `DocumentDetail` panel = `web` access path; via the dev's
`cfcf clio docs get` = `agent-cli` access path. The same lens that
shows up in `cerefox_usage_log` gives us "who is reading what".

**Out of scope for this PR (separate plan items)**:
- Web UI for usage-log browsing (item TBD in the plan; the Memory
  page's existing Audit tab gets a "Usage" sibling tab + read-event
  filters).
- Cerefox `usage_log` field-by-field alignment review (Backlog item
  `F.X`) — schema may want micro-tweaks once we ship + run side-by-
  side.

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

### Universal ingest principles (the rules every role's template gets)

These apply across every role and are surfaced in `clio-guide.md` as
the universal rules. The role-specific templates reference them by
pointer.

1. **The harness auto-ingests the canonical files you write** — when
   you append to `decision-log.md`, write `iteration-log.md`, write
   `architect-review.md` etc., the next loop-boundary auto-ingest
   hook picks it up with the correct actor stamp + project routing.
   You don't need to call `cfcf clio docs ingest` for these.
2. **When in doubt, ingest.** The cost of an extra Clio doc is ~20 KB
   of disk; the cost of a future agent re-deriving a lesson because
   it's not in Clio is way higher. If you discover something useful
   for a future iteration of THIS workspace OR a future workspace,
   write it down — either as a `decision-log.md` entry (auto-ingests
   to the per-workspace project) or via direct `cfcf clio docs
   ingest` to `cf-system-memory-global` for portable preferences.
3. **Always pick the right project.** Rules:
   - Workspace-specific knowledge (decisions about THIS problem,
     lessons from THIS codebase) → per-workspace project
     (`cf-workspace-<id>`, also the auto-ingest default).
   - Cross-workspace-portable knowledge (user preferences, broadly-
     applicable lessons) → `cf-system-memory-global`.
   - **Never leave the project blank** — auto-routing falls back to
     `cf-system-default` (a shared catch-all) which makes searches
     noisy. Your workspace already has its `cf-workspace-<id>`
     project configured; reference it by name when you ingest
     directly.
4. **Always pass `--update-if-exists`** on direct ingest of "live"
   files (decision-log.md, PA-memory.md, anything that grows over
   time and should stay as a single Clio doc). Without the flag,
   each ingest creates a NEW Clio doc — you end up with 50 copies of
   `decision-log.md` at different points in time. The auto-ingest
   paths set this flag for you; only direct calls need it explicit.
5. **Always pass `--author "<role>|<agent>|<model>"`** on direct
   ingest. Auto-ingest paths set this for you. The audit log + future
   analytics filter on this stamp; missing or inconsistent stamps
   make your writes invisible to those filters.
6. **Search before deciding.** When you face a non-obvious choice,
   search Clio FIRST in the workspace + global projects. Often the
   user (or a prior agent) has already decided this; re-deriving
   wastes a turn.

### Write matrix — what each role produces, and where it lands

| Role | Trigger | What they write | Canonical destination | Mechanism |
|---|---|---|---|---|
| **All iteration roles** | Every run | Tagged entries appended to `cfcf-docs/decision-log.md` (`[lesson]`, `[risk]`, `[observation]`, `[strategy]`, `[resolved-question]`, `[decision]`) — single growing file, ingested as ONE Clio doc with `--update-if-exists` so the doc stays canonical | per-workspace project | Auto-ingest (`ingestDecisionLogEntries`) |
| **All iteration roles** | Discovered cross-workspace-portable user preference (e.g. "user prefers vertical-slice tests", "always commit before bun-link") | Short note via `cfcf clio docs ingest --project cf-system-memory-global --author "<role-stamp>" --tier semantic --artifact-type lesson` | global memory | **Direct** (no auto path) |
| **Dev (`process.md`)** | Every iteration | `cfcf-docs/iteration-logs/iteration-N.md` (curated changelog) | per-workspace project | Auto-ingest (`ingestIterationLog` under `clio.ingestPolicy = "all"`) |
| **Dev** | Every iteration | `cfcf-docs/iteration-handoff.md` (forward-looking notes for next iteration's dev) | per-workspace project | Auto-ingest (`ingestIterationHandoff` under "all") |
| **Dev** | Decision worth remembering (env quirk, failed approach, "we tried X, didn't work") | `decision-log.md` `[lesson]` entry — describe what was tried, what failed, what worked instead | per-workspace project | Auto-ingest |
| **Judge** | Every iteration | `cfcf-docs/judge-assessment.md` (live file overwritten per iteration) PLUS the loop archives a per-iteration copy at `cfcf-docs/iteration-reviews/iteration-N.md` | per-workspace project | Auto-ingest of the per-iteration archive (separate Clio doc per iteration) under default `"all"` policy |
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
- **Always pass `--update-if-exists` on direct ingest of growing files** (decision-log.md, PA-memory.md). Auto-ingest paths handle this for you.
- **Don't write the same lesson twice** — Clio dedups by sha256 of full content, but you should still phrase deliberately. If a prior search returned the lesson, you don't need to re-ingest it.

**Note on search frequency**: an earlier draft of this doc included a
"don't search every turn — token cost" constraint. Removed
deliberately. Under-searching is the bigger risk (it's why we're doing
this work). Search liberally; the `cfcf clio audit --reads` log
shipping in the same PR will let us measure actual usage in the
clean-wipe test workspace and add a brake later if needed.

## Implementation plan

Three phases, shipped together in one PR. Phase 1 is the
user-facing template work; Phase 2 is the structural per-workspace-
project + picker filtering + multi-project search; Phase 3 is the
read-audit log + tests + docs. All gated on user testing in the
clean-wipe workspace before merge.

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

### Phase 2 — Structural changes

1. **`cfcf workspace init`**: when the user doesn't explicitly pass
   `--project <name>`, auto-create `cf-workspace-<workspace-id>` and set
   it as the workspace's `clioProject`. Existing workspaces unchanged
   (no migration).
2. **Default ingest policy flip**: `clio.ingestPolicy` default
   changes from `"summaries-only"` → `"all"`. One-line change in
   `loop-ingest.ts`'s `resolveIngestPolicy()` + a CLAUDE.md note.
3. **PA per-workspace memory moves to `cf-workspace-<id>/PA-memory.md`**.
   PA prompt-assembler + memory-protocol layer updated; `cf-system-pa-memory`
   keeps PA's cross-workspace state only.
4. **Picker filter**: hide `cf-system-*` from the
   workspace-creation Clio Project dropdown + the "Change Clio
   Project" dialog. They remain visible in the Memory page's Projects
   tab + accessible via `cfcf clio projects list`.
5. **Multi-project search**: extend `cfcf clio search --project` to
   accept a comma-separated list so an agent can search both its
   per-workspace project AND `cf-system-memory-global` in one call.
   Backend already accepts arrays internally.
6. **Auto-ingest routing**: confirm `loop-ingest.ts` correctly resolves
   the new `cf-workspace-<id>` projects (existing
   `resolveClioProject` reads `workspace.clioProject?.trim() ||
   DEFAULT_PROJECT` — already correct).

### Phase 3 — Usage-log + tests + docs

1. **`clio_usage_log` table** (Cerefox parity — see §7 of the design):
   - Schema migration adding the `clio_usage_log` table with the
     Cerefox-mirroring shape (`logged_at`, `operation`, `access_path`,
     `requestor`, `document_id`, `project_id`, `query_text`,
     `result_count`, `extra`).
   - Hooks in every `LocalClio` public read + write method
     (fire-and-forget; never blocks the operation).
   - `access_path` plumbing across `cli` / `agent-cli` / `web`
     callers.
   - **CLI**: `cfcf clio usage` (with `--reads` / `--writes` / `--actor` /
     `--zero-hits` / `--since` filters) + `cfcf clio usage summary`.
   - **HTTP**: `GET /api/clio/usage` + `GET /api/clio/usage/summary`.
   - `clio_audit_log` keeps its existing scope (mutations only); both
     tables coexist, different filters in the UI.
2. **HA staleness disclaimer**: small prompt update in
   `packages/core/src/help-assistant/prompt-assembler.ts` (add the
   "saved Q&A is for continuity, not authoritative" line) +
   `cfcfVersion` stamp on saved entries.
3. **Tests**:
   - Unit tests for the per-workspace-project auto-create path.
   - Tests for the multi-project search path (single project and
     multi-project both return expected hits).
   - Tests for read-audit hooks + CLI filters.
   - Tests for the new ingest-policy default.
4. **Docs**:
   - Update `clio-quickstart.md` with the memory-tier model.
   - Update CLAUDE.md with the per-workspace-project convention +
     ingest policy change.
   - Update `clio-guide.md` with the universal ingest principles
     (the 6-rule list).
   - Update `docs/api/server-api.md` with the new audit endpoint
     parameters.

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

## Resolved questions (2026-05-09)

1. **Per-workspace project name** → `cf-workspace-<workspace-id>` (UUID
   suffix, opaque, collision-safe). User rarely types it.

2. **Migration policy for existing workspaces** → no migration. The
   user is wiping `~/.cfcf/clio.db` and starting clean to test the new
   memory model end-to-end. Existing workspaces (none in production
   beyond the user's own dogfood) don't need a backfill path.

3. **Multi-project `--project` syntax** → comma-separated
   (`--project a,b,c`). Commander.js parser tweak: split on comma in
   the action handler; the underlying `searchDocuments(...)` backend
   already accepts an array.

4. **Phase rollout** → one PR. All three phases ship together once
   testing on the clean-wipe workspace confirms the design works.

## Additional design refinements (2026-05-09)

These came out of the Clio-interaction-matrix review:

5. **Default `clio.ingestPolicy` flips from `"summaries-only"` to
   `"all"`.** Disk is cheap; cross-iteration full-history searches are
   high-value. Existing workspaces auto-pick-up the new default since
   none have an explicit override.

6. **PA's per-workspace memory moves from `cf-system-pa-memory` into
   the workspace's own `cf-workspace-<id>` project as `PA-memory.md`.**
   PA's CROSS-workspace state stays in `cf-system-pa-memory` (PA-only
   patterns + role preferences). This makes PA's workspace knowledge
   visible to iteration roles via the same per-workspace search.

7. **HA memory kept** with a staleness disclaimer baked into HA's
   prompt. Drop is on the table for a later iteration if dogfood shows
   the stale-Q&A risk biting.

8. **Read-audit (`cfcf clio audit --reads`) shipped in this PR**, not
   deferred. The user wants to measure agent Clio usage in the
   clean-wipe test workspace. New `clio_usage_log` table
   (or new event types on `clio_audit_log`; final shape decided at
   implementation review). Schema records timestamp + actor + event
   type + query text + project filter + result count + zero-hits flag
   + latency. CLI: `cfcf clio audit --reads / --writes / --actor X /
   --zero-hits`.

9. **Cerefox usage_log alignment review** = new Backlog item (`F.X`)
   to compare cf²'s read-audit schema field-by-field with Cerefox's
   `usage_log` once the cf² version ships. Not blocking for this PR.

10. **Dropped the "don't search every turn" constraint.**
    Under-searching is the bigger risk; the read-audit log will
    measure actual usage so we can decide if a brake is needed later.
