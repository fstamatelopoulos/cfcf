# Clio — cross-workspace memory (cue card for agents)

Clio is cf²'s persistent SQLite memory layer. It holds knowledge from
this workspace, sibling workspaces, and the user's curated notes. **Use
it.** It is the difference between you re-deriving something the team
already figured out and you picking up where they left off.

## The six universal principles (item 6.9)

1. **Search before you act.** When you face a non-obvious decision, an
   unfamiliar error, a constraint whose origin you don't know, or a
   pattern that sounds vaguely familiar — search Clio first. cf²
   pre-builds `cfcf-docs/clio-relevant.md` for you at the start of
   every iteration / role spawn; read that *before* you read anything
   else from disk. It's a top-k search of the whole memory keyed off
   `problem.md`, so it surfaces the cross-workspace hits your work is
   most likely to need.

2. **Three memory tiers.** Know which one you're working in:

   | Tier         | Project                          | Scope                                                            |
   |--------------|----------------------------------|------------------------------------------------------------------|
   | Global       | `cf-system-memory-global`        | Cross-workspace user preferences + lessons (`always TS`, etc.)  |
   | Per-workspace| `cf-workspace-<workspace-id>`    | Iteration logs, role-authored notes, reflection analyses, etc.   |
   | Iteration    | (no separate project; metadata)  | Single-iteration scratch — set `metadata.iteration: <N>`         |

   Same Clio doc may be tagged with all three signals — the tier is
   the *project*, not a separate field.

3. **Grep vs Clio — pick by task, not by fallback chain.**
   - Known specific file in this repo → `Read` / `cat` / `grep` on disk. Don't go to Clio.
   - Search across THIS workspace's history → Clio in `cf-workspace-<id>`.
   - Search across PRIOR workspaces / cross-cutting lessons → Clio in `cf-system-memory-global` or use no project filter.
   - Code search (find a symbol, a function, a usage) → grep / your editor's symbol index.
   No "if grep fails, try Clio" cascade — that wastes both. Pick the
   right tool the first time.

4. **Tag your writes with `<role>|<agent>|<model>`.** Every Clio
   mutation needs an actor stamp. Examples: `dev|claude-code|sonnet`,
   `architect|codex|gpt-5`, `reflection|claude-code|opus`. Pass it via
   `--author "<stamp>"` on every `cfcf clio docs ingest` and
   `--actor "<stamp>"` on `cfcf clio docs delete/restore/edit`. The
   audit log + analytics filter on this stamp; missing or inconsistent
   stamps make your writes invisible to those filters. (The stamp is
   metadata, not access control — any role can write to any doc.)

5. **Never purge.** When you need to remove a Clio doc, use **only**
   `cfcf clio docs delete <id>` (soft-delete). Soft-delete is
   reversible — the doc moves to a trash bin and `cfcf clio docs
   restore <id>` brings it back. Hard-delete (purge) drops chunks +
   version history irreversibly; it is reserved for user-initiated
   surfaces (the web UI's Trash tab). The server rejects purge
   requests with an agent actor stamp anyway, but your discipline
   should ensure you never try.

6. **Auto-ingest is on; supplement it.** cf² already auto-ingests
   the **problem-pack files** (`problem.md`, `success.md`,
   `constraints.md`, `hints.md`, `style-guide.md`; refreshed each
   iteration with sha256-dedup so unchanged files are no-ops),
   iteration logs, iteration handoffs, judge assessments, reflection
   analyses, architect reviews, decision-log entries, and end-of-
   iteration summaries (gated by `workspace.clio.ingestPolicy`,
   default `all`). You don't need to re-ingest those. **Do** ingest
   anything *outside* the canonical artifact set that future you (or
   future siblings) will want — cross-cutting design notes, an ADR
   you wrote, a research finding, a domain-knowledge dump. Use
   metadata `artifact_type: "design-guideline"` /
   `"domain-knowledge"` / `"research-note"` / `"adr"` etc.

## CLI surface (most-used verbs)

```bash
# Search (default mode is auto: hybrid if an embedder is active, else FTS)
cfcf clio search "your question here"

# Scope — single project, multi-project (comma-separated), or no scope
cfcf clio search "auth" --project cf-workspace-<this-workspace-id>
cfcf clio search "auth" --project cf-system-memory-global,cf-workspace-<this-workspace-id>
cfcf clio search "auth"           # default: every project the user has

# Filter by role / artifact-type via metadata JSON
cfcf clio search "auth" --metadata '{"role":"reflection","artifact_type":"reflection-analysis"}'

# Top 5 hits + raw JSON
cfcf clio search "query" --match-count 5 --json

# Retrieve a specific document by id (returned in search hits)
cfcf clio docs get <document-id>

# Ingest a doc (your role's stamp + the right project)
cfcf clio docs ingest --stdin --project <project> --title "<title>" \
    --metadata '{"role":"<role>","artifact_type":"<type>"}' \
    --author "<role>|<agent>|<model>"

# Inspect: list projects, stats, audit (writes), usage (reads + writes)
cfcf clio projects
cfcf clio stats
cfcf clio audit --document-id <id>
cfcf clio usage --reads --since 2026-05-01T00:00:00Z
```

## Per-role cheatsheets

Each role gets a focused 1-3 line "what to do with Clio this iteration"
in its own instructions file. The patterns below are the defaults:

- **dev** — Read `cfcf-docs/clio-relevant.md` first. Search the
  workspace's project for prior commits / refactors that touched the
  same area. Don't ingest by hand — cf² captures your iteration log
  + handoff automatically.
- **architect** — Read `cfcf-docs/clio-relevant.md`. Before classifying
  readiness, search prior workspaces (`cf-system-memory-global`) for
  similar problem statements; reuse their solution shapes when they
  apply.
- **judge** — Read `cfcf-docs/clio-relevant.md`. Search recent
  iterations of THIS workspace for repeated regressions or known-bad
  patterns; weight your verdict accordingly.
- **reflection** — Read `cfcf-docs/clio-relevant.md`. Search the
  workspace's prior reflections (`metadata.role = reflection`) to spot
  multi-iteration drift; surface it in your analysis. Auto-ingest of
  your reflection-analysis happens after you exit.
- **documenter** — Read `cfcf-docs/clio-relevant.md`. Pull cross-
  iteration design rationale from prior reflection-analyses + the
  decision log; weave it into the final docs.
- **product-architect (interactive)** — Read your `PA-memory.md`
  digest + `pa-global-memory` (already injected). Search the
  workspace's archive of prior PA sessions when the user asks "did we
  decide X" — `cfcf clio search "X" --project cf-workspace-<id>
  --metadata '{"artifact_type":"session-archive"}'`. The problem-pack
  files you edit (`problem.md` / `success.md` / etc.) auto-ingest at
  session end, so you don't need to push them yourself.
- **help-assistant (interactive)** — Read your `cf-system-ha-memory`
  doc list (already injected). Stamp `cfcf_version` in metadata on
  every write so future HA sessions can spot stale entries.

## Valid metadata filters

| Key             | Values                                                              |
|-----------------|---------------------------------------------------------------------|
| `role`          | `dev` · `judge` · `architect` · `reflection` · `documenter` · `pa` · `ha` · `user` · `cfcf` |
| `artifact_type` | `problem-pack` · `iteration-log` · `iteration-handoff` · `judge-assessment` · `reflection-analysis` · `architect-review` · `decision-log-entry` · `iteration-summary` · `workspace-memory` · `session-archive` · `design-guideline` · `domain-knowledge` · `research-note` · `adr` · `onboarding` · `reference` · `note` · or any user-supplied string |
| `filename`      | for `problem-pack` docs: which file (`problem.md` / `success.md` / `constraints.md` / `hints.md` / `style-guide.md`) |
| `tier`          | `semantic` (curated, cross-iteration transfer-friendly) · `episodic` (raw trace) |
| `iteration`     | integer — for iteration-scoped artefacts                            |
| `workspace_id`  | cf² workspace id                                                    |
| `workspace_name`| cf² workspace name                                                  |
| `cfcf_version`  | release tag at write time (HA stamps this for staleness checks)     |

## What you do NOT need to do

- You do **not** need to ingest the canonical iteration artefacts —
  cf² captures iteration logs / handoffs / judge assessments /
  reflections / architect reviews / decision-log entries / iteration
  summaries automatically.
- You do **not** need to handle deduplication — Clio dedups by
  sha256 of the full content.
- You do **not** need to know the embedder or chunking details. Search
  works in FTS mode without an embedder; install one via
  `cfcf clio embedder install` if hybrid / semantic search is wanted.

## What you MUST NEVER do

- **NEVER purge.** Soft-delete only (`cfcf clio docs delete <id>`).
  Reversible via `cfcf clio docs restore <id>`. Purge drops chunks +
  version history irreversibly and is reserved for the user.
- **NEVER write to a `cf-system-*` Clio Project the user didn't
  authorise.** System projects (`cf-system-memory-global`,
  `cf-system-pa-memory`, `cf-system-ha-memory`, `cf-system-default`)
  are cfcf-managed. Iteration-role auto-ingest writes to
  `cf-workspace-<id>` for per-workspace artefacts; cross-workspace
  preferences (PA / HA only) write to `cf-system-memory-global`.
  Don't make up a new system project name.
