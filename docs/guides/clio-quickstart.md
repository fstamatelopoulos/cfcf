# Clio quickstart

Clio is cf²'s **cross-workspace memory layer**. Every role agent (dev, judge, architect, reflection, documenter) can write knowledge into Clio at iteration boundaries; every role agent can search it during a run. Workspaces that share a **Clio Project** see each other's memory; workspaces in different Projects stay isolated.

This quickstart covers what's in cf² today (item 5.7 PR1). Embeddings + hybrid search land in PR2; iteration-loop auto-ingest + context preload lands in PR3.

## Mental model

- **cf² workspace** = one managed git repo (same as today).
- **Clio Project** = named grouping of workspaces in the same knowledge domain. Examples: `cf-ecosystem` for cf² + Clio + Cerefox code, `backend-services` for a handful of TypeScript API repos, `research` for exploratory projects.
- A workspace belongs to **exactly one Clio Project**. The assignment is captured on the workspace config (`clioProject`) and used to route auto-ingests + scope search queries.
- If you never set a Project, cf² auto-routes to a Project named `default` the first time something tries to ingest.

## Set up a workspace with a Clio Project

```bash
# Interactive: pick from existing Projects or create a new one.
cfcf workspace init --repo /path/to/repo --name my-api

# Non-interactive: pass the Project name directly.
cfcf workspace init --repo /path/to/repo --name my-api --project backend-services
```

Change it later:

```bash
# Future ingests go to the new Project; old docs stay under the old Project.
cfcf workspace set my-api --project new-project-name

# Same, but re-key existing docs into the new Project too.
cfcf workspace set my-api --project new-project-name --migrate-history
```

## Ingest a Markdown doc

```bash
cfcf clio ingest path/to/design-notes.md \
  --project backend-services \
  --title "Auth service design" \
  --artifact-type design-guideline \
  --tier semantic \
  --tags auth,api
```

Or pipe from stdin:

```bash
cat notes.md | cfcf clio ingest --stdin --project backend-services --title "Auth design"
```

Content is **sha256-dedup'd** across the whole DB — re-ingesting the same file is a no-op and returns the existing document id.

## Search

```bash
# Keyword search across every Clio Project (FTS5 in v1).
cfcf clio search "flaky async auth tests"

# Scope to one Project.
cfcf clio search "retrieval patterns" --project cf-ecosystem --match-count 5

# Filter by metadata (exact match on JSON fields).
cfcf clio search "auth" --metadata '{"role":"judge","tier":"semantic"}'

# Raw JSON for piping into jq / scripts.
cfcf clio search "auth" --json | jq '.hits[0].docTitle'
```

## Inspect

```bash
cfcf clio projects                    # list all Clio Projects + doc counts
cfcf clio project show cf-ecosystem   # description, doc count, timestamps
cfcf clio stats                       # DB size, counts, active embedder, migrations
cfcf clio get <document-id>           # fetch a document by id
```

## Where things live

- **Clio DB**: `~/.cfcf/clio.db` (override via `CFCF_CLIO_DB`). Cross-workspace state, same tier as `~/.cfcf/logs/`.
- **Workspace Clio assignment**: `clioProject` on the workspace config at `<cfcf-config-dir>/workspaces/<id>/config.json`. `cfcf workspace show <name>` prints it.

## What PR1 ships vs. what's coming

| Capability | PR1 (today) | PR2 | PR3 |
|---|---|---|---|
| FTS5 keyword search | ✅ | ✅ | ✅ |
| Vector / hybrid search | ❌ (falls back to FTS) | ✅ sqlite-vec + bge-small + RRF | ✅ |
| Small-to-big chunk expansion | ❌ | ✅ | ✅ |
| Embedder install / switch (`cfcf clio embedder ...`) | ❌ | ✅ | ✅ |
| Iteration-loop auto-ingest (reflect, architect, decision-log, iteration-summary) | ❌ | ❌ | ✅ |
| `cfcf-docs/clio-relevant.md` preload into agent context | ❌ | ❌ | ✅ |
| `cfcf-docs/clio-guide.md` agent cue card | ❌ | ❌ | ✅ |
| `cfcf clio reindex` | ❌ | v2 | v2 |
| Audit log + versioning + soft-delete | ❌ (table shapes present) | v2 | v2 |
| Remote Cerefox backend | ❌ | ❌ | v3+ |

## Design references

- Main design: [`docs/design/clio-memory-layer.md`](../design/clio-memory-layer.md)
- Research precursor: [`docs/research/cross-project-knowledge-layer.md`](../research/cross-project-knowledge-layer.md)
- Implementation decisions made during the build: [`docs/research/clio-implementation-decisions.md`](../research/clio-implementation-decisions.md)
- Cerefox (upstream schema + chunker): [github.com/fstamatelopoulos/cerefox](https://github.com/fstamatelopoulos/cerefox)

## A note on embedders (coming in PR2)

When PR2 lands, the active embedder (default: `bge-small-en-v1.5`, 384 dims) will be **locked at install time**. Switching embedders after ingestion poisons the vector corpus (dimension mismatch + token-window differences break old chunk boundaries). PR2 gates `cfcf clio embedder set <new>` with a full-reindex requirement, and the chunk-size default is picked by the embedder's manifest, not by user config. You don't have to think about this in PR1 — there's no embedder yet — but it's why the user guide will grow an "embedder effectively immutable after first ingest" section.
