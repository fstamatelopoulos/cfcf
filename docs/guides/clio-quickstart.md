# Clio quickstart

Clio is cf²'s **cross-workspace memory layer**. Every role agent (dev, judge, architect, reflection, documenter) can write knowledge into Clio at iteration boundaries; every role agent can search it during a run. Workspaces that share a **Clio Project** see each other's memory; workspaces in different Projects stay isolated.

This quickstart covers Clio as it stands on the iteration-5 work (items 5.7 + 5.11 + 5.12 + 5.13). Originally shipped in v0.9.0 (item 5.7) as three logical sub-PRs: PR1 (FTS + chunker + CRUD + CLI), PR2 (embedders + hybrid search), PR3 (iteration-loop auto-ingest + context preload). Iter-5 follow-ups added: update-doc API + version snapshots (5.11), agent-parity API surface (5.12, including doc-level search default + Cerefox-style alpha-weighted hybrid), audit log + soft-delete (5.13).

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
cfcf clio docs ingest path/to/design-notes.md \
  --project backend-services \
  --title "Auth service design" \
  --artifact-type design-guideline \
  --tier semantic \
  --tags auth,api
```

Or pipe from stdin:

```bash
cat notes.md | cfcf clio docs ingest --stdin --project backend-services --title "Auth design"
```

Content is **sha256-dedup'd** across the whole DB — re-ingesting the same file is a no-op and returns the existing document id.

## Search

```bash
# Search using the configured default mode (auto: hybrid if an embedder
# is active, else fts).
cfcf clio search "flaky async auth tests"

# Force a specific mode.
cfcf clio search "flaky async auth tests" --mode hybrid     # α-weighted blend of FTS + vector (default α=0.7)
cfcf clio search "flaky async auth tests" --alpha 0.3        # bias toward keyword (FTS) match
cfcf clio search "flaky async auth tests" --by-chunk         # raw chunk-level results (default is doc-level)
cfcf clio search "flaky async auth tests" --mode semantic   # vector cosine only
cfcf clio search "flaky async auth tests" --mode fts        # keyword only

# Tune the noise floor (raw cosine threshold for the vector branch in
# hybrid + every result in semantic; FTS-matched chunks bypass it in
# hybrid). Default 0.5 (Cerefox parity); lower = wider recall.
cfcf clio search "auth" --min-score 0.4

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
cfcf clio projects show cf-ecosystem   # description, doc count, timestamps
cfcf clio docs list                   # list documents (newest first; --project, --limit, --json)
cfcf clio docs list --project cf-ecosystem
cfcf clio stats                       # DB size, counts, active embedder, migrations
cfcf clio docs get <document-id>           # fetch + reconstruct full content from chunks
cfcf clio docs get <document-id> --version-id <uuid>   # fetch an archived version
cfcf clio docs get <document-id> --raw     # content only (no header) for scripts
cfcf clio docs versions <document-id>      # list archived versions, newest first
```

## Update an existing document (item 5.11, Cerefox parity)

Re-ingesting the same content as an existing doc returns `action: "skipped"` (the PR1 hash dedup). To explicitly **update** a doc — i.e. replace its content while archiving the prior version — use one of the two update flags:

```bash
# Title-based update (within the same Project). Mirrors Cerefox `update_if_exists=true`.
cfcf clio docs ingest design-notes.md --project backend-services --title "Auth design" --update-if-exists --author claude-code

# UUID-based update (deterministic; errors if the doc isn't found).
# Mirrors Cerefox `document_id=<uuid>`. Wins over --update-if-exists if both passed.
cfcf clio docs ingest design-notes.md --project backend-services --title "Auth design" --document-id 3f57ff7f-66e7-421a-9303-9fb5754983b0
```

When an update happens:

- The prior chunks are snapshotted into a new row in `clio_document_versions` (sequential `version_number`).
- The doc's `content_hash`, `title`, `metadata`, `chunk_count`, `total_chars`, `updated_at` are rewritten.
- Search (FTS + vector) returns the new content; the archived version is excluded from indexes but remains retrievable.
- The CLI prints the snapshot's `version_id` + `version_number` so you can recall the prior content via `cfcf clio docs get <id> --version-id <uuid>`.

### Metadata-only edit (5.13 follow-up)

For changes that don't touch content -- renaming, moving between Projects,
adding metadata keys -- use `cfcf clio docs edit`. **No version snapshot
is taken**: versions exist to protect chunks/content, and metadata edits
don't touch chunks. The audit log carries a before/after diff.

```bash
# Rename
cfcf clio docs edit <id> --title "New name"

# Move to a different Clio Project
cfcf clio docs edit <id> --project cfcf

# Add / remove metadata keys (incremental; other keys survive)
cfcf clio docs edit <id> --set-meta reviewed_by=fotis --set-meta status=approved
cfcf clio docs edit <id> --unset-meta draft

# Combine; --actor attributes the edit in the audit log
cfcf clio docs edit <id> --title "Renamed" --project cfcf --actor claude-code
```

The recommended agent workflow mirrors Cerefox's:

```
cfcf clio search "topic"
  → note the doc id (look in --json output today; copy-pasteable [id: uuid] rendering coming in 5.12)
cfcf clio docs get <id>
  → modify content offline
cfcf clio docs ingest modified.md --project <p> --title "<same title>" --document-id <id> --author "<your name>"
```

## Where things live

- **Clio DB**: `~/.cfcf/clio.db` (override via `CFCF_CLIO_DB`). Cross-workspace state, same tier as `~/.cfcf/logs/`.
- **Workspace Clio assignment**: `clioProject` on the workspace config at `<cfcf-config-dir>/workspaces/<id>/config.json`. `cfcf workspace show <name>` prints it.

## Capabilities today

| Capability | Status |
|---|---|
| Doc-level search dedup (default; Cerefox parity) | ✅ shipped 5.12 -- one row per matching doc with `versionCount` + `matchingChunks`. `--by-chunk` for raw view |
| FTS5 keyword search | ✅ works out of the box |
| Vector + hybrid (α-weighted blend) search | ✅ once an embedder is installed (default: nomic-embed-text-v1.5 q8). `clio.hybridAlpha` defaults to 0.7 (Cerefox parity); per-call `--alpha` overrides. |
| Cerefox-style cosine threshold (`--min-score`, `clio.minSearchScore`) | ✅ default 0.5; FTS-matched chunks bypass in hybrid |
| Small-to-big chunk expansion | ✅ |
| Embedder install / list / set / **set --reindex** | ✅ (default `cfcf clio embedder install` resolves from `clio.preferredEmbedder`) |
| `cfcf clio reindex` | ✅ idempotent, batched, per-Project; pair with `embedder set --reindex` for safe model switches |
| `cfcf clio docs list` | ✅ (newest first; `--project`, `--limit`, `--offset`) |
| Iteration-loop auto-ingest (reflect, architect, decision-log, iteration-summary) | ✅ |
| `cfcf-docs/clio-relevant.md` preload into agent context | ✅ |
| `cfcf-docs/clio-guide.md` agent cue card | ✅ |
| Web UI Clio settings (default search mode, min score, preferred embedder readout) | ✅ on the Server Info page |
| Update API: `--update-if-exists` + `--document-id` + version snapshots + `cfcf clio docs versions <id>` | ✅ shipped 5.11 |
| Soft-delete + restore: `cfcf clio docs delete <id>` + `cfcf clio docs restore <id>` (idempotent) | ✅ shipped 5.11 |
| `author` field threaded through writes + reads + audit (Cerefox parity) | ✅ shipped 5.12 |
| `cfcf clio metadata search` + `cfcf clio metadata keys` (discovery) | ✅ shipped 5.12 |
| Search-result `[id: <uuid>]` rendering for the search → ingest agent loop | ✅ shipped 5.12 |
| `cfcf clio audit` + `GET /api/clio/audit-log` (mutations only; reads not logged) | ✅ shipped 5.13 |
| `cfcf clio docs edit` + `PATCH /api/clio/documents/:id` (metadata-only edit, no version snapshot) | ✅ shipped 5.13 follow-up |
| sqlite-vec HNSW (replaces brute-force cosine) | tracked under 6.15; needs the 5.5 installer infra |
| Web UI Clio tab (browse projects + docs in the GUI) | tracked under 6.18 |
| Remote Cerefox backend (`MemoryBackend` interface ready) | future iteration |

## Turning on hybrid search

FTS keyword search works immediately with no setup. `cfcf init` (default flow) prompts you to pick an embedder and downloads it inline — by the time init exits, hybrid + semantic search are ready.

If you skipped the embedder during init, you can install one later:

```bash
# Downloads the model from HuggingFace on first run; cached to
# ~/.cfcf/models/ so subsequent runs start cold-load-free.
# No-arg form picks up clio.preferredEmbedder from the global config
# (set during init); falls back to the catalogue default.
cfcf clio embedder install
cfcf clio embedder install nomic-embed-text-v1.5     # explicit

# Confirm:
cfcf clio embedder active

# Now hybrid search is the auto default:
cfcf clio search "flaky auth tests"                  # mode = hybrid
```

**Switching embedders requires a reindex.** Each chunk's embedding is tied to the model that produced it; swapping models invalidates every existing embedding. The safe path is:

```bash
cfcf clio embedder set bge-small-en-v1.5 --reindex   # atomic switch + re-embed every chunk
```

`--reindex` re-embeds existing chunks under the new model in batched transactions. The legacy `--force` flag still exists for recovery scenarios but prints a warning about degraded vector search until you separately run `cfcf clio reindex`. **Default to `--reindex`.**

## Embedder ↔ chunk-size alignment

The chunker's chunk size is owned by the embedder manifest, not user config. `bge-small-en-v1.5` ships with a 1800-char chunk target + ±2 neighbor small-to-big expansion. `nomic-embed-text-v1.5` ships with 7000 chars + ±1. These numbers are tuned so each chunk fits within the model's context window + the small-to-big expansion gives agents coherent passages. Do not try to override them via config.

## Design references

- Main design: [`docs/design/clio-memory-layer.md`](../design/clio-memory-layer.md)
- Research precursor: [`docs/research/cross-project-knowledge-layer.md`](../research/cross-project-knowledge-layer.md)
- Implementation decisions made during the build: [`docs/research/clio-implementation-decisions.md`](../research/clio-implementation-decisions.md)
- Cerefox (upstream schema + chunker): [github.com/fstamatelopoulos/cerefox](https://github.com/fstamatelopoulos/cerefox)

## Search modes + the threshold (in detail)

`cfcf clio search` (and `GET /api/clio/search`) resolve the search mode in this order:

1. Per-call `--mode` flag (`?mode=` query param).
2. `clio.defaultSearchMode` in the global config — settable via the web UI's "Clio memory layer" section or by editing the config file.
3. `auto` (the built-in default), which resolves at request time: active embedder present → `hybrid`; absent → `fts`.

Set `clio.defaultSearchMode` to a concrete value (`fts` / `semantic` / `hybrid`) only if you want to force that mode regardless of embedder state — useful for FTS-only setups that want predictable behaviour.

The `min-score` threshold (`--min-score` flag, `?min_score=` query param, `clio.minSearchScore` config) is the cosine floor for the **vector branch** of hybrid search and for **every** result of semantic search. FTS-matched chunks in hybrid mode bypass it (they've already proven keyword relevance). Default 0.5 — calibrated for OpenAI's embedders by Cerefox; cfcf inherits the same default but bge-small / nomic-q8 may need tuning. Lower for wider recall, higher for stricter precision. See [`docs/decisions-log.md`](../decisions-log.md) entry "Hybrid search threshold (Cerefox port)" for rationale.
