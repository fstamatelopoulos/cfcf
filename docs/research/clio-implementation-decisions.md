# Clio (item 5.7) — implementation decisions

**Branch:** `iteration-5/clio`.
**Status:** Working doc for the Clio build. Captures decisions made in the session that kicked off implementation (2026-04-22), on top of [`docs/design/clio-memory-layer.md`](../design/clio-memory-layer.md). This exists so the next session (or a reviewer) sees what we agreed on without re-reading the full design.

---

## Working style

- Commit + push to `iteration-5/clio` as we go. **No PR open** until the author has tested end-to-end.
- Stage into three logical PR-sized chunks (all on the same branch until PR time):
  - **PR1 — foundation** (this checkpoint): schema, migrations, `LocalClio` backend with FTS5-only search, markdown chunker, HTTP + CLI surface, workspace-init `--project` flag, `cfcf workspace set`, auto-ingest not yet wired. Ships something testable: user can ingest docs + search with keyword retrieval.
  - **PR2 — embeddings:** bundle `sqlite-vec` + `onnxruntime-node` + `bge-small-en-v1.5`; turn on hybrid search (RRF over FTS5 + vector) + small-to-big sibling expansion. Handles the macOS `loadExtension` quirk for Bun (see "SQLite driver" below).
  - **PR3 — loop integration:** auto-ingest hooks at reflect / architect / decision-log / end-of-iteration; `cfcf-docs/clio-relevant.md` context preload; `cfcf-docs/clio-guide.md` agent cue card.

## Design-doc open questions (§12.1) closed

1. **Changing a workspace's Clio Project post-init.** `cfcf workspace set --project <new-name>` rewires **future** ingests only. Explicit `--migrate-history` opt-in re-keys existing `clio_documents.project_id` + `clio_chunks.project_id` via a single SQL UPDATE per table. Audit log (v2) records either path.
2. **Empty Clio Project handling.** Workspace with no `clioProject` assigned gets auto-routed to a named `"default"` Clio Project on first ingest. Schema stays NOT NULL on `project_id`. **First time Clio auto-creates `default` we prompt the user:** `"This workspace has no Clio Project set. Create a 'default' Project to hold its memory? (You can set a specific Project later with 'cfcf workspace set --project <name>'.) [y/n]"`. User can rename the default Project later.
3. **`cfcf workspace init --project` prompt wording.** Iterate during implementation. First draft goes through review before the PR opens.
4. **Taxonomy governance (`artifact_type` values).** Permissive — any string accepted. Start with §5.1's table as convention; revisit if fragmentation shows up in the audit log.

## Stack decisions

### SQLite driver: `bun:sqlite` (built-in)

- No extra dep. Ships FTS5 out of the box.
- **PR1 doesn't need `loadExtension` at all** — FTS5 is built in.
- **PR2 hits the macOS quirk**: Bun defaults to Apple's SQLite on macOS, which has extension loading **disabled**. Fix path (decided in PR2): use `Database.setCustomSQLite(path)` to point at a bundled SQLite build (or a user-installed one via Homebrew); fall back to `better-sqlite3` for the vector-search path only if that proves painful. Detection + graceful fallback to FTS5-only mode when vector extension fails to load.

### Embedder bundling: lazy download by default

- Design doc originally preferred "embed-by-default" (220 MB binary) with `CFCF_CLIO_LAZY_DOWNLOAD=1` opt-out.
- **Decision (this session): flip the default.** Embedder model is fetched on first Clio use to `~/.cfcf/models/` (via `@huggingface/transformers`, not pinned GH-Release-URL fetch — the original sha256-verified-download plan was simplified once we pivoted to the npm-format distribution in v0.10.0; model integrity now relies on HuggingFace's hashes). Native binaries (custom libsqlite3 + sqlite-vec) ship inside the per-platform `@cerefox/codefactory-native-<platform>` npm package — not lazy-fetched at runtime. See [`installer-design.md`](installer-design.md) §3.2 for the current shape; this doc captures the original Clio-iteration plan.
- **The download must be seamless.** On first invocation:
  - Print a one-line status: `Clio: fetching embedder (bge-small-en-v1.5, ~120 MB)…`
  - Show progress every ~5%.
  - Verify sha256; refuse mismatch with a clear error.
  - On network failure: retry with exponential backoff ×3, then fall back to FTS5-only mode with a visible warning so the user sees what's degraded, not a silent failure.
- Opt-in to embed-into-binary via `CFCF_CLIO_EMBED_ASSETS=1` at build time for users who want fully offline installs.

### DB location: `~/.cfcf/clio.db`

- Cross-workspace state lives alongside `~/.cfcf/logs/` (which also isn't under the platform-specific config dir for the same reason — it's a shared pool, not per-workspace config).
- Override via `CFCF_CLIO_DB` env (same pattern as `CFCF_CONFIG_DIR` / `CFCF_LOGS_DIR`).

## Workspace-init prompt flow (§12.1 Q4)

When `cfcf workspace init` runs:

1. If `--project <name>` is passed → use it, skip prompt.
2. If no flag AND the user ran this interactively (TTY detected) → prompt:
   - List existing Clio Projects (if any) as numbered choices: `1) cf-ecosystem (12 docs)  2) default (3 docs)`
   - Offer `N) create new…` → ask for a name.
   - Offer `S) skip (use 'default')` → workspace gets `clioProject=undefined`; first ingest auto-creates `default` after prompting per Q2 above.
3. If no flag AND non-interactive (no TTY, e.g. scripted `cfcf workspace init` in CI) → behave as "skip" silently; first ingest does the confirmation dance.

Prompt preamble (first draft, iterate):

```
Workspaces can share memory through a Clio Project — a named grouping of
workspaces in related domains (e.g. "backend-services" for a bunch of
TypeScript API repos, or "cf-ecosystem" for cf² + Clio + Cerefox code).
Searches made inside this workspace see cross-workspace knowledge from
siblings in the same Project; workspaces in different Projects stay
isolated by default.

Which Clio Project should this workspace belong to?
```

## Config additions

### `WorkspaceConfig` new fields

```ts
interface WorkspaceConfig {
  // ... existing fields
  /** Clio Project this workspace is assigned to. Undefined → auto-route to 'default' on first ingest. */
  clioProject?: string;
  /** Per-workspace ingest policy override. Defaults to global config. */
  clio?: {
    ingestPolicy?: "summaries-only" | "all" | "off";
  };
}
```

### `CfcfGlobalConfig` new field

```ts
interface CfcfGlobalConfig {
  // ... existing fields
  /** Global default for Clio ingest policy. `summaries-only` per §5.2. */
  clio?: {
    ingestPolicy?: "summaries-only" | "all" | "off";
  };
}
```

No top-level `clioProject` at the global tier — Project assignment is per-workspace by design.

## What's out of PR1 scope (deferred to PR2 / PR3)

- Any use of embeddings or `sqlite-vec`. PR1's search is FTS5-only; `/api/clio/search?mode=semantic` returns a 501 or falls back to FTS5 with a warning.
- Auto-ingest hooks in the iteration loop. PR1 has `cfcf clio ingest` (manual), and the HTTP `POST /api/clio/ingest`. The loop doesn't call them yet.
- Context-assembly preload (`clio-relevant.md`) and agent cue card (`clio-guide.md`). Landing in PR3 so the content is based on real hybrid search, not degraded FTS5.
- Versioning (`clio_document_versions`), audit log, soft-delete, metadata-search endpoints, reindex. All v2+ per the design doc.
- Embedder CLI (`cfcf clio embedder list/install/set/…`). v2.

## Milestones on this branch

Each milestone = one commit + push. No PR until the author does end-to-end testing.

- [x] `decisions doc` (this file) committed.
- [ ] `schema + migrations runner` — tests pass.
- [ ] `markdown chunker` — tests pass.
- [ ] `LocalClio backend (FTS5-only)` — integration tests cover ingest + search + get + list-projects + stats.
- [ ] `WorkspaceConfig.clioProject + workspace init --project + workspace set` — tests pass.
- [ ] `HTTP /api/clio/*` — server tests cover all endpoints.
- [ ] `CLI cfcf clio *` + `cfcf memory` alias — CLI tests pass.
- [ ] `Docs` (clio-quickstart, workflow + cli-usage updates, CHANGELOG [Unreleased]) — grep clean.
- [ ] `Full test suite + build` — 309 → ~340ish tests, binary builds.
- [ ] Ready for user testing.

## Embedder ↔ chunk-size alignment (PR2 + docs)

Small-context embedders (most open-source ones — bge-small ~512 tokens ≈ 2000 chars, MiniLM ~256 ≈ 1000 chars) will silently truncate content past their window. **Chunks must fit inside the active embedder's context window, or the chunk's tail is invisible to semantic search.** FTS5 is unaffected.

Consequences baked into PR2 + docs:

1. **Chunker becomes embedder-aware, and the chunk size is owned by the embedder manifest, not the user.** Each embedder entry in the catalogue declares its `recommendedChunkMaxChars` + `recommendedExpansionRadius` (e.g. `bge-small-en-v1.5` → 1800 / 2; `nomic-embed-text-v1.5` → 7000 / 1). `cfcf clio embedder install <name>` or `cfcf clio embedder set <name>` locks those values into the active embedder record in `~/.cfcf/clio.db`. The user does **not** see a `chunkMaxChars` knob in the standard cf² config -- getting it wrong would silently break search. If we do expose it anywhere (e.g. for advanced users / dogfooding), it must be (a) under a `clio.advanced.*` namespace in the config, (b) accompanied by a `WARNING: changing this poisons your vector corpus; re-embed after changing (cfcf clio reindex)` comment in the template, and (c) surfaced as an explicit warning on `cfcf clio stats` if the active value differs from the embedder's recommended value.
2. **Embedder lock at install-time.** Switching embedders mid-life would poison the vector corpus (dims change, token-window change breaks old chunk boundaries). Design doc §6.4 already has `cfcf clio reindex` for this, but PR2 ships with a **stronger guardrail**: `cfcf clio embedder set <new>` refuses to proceed if the new embedder has a different dim than what's indexed, unless `--reindex` is passed (which re-embeds everything up-front, atomically). PR1 skips this entirely (no embedder yet); PR2 adds the gate.
3. **Small-to-big parameters become tunable.** Smaller chunks → more neighbors needed for coherent context. Per-call `match_count` + `expansion_radius` (± N siblings) knobs on `cfcf clio search`, with per-embedder defaults: bge-small → expansion_radius=2; nomic → 1. Document the relationship in the user guide.
4. **User-facing docs (clio-quickstart + cli-usage.md + CHANGELOG) must explain:**
   - Which embedder is active and why it matters.
   - That switching embedders requires a full reindex (or breaks search) — frame as "effectively immutable after first ingest" for the v1 mental model.
   - How `chunkMaxChars` and `expansion_radius` trade off (smaller chunks = higher precision, less context per hit; larger chunks = lower precision, more context per hit).
   - Recommended defaults per embedder with a table.

Tracked as part of PR2 implementation. PR1 ships the chunker with a fixed 4000-char default (matching Cerefox); the embedder-aware plumbing lands with the embedder.

## Release target

`v0.9.0` per the design doc (minor bump — Clio is a new core component).
