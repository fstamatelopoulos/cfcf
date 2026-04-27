# Clio — cross-workspace memory (quick reference for agents)

You have access to **Clio**, cf²'s persistent memory layer that holds knowledge from your sibling workspaces. Use it when you hit a question that past iterations or other workspaces may have already answered.

## Invoking Clio

```bash
# Search (default: FTS keyword; top 10 hits; all Clio Projects)
cfcf clio search "your question here"

# Scope to a named Clio Project (grouping of related workspaces)
cfcf clio search "your question" --project cf-ecosystem

# Filter by role / artifact-type via exact-match metadata JSON
cfcf clio search "auth" --metadata '{"role":"reflection","tier":"semantic"}'

# Top 5 hits + raw JSON
cfcf clio search "query" --match-count 5 --json

# Retrieve a specific document by id (returned in search hits)
cfcf clio docs get <document-id>

# List Clio Projects
cfcf clio projects

# Stats (counts, active embedder, migrations)
cfcf clio stats

# Metadata-only: filter docs by metadata keys (no FTS query) + key discovery
cfcf clio metadata search --filter '{"role":"reflection"}'
cfcf clio metadata keys
```

## Verb structure

The CLI follows a three-clause rule (see `cli-verb-normalisation.md`):

- **Top-level**: collection-wide / Clio-wide / headline operations →
  `cfcf clio search | audit | reindex | stats`.
- **Under a noun namespace**: verbs that operate on a specific noun-instance →
  `cfcf clio docs {list,get,ingest,edit,delete,restore,versions} <id>`,
  `cfcf clio projects {list,create,show}`,
  `cfcf clio embedder {list,active,install,set}`.
- **Under a sub-concept namespace**: scoped operations →
  `cfcf clio metadata {search,keys}`.

If you can't remember the exact form, `cfcf clio --help` and `cfcf clio
docs --help` (etc.) print the canonical surface.

## What's in Clio

Clio is automatically populated at iteration boundaries by cf²:
- **reflection-analysis**: cross-iteration strategic reviews from the reflection agent.
- **architect-review**: readiness assessments + gap lists from the Solution Architect.
- **iteration-summary**: compact end-of-iteration summary (dev summary + judge verdict + reflection health).
- **decision-log entries** tagged `[category: lesson | strategy | resolved-question | risk]`.
- Under `clio.ingestPolicy = "all"`: also iteration-log + iteration-handoff + full judge-assessment per iteration.

It is also populated by the user (via `cfcf clio docs ingest`) with design guidelines, domain-knowledge notes, research notes, ADRs, onboarding material, etc.

## When to search

- You're about to make a non-obvious decision → search for past lessons in the same domain.
- Tests are flaking in a specific way → search for the symptom.
- Architect flagged a risk that sounds familiar → search for prior occurrences.
- You need to understand a constraint that originated elsewhere → search for the background.

## Valid metadata filters

| Key | Values |
|---|---|
| `role` | `dev` · `judge` · `architect` · `reflection` · `documenter` · `user` · `cfcf` |
| `artifact_type` | `iteration-log` · `iteration-handoff` · `judge-assessment` · `reflection-analysis` · `architect-review` · `decision-log-entry` · `iteration-summary` · `design-guideline` · `domain-knowledge` · `research-note` · `adr` · `onboarding` · `reference` · `note` · or any user-supplied string |
| `tier` | `semantic` (curated, cross-iteration transfer-friendly) · `episodic` (raw trace) |
| `workspace_id` | cf² workspace id |
| `workspace_name` | cf² workspace name |

## What you do NOT need to do

- You do **not** need to ingest anything yourself. cf² auto-ingests iteration outputs after each phase commits.
- You do **not** need to handle deduplication — Clio dedups by sha256 of the full content.
- You do **not** need to know the embedder or chunking details — just search.
