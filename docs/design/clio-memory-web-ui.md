# Clio Memory web UI — design (item 6.18)

**Status:** in progress on `iteration-6/web-clio-tab`. Builds on the read-only Memory prototype shipped in 6.12.

## Goal

Turn the `/#/memory` page from a "browse + search prototype" (6.12) into a useful day-to-day surface for the **human user** of cfcf — distinct from the agent-facing CLI which is the primary interface for read/write from inside iteration loops.

Two audiences with different needs:

| Surface | Primary user | Primary need |
|---|---|---|
| `cfcf clio …` CLI | Agents (dev/judge/reflection/…) | Cheap deterministic R/W during loop execution |
| Web Memory page | Human dogfooding cfcf | Visibility + occasional maintenance + ad-hoc curation |

The UI doesn't need 1:1 CLI parity. It needs to feel like the right tool for the **human's** workflow: see what's in there, search for things, paste something in by hand, fix or remove a stale entry, see what the agents have been doing.

## Reference: Cerefox web UI

Cerefox (the upstream project Clio is the local-memory migration of) ships a richer web UI. Key features in the Cerefox UI we want to mirror in Clio (per dogfooding feedback + initial Cerefox-parity charter):

- **Search page** with mode picker (docs / hybrid chunks / FTS / semantic), result-type implied by mode, project filter, metadata filters, count selector, expandable result cards
- **Projects page** with list + create + edit (rename/description) + delete
- **Project documents page** (per-project doc list)
- **Document detail page** — header (title/timestamps/counts), metadata table, audit trail, version history, full content (rendered/raw), chunks
- **Ingest page** with paste tab + file-upload tab, metadata fields, "update existing" toggle
- **Document edit page** — full edit (title/projects/metadata/content)
- **Trash page** — list deleted, restore + purge
- **Audit log page** — global view with operation + author filters
- **Analytics page** — usage charts (defer)
- **Metadata search page** — facet-style search

## Scope of this iteration (6.18 first cut)

Build a **useful first version**. Defer Cerefox's heavier features (analytics, full ingest with file upload, full document edit) to a follow-up if dogfooding demands them.

### Page structure

Keep the existing `/#/memory` route. Add a **sub-tab nav** inside the page so the left sidebar (Stats + Projects) remains a persistent rail across all sub-views. Tabs:

| Tab | Built in 6.12 | Built in 6.18 | Notes |
|---|---|---|---|
| **Search** | partial | rebuilt | Standalone surface. Mode + result-type pickers; not coupled to the docs list. |
| **Browse** | yes | extended | Per-project docs list. Click a doc opens detail panel. |
| **Ingest** | no | new | Text-paste only (no file upload yet). Metadata fields. |
| **Audit** | no | new | Global audit log with operation + author + since filters. |
| **Projects** | partial (sidebar) | extended | Add create-new flow; basic list view (rename/delete deferred). |

URL: `#/memory` opens Search by default; `#/memory?tab=<tab>` jumps to a specific sub-view. Sidebar (Stats + Projects filter) stays visible across tabs. Selected project filters Browse + Search + Ingest + Audit when applicable.

### Detailed surface design

#### 1. Search tab (rebuilt)

The current Memory search panel is fine but coupled to the docs list — both visible together. Split: Search becomes its own tab, Browse becomes its own tab.

**Knobs** (mirrors `cfcf clio search` CLI):

- **Query** (text input, autofocus)
- **Mode** dropdown — `auto` (default) / `fts` / `semantic` / `hybrid`. `auto` is the user-facing label for what the API resolves based on embedder presence (see `cfcf clio search --mode` semantics).
- **Result type** dropdown — `documents` (default) / `chunks`. Maps to the API's `?by=doc` (default) vs `?by=chunk` query param. Documents is the shape the agents use; chunks is an "I want to see exactly which sections matched" view.
- **Project** scope — sourced from the sidebar's active project. "(all projects)" means no `?project=` filter.
- **Match count** dropdown — 5 / 10 / 20 / 50 (default 10). Maps to `?match_count=`.

**Result rendering**:

- **Documents mode** — one card per matching doc:
  - Title (clickable → opens Document detail panel)
  - Project name + score + version count + total-chars metadata line
  - Best-chunk heading path breadcrumb (where in the doc the match landed)
  - Snippet — for **small docs** (≤ `clio.smallDocThreshold`, default 20 KB), renders the FULL document body; for **large docs**, renders the matched chunk + `clio.contextWindow` neighbours on each side. Server already does this small-to-big expansion; we just render `bestChunkContent`.
  - "(small doc / partial)" badge next to the snippet so the user can tell which view they're getting

- **Chunks mode** — one card per chunk match:
  - Doc title (link) + heading path
  - Score
  - Chunk content (no small-to-big expansion — chunks mode is for inspecting raw matches)

#### 2. Browse tab (extended from 6.12 docs list)

Per-project paginated documents list. Mostly unchanged from 6.12 except:

- Click a row opens the **Document detail panel** (new — see below) instead of the simple content viewer.
- Add a column for `versionCount` (so users can spot frequently-edited docs).
- Add a soft-delete indicator badge for tombstones if `?deleted_only` ever surfaces in the UI (defer to follow-up).

Sidebar's "Projects" panel keeps its filter behaviour. "All projects" lists everything.

#### 3. Ingest tab (new)

Text-paste only — no file upload in this cut.

**Form**:

- **Title** (required text input)
- **Project** dropdown — populated from existing projects + a "(create new)" sentinel option that swaps to an inline text input (same pattern shipped in 6.12's `ClioProjectDialog`). Defaults to the sidebar's active project, or "default".
- **Source** (optional text — defaults to "web-paste"). Maps to the `source` field on `clio_documents` (free-text origin hint).
- **Author** (optional text — defaults to "user"). Distinguishes UI-paste from agent ingests in the audit log.
- **Metadata** — dynamic key-value rows, add/remove buttons, autocomplete on key from `GET /api/clio/metadata-keys` (a request we already have).
- **Content** (large textarea, monospace).
- **Update if title exists** checkbox — when on, `POST /api/clio/ingest` with `updateIfExists: true` so a re-paste of the same title swaps in the new content with a version snapshot. Default off (safer).
- Submit button → success surfaces a "Document created/updated" toast with a "View" link to the detail panel.

#### 4. Audit tab (new)

Global view of `GET /api/clio/audit-log` with three filters — keep it simple, mirror the CLI `cfcf clio docs audit` flags:

- Event type dropdown — All / create / update-content / edit-metadata / delete / restore / migrate-project / archive / unarchive
- Actor text input
- Since (date input, ISO-8601-ish)
- Document id (text — used when navigating from Document detail "audit history" link)

Table: time, event (colour-coded badge), actor, document title (link to detail), short description, before/after size (when applicable). Limit 100 by default; if `nextOffset` is returned, a "Load more" button appends the next page.

#### 5. Projects tab (new)

Simple list of projects with their doc counts. **Create new** form (name + optional description) at the top. Edit/rename/delete deferred — the CLI doesn't support those either; the API endpoints don't exist server-side. Adding them is its own scope.

#### 6. Document detail panel (new)

Replaces the bare doc viewer from 6.12. Opens when a document is clicked from Browse, Search results, or an Audit-log row.

**Layout** — modal-ish overlay or dedicated `?doc=<id>` query view. Sections:

- **Header** — title, project, author, created/updated timestamps, chunk count, total chars, version count, deleted-at banner if soft-deleted
- **Metadata** — collapsible key-value table (same shape as `ClioDocument.metadata`)
- **Versions** — collapsible. Lists archived versions (newest first) with version number, timestamp, size, "View" button (loads that specific version's content via `?version_id=<uuid>`)
- **Audit trail** — collapsible. Filtered by `document_id`; same row shape as the global Audit tab
- **Content** — full reconstructed body in a `<pre>` block. Toggle button: rendered markdown vs raw.
- **Actions** — Delete (confirms; soft-deletes via `DELETE /api/clio/documents/:id`); Restore (visible only when soft-deleted, calls `POST /api/clio/documents/:id/restore`).

Edit (title/content/metadata) deferred for now — it's the biggest single piece of UI. Adding it would more than double the panel size. The CLI `cfcf clio docs edit` covers the metadata-edit path today; users who need to edit content can re-ingest with `updateIfExists`.

### Sidebar (persistent across tabs)

- **Stats panel** — unchanged from 6.12 (doc/chunk/project counts, DB size + path, active embedder)
- **Projects panel** — unchanged. Click a project filters Browse + Search + Ingest + Audit. "(all projects)" clears.

### Round 2 additions (added 2026-05-03 after first-cut review)

After landing the first cut + reviewing it, three follow-ups land in the same iteration:

#### A. Project edit + delete

The backend gains two new methods:

- `editProject(idOrName, { name?, description? })` — rename + description edit. Refuses to rename when one or more workspace configs still pin the old name (returns a 409 with the list of dependent workspaces); a `force: true` flag override is **not** added in this cut because rewriting workspace configs from a Clio mutation is the kind of cross-cutting effect that wants a deliberate user-facing affordance, not a hidden flag. Users who genuinely want to rename should first reassign the dependent workspaces (which already has a UI in the workspace Config tab from 6.12) or do it manually.
- `deleteProject(idOrName)` — hard-delete the project row. Refuses when either (a) any workspace pins the project name in its config OR (b) any non-soft-deleted documents still belong to the project. The error response lists the blocker so the user can act. No `force` flag in this cut for the same reason as above.

New server routes (mirror the existing `POST /api/clio/projects` shape):

- `PATCH /api/clio/projects/:idOrName` → `{ project: ClioProject }` on success, `409 { error, dependentWorkspaces? }` on the dependent-workspace block.
- `DELETE /api/clio/projects/:idOrName` → `{ deleted: true }` on success, `409 { error, dependentWorkspaces?, documentCount? }` on the blocker cases.

Web UI: each row on the Projects tab gains Edit + Delete buttons. Edit opens a small modal with name + description fields. Delete opens a confirm dialog that lists the doc count and any dependent workspaces; the confirm button is enabled only when the project is empty + unreferenced.

The CLI surface gains parity in a follow-up commit if needed; for now the feature is web-only.

#### B. Edit document (full edit)

The existing API surface already supports both edit shapes:

- **Metadata-only** (title / author / projectId / metadata) — `PATCH /api/clio/documents/:id`. No version snapshot, single `edit-metadata` audit entry with a before/after diff.
- **Content** — `POST /api/clio/ingest` with `documentId: <id>`. Snapshots the outgoing content as a new version, replaces the live chunks, writes an `update-content` audit entry.

The web UI work is purely client-side: Document detail overlay's footer gains an **Edit…** button that opens an `EditDocumentDialog`:

- Title text input (sticky to current)
- Project dropdown (reassignment if changed; uses the metadata PATCH path)
- Metadata key/value rows (same component shape as IngestTab)
- Content textarea (sticky to current; large, monospace)
- Save button — diffs against the original. If only title/project/metadata changed: PATCH. If content changed: POST /api/clio/ingest with documentId (which routes through the no-op-on-unchanged-content optimisation below). If both changed: PATCH first, then ingest, so the metadata edit lands as its own audit entry.

Cancel button discards the draft.

#### C. Content-unchanged short-circuit in updateDocument (Cerefox parity)

`LocalClio.updateDocument` (the path triggered by `documentId` or `updateIfExists` with title match) currently re-chunks, re-embeds, and snapshots a version unconditionally — even when the new content is byte-identical to what's already stored. Cerefox's pipeline skips entirely on `content_hash` match (`pipeline.py:188-202`, returns `action: "skipped"`).

cfcf already does this dedup at the **create** path (Branch 3 of `ingest`, lines 461-472). The fix is to extend the same logic to the **update** path, with one nuance: a user may have called update specifically to change metadata while the content happens to be the same — we shouldn't silently drop a metadata change.

New behaviour at the top of `updateDocument(target, req, contentHash)`:

| New content vs stored | Other doc fields differ from stored? | Result | Audit entry |
|---|---|---|---|
| Hash matches `target.contentHash` | None of title / author / metadata changed | Full no-op. Return `{ action: "skipped" }`. | None |
| Hash matches `target.contentHash` | Any of title / author / metadata changed | Metadata-only path: UPDATE `clio_documents` SET title/author/metadata, no version snapshot, no chunk re-write. | `edit-metadata` (mirrors the existing PATCH path's audit shape) |
| Hash differs | (any) | Existing flow: snapshot + re-chunk + re-embed + replace + UPDATE row. | `update-content` |

**Note on the `author` field**: this is a stamp on the doc recording who last touched it (`agent` / `user` / `claude-code` / etc.) — it does **not** imply any access control. Clio is shared memory; any agent or the user can update any document. The "author differs from stored" branch in the table above just means a write where the new request explicitly changed the stamp, e.g. the same content re-saved but now attributed to `user` instead of `agent`.

Added tests in `local-clio.test.ts`:

- `updateDocument is a no-op when content + metadata are unchanged`
- `updateDocument touches metadata only when content matches but title/author changes`
- `updateDocument re-chunks + snapshots when content actually changes` (regression check on the existing path)

This avoids unnecessary chunking + embedding work (which can be the most expensive part of an ingest when an embedder is active) and avoids polluting the version history with empty snapshots.

### Out of scope (deferred — unchanged from first cut except where noted)

- **File upload ingest** — text paste covers the immediate need. File upload requires either a multipart endpoint or a bigger UI for picking + previewing files; revisit.
- ~~**Document edit page** (full content edit)~~ — **moved into scope as round-2 addition B above.**
- ~~**Project rename / delete**~~ — **moved into scope as round-2 addition A above.**
- **Trash page** — soft-deleted docs are filtered from Browse + Search by default. The server's `?deleted_only=true` query param exists but no UI consumes it yet. A "View trash" affordance somewhere on the Browse tab would be cheap; revisit if dogfooding asks for it.
- **Analytics dashboard** — Cerefox has charts; cfcf's audit log is sufficient for the size of corpora cfcf currently sees. Defer.
- **Metadata search page** — `POST /api/clio/metadata-search` exists but the use case is narrow (fielded queries by metadata key/value). Could add a metadata-as-filter affordance to Search later.
- **Markdown rendered/raw toggle** in Document detail content view — defer; raw `<pre>` is fine for the first cut.
- **Diff viewer** between versions — Cerefox has it; defer until there's a request for it.

## API surface used

All endpoints already exist (no new server routes for this cut):

| Endpoint | UI consumer |
|---|---|
| `GET /api/clio/stats` | Stats sidebar |
| `GET /api/clio/projects` | Projects sidebar + Ingest project dropdown + Projects tab |
| `POST /api/clio/projects` | Projects tab (create) + Ingest's "(create new)" option |
| `GET /api/clio/search?q=&mode=&by=&project=&match_count=` | Search tab |
| `GET /api/clio/documents?project=&limit=&offset=` | Browse tab |
| `GET /api/clio/documents/:id` | Document detail header + metadata |
| `GET /api/clio/documents/:id/content[?version_id=]` | Document detail content section |
| `GET /api/clio/documents/:id/versions` | Document detail versions section |
| `DELETE /api/clio/documents/:id` | Document detail Delete button |
| `POST /api/clio/documents/:id/restore` | Document detail Restore button |
| `POST /api/clio/ingest` | Ingest tab |
| `GET /api/clio/metadata-keys` | Ingest metadata-key autocomplete |
| `GET /api/clio/audit-log[?...]` | Audit tab + Document detail audit section |

## Tests

- Web build + typecheck must stay clean across every chunk.
- Existing `/api/clio/*` HTTP tests already cover the server surface; no new server tests needed unless we hit a bug.
- For the new `<MemoryPage />` sub-views, focus on:
  - Search request shape (mode + by + project + match_count map to query params correctly)
  - Ingest request shape (project resolution, metadata serialization, updateIfExists toggle)
  - Audit request shape (filter combination → query params)
- Component-level tests for the picker components (e.g. result-type dropdown hides when chunks-only mode would be silly, project dropdown auto-creates new on submit) — deferred unless they catch a bug.

## Implementation order

1. **Sub-tab routing** — extend `/#/memory` with a `?tab=<…>` query param. Add a tab bar component above the main panel.
2. **Sidebar refactor** — extract Stats + Projects panels so all tabs share them. Memory page becomes a layout shell.
3. **Search tab** — rebuild. Mode + result-type + match-count + project; doc-mode result rendering with small-to-big snippet + chunk-mode raw-chunk rendering.
4. **Browse tab** — minimal rework (it's already there, just needs to live in its own tab and route clicks to the new Document detail).
5. **Document detail panel** — overlay or `?doc=<id>` view. Header + metadata + versions + audit + content + delete/restore.
6. **Ingest tab** — paste form with metadata + project picker + updateIfExists toggle.
7. **Audit tab** — table + filters.
8. **Projects tab** — list + create.
9. **Tests + guide doc updates**.
10. **Commit + push (no PR until user signals)**.

This roughly tracks the implementation plan I'll execute. Each chunk gets a separate commit so the history reads naturally.
