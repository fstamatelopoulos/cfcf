# Changelog

All notable changes to cfcf (cf²) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Changes are tracked via git tags. Each release tag corresponds to an entry here.

## [Unreleased]

_No changes yet._

## [0.19.0] -- 2026-05-03

**Items 6.24 + 6.18 ship.** Feature drops in 0.19.0; one more iter-6 item (6.9 -- rationalise Clio usage across agent roles) will land under the same minor before this gets cut to npm.

Minor bump because 6.24's migration changes the on-disk FTS schema. Reading + writing remain backward compatible (the migration is automatic, runs on first Clio touch after upgrade, and is wrapped in `BEGIN IMMEDIATE; ...; COMMIT` so partial failures roll back cleanly). 6.18 is purely additive (new web surface + new actor-stamp metadata + system-project guards); no API or config breaking changes.

### Added — Item 6.18: web Clio Memory page (full editorial layer)

Replaces the read-only Clio prototype shipped in 6.12 with a full-featured Memory page (`/#/memory`). Three rounds of iteration landed on the branch:

**Round 1 — tabbed page + persistent sidebar.**

- Five tabs: **Search** (auto / fts / semantic / hybrid; per-call `--alpha` / `--small-doc-threshold` / `--context-window` knobs), **Browse** (filterable doc list with project + metadata facets), **Ingest** (paste-or-upload + metadata editor), **Audit** (mutation history with before/after diffs for `edit-metadata`), **Projects** (CRUD).
- Persistent sidebar: **Stats** (docs / chunks / projects / DB size + location / active embedder) + **Project filter** (clicking a project scopes every tab's query).
- Hash routing: `#/memory?tab=...&doc=...` so deep links + browser back/forward work.
- Document detail overlay: metadata / versions / audit / content sections with Edit / Delete / Restore actions.

**Round 2 — project edit/delete + document edit + content-unchanged short-circuit.**

- `LocalClio.editProject` / `deleteProject` with workspace-dependency checks (refuses delete if any cfcf workspace still pins the project).
- `PATCH` / `DELETE /api/clio/projects/:idOrName` with structured 409 responses (`{dependentWorkspaces: [...], docCount: N}` so the dialog can render a precise refusal).
- `updateDocument` content-unchanged short-circuit: 3-branch logic (full skip when nothing changed / metadata-only with one `edit-metadata` audit entry / full re-chunk + version snapshot when content moved). Avoids a stale-version proliferation bug surfaced during round-2 dogfooding.
- Web dialogs: `EditProjectDialog`, `DeleteProjectDialog` (type-the-name confirm), `EditDocumentDialog` (diffs draft vs original, routes through `PATCH` for metadata-only and/or `POST /api/clio/ingest` with `documentId` for content updates).

**Round 3 — system projects + actor stamp + sidebar polish.**

- **System-managed Clio Projects** (`packages/core/src/clio/system-projects.ts`): single source of truth for the four cf-system-* projects (`cf-system-default`, `cf-system-memory-global`, `cf-system-pa-memory`, `cf-system-ha-memory`). Locked from rename/delete at the backend layer (`editProject` + `deleteProject` throw on a system-project name) so the lock holds across web UI + CLI + any future surface. Doc ingest into a system project is **allowed** — only the project itself (rename / delete / re-describe) is locked.
- **Boot-time `ensureSystemProjects()`** called from `start.ts` on every server start so the projects appear in listings before any agent has written to one. Idempotent; best-effort (failures don't block boot, the auto-create-on-first-use path is still in place). Deliberately **not** seeded via SQL migrations (migrations are immutable; this stays in TypeScript so adding a new system project is a single edit that always runs in sync with the constants).
- **Clio actor / author convention** (`packages/core/src/clio/actor.ts`): every Clio mutation now stamps a structured `<role>|<agent>|<model>` identifier (e.g. `dev|claude-code|sonnet`, `product-architect|codex|gpt-5`). The audit log + future analytics filter on this stamp; missing or inconsistent stamps make writes invisible to those filters. Threaded through:
  - `loop-ingest.ts` — `actorForRole(workspace, role)` helper passes `author: <stamp>` to all 5 auto-ingest sites (reflection / architect / decision-log / iteration-summary / raw artifacts).
  - PA + HA prompt-assemblers — render a "Clio actor stamp" subsection inside Memory + pre-fill `--author "<stamp>"` / `--actor "<stamp>"` on every `cfcf clio docs ingest` / `delete` / `restore` / `edit` example.
  - `cfcf spec` + `cfcf help assistant` launchers — compute the actor at launch from the resolved AgentConfig and pass it to the assembler.
  - Iteration-role `clio-guide.md` template — brief author convention section so dev / judge / architect / reflection / documenter use the right stamp on direct writes too.

  The stamp is **metadata, not access control** — any role can write to any doc; this is shared memory across the user + every agent in the cf² ecosystem. Mirrors Cerefox's actor-stamp convention so a future swap-in to a Cerefox-backed Clio doesn't break audit-log filters or analytics.
- **Web UX polish**: Memory sidebar Stats panel (long values were left-aligned and wrapping awkwardly because the dl flex row had no `min-width: 0` / `text-align` on `dd`); DB location moved into the dl as a normal row instead of a separate hint; (system) badge moved from the Name column to the Actions column on `ProjectsTab` (replaces the "— system —" label, reads more naturally as "this is what stands in for Edit/Delete").

**Cerefox interface parity** is now a durable rule in `CLAUDE.md`: Clio is the local-memory migration of Cerefox, and the long-term vision is to swap in a real `CerefoxRemote` backend behind the existing Clio API without changing the CLI verbs, web UI flows, or response shapes. Internal stack differences (SQLite/FTS5 vs Postgres/tsvector + pgvector; per-column `bm25()` weights vs `setweight` tsvector composition) are stack-driven implementation choices and they're fine; what must stay compatible is endpoint shapes / query parameter names + semantics / response field names + shapes / CLI verb structure.

**Read-audit gap** (captured as a 6.9 follow-up): cfcf's audit log captures mutations only. Cerefox additionally maintains a `usage_log` for reads (each `search` / `docs get` records the requestor + query). Likely yes for cfcf parity for the same actor-convention reason; needs a privacy review (does logging every search query risk capturing prompt-leakage if the agent quotes problem.md content into a query?). Tracked in `docs/plan.md` row 6.9.

**Files added**: `packages/core/src/clio/{actor,system-projects}.ts`; `packages/web/src/pages/memory/{AuditTab,BrowseTab,DeleteProjectDialog,DocumentDetail,EditDocumentDialog,EditProjectDialog,IngestTab,MemorySidebar,ProjectsTab,SearchTab}.tsx`; `packages/web/src/hooks/useRoute.{ts,test.ts}`; `docs/design/clio-memory-web-ui.md`.

**Tests added**: 8 to `local-clio.test.ts` (project edit/delete with dependent-workspace check; content-unchanged short-circuit branches; system-project guard); 4 to `clio.test.ts` (PATCH/DELETE routes); HA + PA prompt-assembler tests for the actor stamp; useRoute hook tests.

### Added — Item 6.24: Clio FTS title boosting (Cerefox parity)

Brings Clio's FTS ranking up to Cerefox parity for title-boosted search: query terms that match a document title or a chunk heading now outrank body-only matches at the same ratio Cerefox uses (effective A:B = 2.5×).

**Migration `0002_fts_title_boost.sql`** drops the existing 2-column `clio_chunks_fts` (`chunk_title` + `content`) and recreates it as a 3-column FTS5 (`doc_title` + `chunk_title` + `content`), backfilling via `INSERT ... SELECT` joining `clio_chunks → clio_documents` so existing corpora pick up the title column with no user action. Five triggers handle every path:

- `clio_chunks_fts_ai` / `_ad` / `_au` — chunk lifecycle, JOIN to `clio_documents` for `doc_title`
- `clio_documents_fts_bd` (BEFORE DELETE) — pre-clears FTS rows for current chunks before the cascade-delete on `clio_chunks` fires; required because the chunk-AD trigger can't reconstruct `doc_title` via JOIN once the parent doc is gone
- `clio_documents_fts_title_au` (AFTER UPDATE OF title) — refreshes FTS `doc_title` for all current chunks of a renamed doc; mirrors Cerefox's `cerefox_update_chunk_fts` RPC, but declarative (the trigger fires automatically on `cfcf clio docs edit --title` and any other path that updates the column)

**`searchFts()` + chunk-level hybrid path** now call `bm25(clio_chunks_fts, 2.5, 2.5, 1.0)`. Constants extracted as `FTS_BM25_WEIGHT_DOC_TITLE` / `CHUNK_TITLE` / `CONTENT` for one-spot tuning. The 2.5× ratio matches Cerefox's effective A:B from Postgres `ts_rank_cd`'s default weight table `{D:0.1, C:0.2, B:0.4, A:1.0}` (A/B = 1.0/0.4 = 2.5×). The underlying ranker is necessarily different across the two stacks (Postgres `ts_rank_cd` cover-density vs SQLite `bm25` Okapi BM25) — that's a "we picked SQLite" consequence, not a tuning choice — but the title-boost ratio is the user-visible knob that decides "how much do title matches outrank body matches?".

**Tests added**: 6 new (90 total in `local-clio.test.ts`, was 84) — title-only outranks body-only; chunk-heading outranks body-only; rename refreshes FTS for all current chunks; rename trigger doesn't blow away unrelated docs; soft-delete still removes from search (existing JOIN-level filter, belt-and-suspenders to confirm the migration didn't break it); end-to-end backfill verification.

**Migration behaviour**: lazy — runs on first `getClioBackend()` call after server boot (Memory page stats fetch, search, ingest, etc.). Sub-second on small corpora; sub-minute on 10k chunks. No separate `cfcf clio reindex --refts` flag needed (the in-place `INSERT ... SELECT` backfill made it unnecessary).

**Backlog follow-up F.19**: two related FTS gaps surfaced during the Cerefox-parity review — stop-word handling (FTS5 ships no English stop-word list; queries like "design of agents" match every doc containing "of") and Google-style query operators (`-foo`, `"phrase"`, `OR` — supported natively by Postgres `websearch_to_tsquery`, not by Clio's current parser). Both are query-time pure-TS fixes; deferred until dogfooding surfaces a concrete pain point.

### Fixed

- **Stale `releaseNotesUrl` assertion in `update.test.ts`** (6.20 follow-up). The v0.18.0 review pass removed `releaseNotesUrl` from the flag-file shape for security reasons (the file lives in `~/.cfcf/`, user-writable; an attacker-controlled link rendered as `<a target="_blank">` would be a phishing surface), but the corresponding test still asserted on the field's presence and was quietly failing. Replaced the contains-URL check with a `toBeUndefined` check that locks in the security property.

## [0.18.0] -- 2026-05-02

**Items 6.20 + 6.12 + 6.26 ship.** Three coordinated additive feature drops:

- **6.20** — minimal `JobScheduler` primitive that item 6.13 (cron-like recurring execution) will extend rather than duplicate, plus the first job that uses it: a 24h `update-check` against npm that drives a web UI banner, a CLI lifecycle banner, and a `cfcf doctor` check. No auto-update — the user always runs `cfcf self-update --yes` explicitly.
- **6.12** — closes every CLI ↔ web parity gap surfaced by the audit (workspace creation / deletion / Clio Project reassignment / ad-hoc Reflect / read-only Memory browser) plus a full theming pass (light / dark / auto with toggle, `color-scheme` for native widgets, dark-theme contrast bump, readability tokens, panel-surface convention).
- **6.26** — replaces the free-text per-role model field across web Settings, workspace Config, and CLI init / config-edit with a registry-driven dropdown. Bundled seed (generic aliases like `opus` / `sonnet` / `gpt-5-codex`) merged with an optional user override managed via a new Settings → Model registry editor. Plus a typography polish pass (small text on every view bumped to a coordinated `--text-xs/sm/md` scale; clickable-looking section titles fixed; remaining plan-item refs stripped from UI strings).

Minor bump because this introduces a new core module (`scheduler`), new user-visible behaviour (banners + theme toggle + model dropdowns + Model registry editor), and substantial new web surfaces (Memory page, modals, Reflect button, workspace lifecycle UI). All surfaces are additive — no breaking config or API changes.

### Added — Item 6.20: minimal `JobScheduler` primitive + new-version notification

A small, restart-resilient periodic-job runner (`packages/core/src/scheduler/`) plus the first job that uses it: a 24h `update-check` against the npm registry that drops a flag file at `~/.cfcf/update-available.json` when a newer release of `@cerefox/codefactory` is published. The flag file drives:

- **Web UI top-bar banner** (`packages/web/src/components/UpdateBanner.tsx`) — always-on, dismissible per-session (per-`latestVersion` so a newer release re-shows). Powered by `GET /api/update-status` (200 + JSON when newer; 204 otherwise). Update-status piggybacks on the shared `ServerStatusProvider` poll loop (one tick covers health + activity + update-status at the existing 3 s / 10 s cadence) so no extra timer is added to the page.
- **CLI lifecycle banner** — printed at startup of `init` / `server` / `status` / `doctor` and `self-update --check` only. Other verbs (`run`, `clio`, `workspace`, …) stay silent so scripted operations don't pay the 5–20 ms FS-read cost or get noise in their stdout. Suppress via `notifyUpdates: false` in global config or the env var `CFCF_NO_UPDATE_NOTICE=1`.
- **`cfcf doctor` check** — surfaces the same flag as either an `ok` "running v0.X.Y (latest known)" line or a `warn` "v0.X.Y available -- run: cfcf self-update --yes" line.

**No auto-update under any circumstance.** The user always runs `cfcf self-update` explicitly; the flag file just nudges them at moments when they're already paying attention to lifecycle state.

**Why a primitive, not a one-off timer?** Item 6.13 (cron-like recurring execution research) extends this same primitive — keeping update-check + 6.13 on a shared seam means the cron work is "extend the interface" rather than "build a parallel timer mechanism." User-defined jobs, cron expressions, schedule-management UX, and concurrency policy are explicitly out of scope here and are 6.13's job.

**Files added:**

- `packages/core/src/scheduler/{types,scheduler,index}.ts` — `Job` + `JobScheduler` + `SchedulerStateFile`. Persists `~/.cfcf/scheduler-state.json` after each job run (bounds restart-loss to one tick interval per job).
- `packages/core/src/update-check.ts` — `compareSemver`, `runUpdateCheck`, `makeUpdateCheckJob`, `readUpdateAvailable`, `defaultUpdateFilePath` (honours `CFCF_UPDATE_FILE` for tests).
- `packages/server/src/routes/update.ts` — `GET /api/update-status`.
- `packages/web/src/components/UpdateBanner.tsx` + matching `.update-banner` CSS in `app.css`.
- `packages/cli/src/update-banner.ts` — lifecycle gating, sync FS reads, stderr output.
- `docs/design/scheduler-and-update-notification.md` — design rationale + interface notes.

**Files changed:**

- `packages/core/src/types.ts` + `config.ts` — `notifyUpdates?: boolean` (default `true`, backfilled by `validateConfig` so existing installs start showing the banner without a config edit on upgrade).
- `packages/server/src/start.ts` — wires the `JobScheduler` into the server lifecycle (start on boot, stop on graceful shutdown). The update-check job sets `runOnStart: true` so every server boot fires a fresh npm registry check unconditionally; the 24h interval is the long-running-server safeguard cadence. Also calls `clearStaleUpdateFlag(VERSION)` as defense-in-depth so disconnected upgrades still clear the banner without network. Failures inside the job are recorded on `lastError`, never crash the server.
- `packages/web/src/hooks/useServerStatus.tsx` — new shared `ServerStatusProvider` context owning a single poll loop for health + activity + update-status. Header + UpdateBanner consume it; no per-component timers.
- `packages/web/src/App.tsx` — renders `<UpdateBanner />` above `<Header />`.
- `packages/cli/src/index.ts` — calls `maybePrintUpdateBanner()` before commander parsing.
- `packages/cli/src/commands/doctor.ts` — adds `checkUpdateAvailable()`.

**Tests added:** scheduler tick + persistence + register validation; semver comparison + flag-file lifecycle; `/api/update-status` HTTP route; CLI banner lifecycle gating + suppression knobs.

### Security — flag file carries no clickable URL

`~/.cfcf/update-available.json` deliberately omits `releaseNotesUrl`. The file lives in `~/.cfcf/`, which is user-writable, so a local actor (malicious script, misbehaving install) could otherwise plant an attacker-controlled link that the web banner would render as `<a target="_blank">` — a phishing surface. The upgrade command (`cfcf self-update --yes`) is canonical and self-contained; the version number is all the surfaces need.

### Added — Item 6.12: close CLI ↔ web parity gaps + light/dark theme + readability pass

Closes every user-facing CLI ↔ web parity gap surfaced by the audit in plan row 6.12, plus a theming pass that fell out of dogfooding the new web surfaces. Read-only Clio prototype here; item 6.18 will refine the editorial layer.

**Web surfaces added:**

- **+ Create workspace** button + modal on the Dashboard, replacing the redundant "server & config →" link (Settings is already in the top nav). Mirrors `cfcf workspace init` — name, absolute repo path, optional Clio Project. Components: `Modal`, `NewWorkspaceModal`.
- **Memory page** at `/#/memory` (new top-bar nav item between Workspaces and Settings). Stats panel (doc / chunk / project counts, DB size + path, active embedder), projects sidebar (filters the rest of the page), search box (auto / fts / semantic / hybrid; results show title, project, score, heading path, snippet), documents list, read-only doc viewer. Component: `MemoryPage`.
- **Workspace delete** (config-only; the repo folder, iteration branches, and ingested Clio docs are NEVER touched). New "Danger zone" at the bottom of the Config tab; type-the-name confirm pattern (matches the GitHub repo-deletion UX). Component: `DeleteWorkspaceDialog`.
- **Clio Project reassignment** on the workspace Config tab (mirrors `cfcf workspace set --project`, including the migrate-history + all-in-project escalation). Picker `<select>` for existing + separate text input for "Or type a new project name" (text input wins on submit). Component: `ClioProjectDialog`.
- **Reflect** button in `LoopControls` between Start Loop and Document (mirrors `cfcf reflect`); disabled while any agent runs; auto-switches to Logs when fired.

**Theming overhaul:**

- **Light / dark / auto** themes selected via `[data-theme]` on `<html>`. Toggle in Header (☾ / ☀ / ◐) cycles the three states; persists to localStorage (per-tab fast path; pre-paint script in `index.html` avoids first-paint flash) and to cfcf global config (`theme: "auto" | "dark" | "light"`, default `"auto"`). New `useTheme` hook + `ThemeToggle` component.
- **Native widget palette** wired via CSS [`color-scheme`](https://developer.mozilla.org/en-US/docs/Web/CSS/color-scheme) so the OS-rendered `<select>` popup, scrollbars, and input spinners follow the page theme rather than the OS preference.
- **Dark-theme contrast bump**: `--color-text` ~14:1 (was ~9:1), `--color-text-muted` ~7:1 (was scraping the 4.5:1 floor at small sizes).
- **Readability pass** on form inputs / labels / hints (~10-15% bigger via new `--text-xs/sm/md` tokens). The html base font-size was deliberately not bumped to avoid rippling layout changes through every existing component.
- **Panel surface convention** enforced consistently: `--color-bg` for page bg + log viewer + nested drop-one-level surfaces; `--color-surface` for panels / cards; `--color-surface-alt` for form inputs + subtle hover highlights. Memory panels switched from alt → surface; log viewer switched from hardcoded `#0a0c10` → `var(--color-bg)` so it survives a light-theme switch.
- **Form inputs** (`<input type="text|number|search|...">`, `<select>`, `<textarea>`) get global dark-theme styling so existing pages (Settings, workspace Config) pick up the look without per-component changes. Custom CSS chevron on `<select>` for consistent dropdown widths regardless of option content. Two Clio-Project pickers swapped from `<input list>+<datalist>` to plain `<select>` matching Settings (datalist popups are browser chrome and can't be CSS-styled, leaving inconsistent widths between dialogs).

**Architecture polish:**

- New shared `useServerStatus` context owning a single poll cycle for health + activity + update-status (replaces `UpdateBanner`'s standalone 5-min timer; one tick covers everything at the existing 3 s active / 10 s idle cadence).
- Backend: `theme?: "auto" | "dark" | "light"` added to `CfcfGlobalConfig` (default `"auto"`, backfilled by `validateConfig` and explicitly set in `createDefaultConfig` for new installs).

**Plan additions (no code):**

- **Row 6.9** appended with a follow-up note about the Clio Project namespace convention surfaced during dogfooding (system-managed projects like `cfcf-memory-pa` should be filtered or prefixed at picker sites once the convention firms up).
- **New row 6.26**: per-role model selection — dropdowns sourced from each agent's supported-models list (replace today's free-text model field in web Settings + workspace Config + CLI init/config edit).

### Added — Item 6.26: per-role model selection dropdowns + Model registry editor

Replaces the free-text per-role model field across web Settings, workspace Config, and CLI init / config-edit with a registry-driven dropdown. The registry is the bundled seed in `packages/core/src/adapters/seed-models.ts` merged with an optional user override on `CfcfGlobalConfig.agentModels[<adapter>]`. Free-text input was risky: typos silently propagated and the user had no discoverability of what models the installed agent CLI actually supports.

**Why no remote registry / API query** — investigated first; documented in the design discussion + CLAUDE.md:

- Neither `claude` nor `codex` exposes a `list-models` subcommand, so we can't query the CLI directly.
- Anthropic / OpenAI Models APIs require an API key, which Claude Code's OAuth-subscription users don't have.
- Hosting our own remote registry would shift maintenance responsibility (model-list curation, rate-limiting, availability) onto cfcf maintainers indefinitely.

Seed + user override side-steps all three. The seed is intentionally minimal — generic aliases (`opus`, `sonnet`, `haiku` for claude-code; `gpt-5-codex`, `gpt-5`, `o3` for codex) over date-bound full names so it ages slowly. Hand-edited config values not in the registry are preserved as `(custom)` entries on first render so back-compat doesn't break.

**Surfaces:**

- **Settings → Agent roles** + **workspace Config → Agent roles**: free-text model field becomes `<AgentModelSelect>` — a `<select>` with `(adapter default)` first option + the resolved registry. Adapter swap re-targets the model dropdown.
- **Settings → Model registry** (new section): per-adapter card showing the resolved list as deletable chips + add-model input + "Reset to seed" button when an override is in effect. Saving an empty list (or one identical to the seed) clears the override so future seed updates flow through automatically.
- **CLI `cfcf init` / `cfcf config edit`**: numbered selector matching the existing `pickAgent` pattern (e.g. `0. (use adapter default) / 1. opus / 2. sonnet / 3. haiku`). Hand-edited per-role models that aren't in the registry survive as a numbered "(custom — from existing config)" line so re-running init keeps the user's pick.

**Single edit surface:** an earlier draft included a "(custom model name…)" inline sentinel in every picker as a one-shot escape hatch, but review feedback noted that two add-paths (inline + Settings editor) created a UX question the design didn't answer cleanly. Dropped in favour of one edit surface (Settings → Model registry); the back-compat `(custom)` rendering covers the legacy-config case.

**Files added:**

- `packages/core/src/adapters/seed-models.ts` — bundled seed registry per adapter
- `packages/core/src/agent-models.ts` — `resolveModelsForAdapter()` + `resolveAllModels()` helpers
- `packages/core/src/agent-models.test.ts` — 8 unit tests (seed lookup, override precedence, empty-array fallback, malformed-entry filtering, per-adapter isolation, user-only adapter)
- `packages/server/src/routes/agent-models.ts` — `GET /api/agents/models` returning `{ adapters, seed }`
- `packages/server/src/routes/agent-models.test.ts` — 4 HTTP tests
- `packages/web/src/components/AgentModelSelect.tsx` — read-only dropdown component, used in both Settings + workspace Config

**Files changed:**

- `packages/core/src/types.ts` + `config.ts` — `agentModels?: Record<string, string[]>` on `CfcfGlobalConfig` with `validateConfig` coercion of malformed entries
- `packages/cli/src/commands/init.ts` — replaces `prompt("X agent model", ...)` per role with the numbered picker
- `packages/web/src/components/ConfigDisplay.tsx` + `pages/ServerInfo.tsx` — wire `<AgentModelSelect>` into the per-role tables; ServerInfo also gains the "Model registry" editor section

**Maintenance**: when an upstream agent CLI ships a new headline model worth surfacing as a default, edit the relevant array in `seed-models.ts` and ship in the next release; user overrides survive the upgrade.

### Changed — Typography polish + theme consistency (6.26 review)

A polish pass that fell out of dogfooding the new dropdowns:

- **Plan-item refs stripped from UI strings** — `"Model registry (item 6.26)"` and `"Behaviour flags (item 5.1)"` had leaked into rendered titles. Now plain `"Model registry"` and `"Behaviour flags"`. Code comments still carry the trace, which is the right place for them.
- **Static section titles no longer look clickable** — the `architect-review__summary` class was reused on `FormSection`'s `<h3>`s but it has `cursor: pointer` + a hover colour swap because it's also used on real `<summary>` elements inside `<details>` (ArchitectReview, JudgeDetail). Split into a new `.section-title` class with the same typography but no interactivity styling.
- **Small text bumped on every view** to a coordinated `--text-xs` (~13.2px) / `--text-sm` (~14.4px) / `--text-md` (~15.2px) scale. The original 6.12 typography pass landed only on a few table classes; this sweep replaces every remaining `0.7Xrem` literal — both `font-size` declarations in `app.css` and inline `style={{ fontSize: ... }}` overrides in 12 components (the inline ones win over class CSS via specificity, so they couldn't be reached otherwise). Net effect: workspace Detail / History / Logs / Memory / Help / judge / architect / reflection detail panels and modals all read at the same size as Settings + workspace Config.

## [0.17.1] -- 2026-05-02

**Tag-only release; not published to npmjs.com.** Patch-bump rolling up the post-0.17.0 housekeeping pass: a CSS fix for the workspace History table, a major plan cleanup, and a comprehensive documentation refresh against the v0.17.0 shipped state. No code-behaviour changes outside the one CSS rule. Distribution channels stay on `0.17.0`.

### Fixed

- **History table LOG-column alignment** (`packages/web/src/styles/app.css`). When the TYPE or RESULT cell in the workspace History table wrapped to two lines, the LOG-column action buttons (`log` / `view` / `dev` + `judge`) drifted to mid-row instead of staying top-aligned. Three iterations to land the right fix:
    - First attempt: added `vertical-align: top` + balanced padding to `.project-history__table td` (commit `7b81994`). Effective for cells with no `display:flex`, but the LOG-column `<td>` had `display:flex` itself — flex containers ignore `vertical-align`, so the buttons stayed centred.
    - Second attempt: added `align-items: flex-start` to the flex container (commit `9b7efaa`). Browsers treat `<td>` as `table-cell` externally and re-purpose `flex` for inner layout in subtle and not-fully-reliable ways; the buttons still drifted.
    - Final fix: dropped `display:flex` entirely from `.project-history__actions` (commit `28ae7cb`). The `<td>` now inherits `vertical-align:top` cleanly from the parent rule. Sibling-margin (`* + *`) handles the inter-button gap. Lesson worth capturing: for variable-row-height table layouts, prefer table-cell `vertical-align` over `display:flex` on `<td>`.

### Changed — Plan reorganisation (2026-05-02 housekeeping pass)

- **Iteration 5 closed.** All 16 items shipped 2026-04-12 → 2026-05-02. Top-of-`plan.md` "Current Status" block summarises iter-5 deltas + iter-6 active scope.
- **All 8 pending iter-6 items resolved.** No more 🟡 (open) statuses in the iter-6 table. 6.1 (diff viewer) → ⏸ superseded by F.13. 6.2 (`cfcf log` CLI) → ⏸ subsumed by 6.12 parity audit. 6.10 (sandbox) → ⏸ moved to F.5. 6.15 (sqlite-vec HNSW) → ⏸ moved to F.18 (with corpus-size trigger). 6.8 (custom directions) → ❌ blocked on 6.11. 6.11 (ADLC) → ❌ research-only. 6.13 (scheduled execution) → ❌ research-only. F.18 added to Backlog.
- **6.20 design refined.** New-version notification now scoped to ship a minimal `JobScheduler` primitive (in `packages/core/src/scheduler/`) that 6.13 will extend rather than duplicate. CLI banner gated to lifecycle commands (`init` / `server` / `status` / `doctor` / `self-update --check`) instead of every `cfcf <verb>` invocation — keeps the banner's signal value and avoids 5–20 ms FS-read overhead in scripted operations. 6.13 row updated to forward-reference the primitive.
- **Backlog unified.** Old "Backlog / Future iterations" section merged with the historical "Future Iterations (v0.7+)" section into a single `## Backlog` with `F.1`–`F.18` sequential numbering (append-only). Original `6.x` numbers preserved in Notes column for traceability.
- **Decision Log table at end of plan.md removed.** Duplicated entries already living in `docs/decisions-log.md` with richer context. Replaced with a one-paragraph cross-reference pointing at the SSOT.

### Changed — Documentation refresh against v0.17.0 shipped state

A full pass through every documentation surface to align prose, examples, and reference content with what's actually shipping today. No code changes anywhere in this section — purely doc fidelity.

- **User-facing + API docs (`b244355`)**:
    - `docs/guides/cli-usage.md`: `cfcf init` lists all 7 roles (5 iteration + 2 interactive); `cfcf review` readiness includes `SCOPE_COMPLETE`; new full `cfcf resume --action` documentation with the 5 values, pause-reason gating, and examples; new "Maintenance commands" section for `self-update` / `doctor` / `help`.
    - `docs/api/server-api.md`: resume endpoint body schema rewritten with `ResumeAction` type definition; architect signals enumerate `SCOPE_COMPLETE`; events table adds the new `loop-stopped` event type; version placeholders bumped from `0.0.0` to `0.17.0`.
    - `docs/design/agent-process-and-context.md`: architect readiness enum + JSON example add `SCOPE_COMPLETE`; decision-step list adds Scope-complete and User-initiated stop bullets; `cfcf-docs/` tree listings include the Clio + reflection + iteration-handoffs files that were missing.
    - `docs/guides/workflow.md`: signal-values list + "When cf² involves the user" table + "Extending a Finished Project" all updated for `SCOPE_COMPLETE`.
    - `docs/guides/installing.md`: version pins bumped `0.16.x` → `0.17.0`.
    - `docs/guides/troubleshooting.md` / `product-architect.md`: filled in `v0.x.x` version placeholders.
    - `docs/guides/manual.md`: added one-line cross-reference to the workflow.md pause-action documentation.
- **Design docs refresh (`d9992f1`, `f07c7e7`)**:
    - `docs/design/cfcf-requirements-vision.md` (v0.4 → v0.5): roles table expanded from 5 to 7; `AgentAdapter` sketch rewritten as TypeScript with the actual shipped camelCase signature; Problem Pack section drops the `tests/` requirement; web UI moved from "non-goal" to "shipped iteration 4"; CLI sketch rewritten around current verbs; Memory Layer leads with Clio; new section "10a. Distribution" for npm + sigstore + `self-update`.
    - `docs/design/cfcf-stack.md`: CLI entry-point list enumerates the actual current surface; Web GUI section rebadged from "Iteration 4 — Available" to "shipped iteration 4; expanded in iteration 5"; Memory Layer rewritten to describe both tiers (per-workspace `cfcf-docs/` + cross-workspace Clio); `cfcf iterate` replaced with `cfcf run`.
    - `docs/design/clio-memory-layer.md`: top-of-file Status box reframes the doc as design-of-record + history (sections 1–7 shipped, sections 8+ are backlog/future); `v2+` annotations dropped from `clio_document_versions` (5.11) and `clio_audit_log` (5.13); embedder catalogue synced to the shipped `catalogue.ts`; `reindex` CLI verb documented as shipped (5.11); §11 Implementation phases restructured from `v1/v2/v3` to `Shipped/Backlog/Speculative` with F.18 + 6.24 cross-references.
    - `docs/design/technical-design.md`: large refresh — header status moved from "Draft / April 2026" to "Living document / refreshed against shipped state at v0.17.0"; `v0.1` / `Iteration 0` / `Deferred to Iteration 1+` framing dropped throughout; system-overview ASCII diagram extended with Architect + Reflection runners + Clio Backend + `~/.cfcf/clio.db`; endpoint sketch updated for `/api/clio/*`, `/run` rename, `/reflect`, `/document`, `/activity`, `/api/config`; `WorkspaceConfig` rewritten to match `packages/core/src/types.ts`; state machine adds `REFLECTING` phase + `ResumeAction`; per-iteration flow shows three commits + `plan-validation` + Clio auto-ingest; new full schemas for `ArchitectSignals` (incl. `SCOPE_COMPLETE`) + `ReflectionSignals` + `ResumeAction`; memory section rewritten as two-tier with `MemoryBackend` swap point.
    - `docs/design/clio-memory-layer.md` §11.5: RRF residue removed throughout the body; rewritten in alpha-blending terms with the actual `searchHybrid` formula (`α × cosine + (1 − α) × normalised_bm25`, default `α=0.7`); v1 starting posture corrected to "no boost layer in v1"; ranking-strategy history (RRF k=60 → alpha-blending on 2026-04-27) captured as a single-line note in §13 instead of being threaded through the body.
- **Project-root docs (`13b3e28`)**:
    - `README.md`: status block bumped `v0.16.2` → `v0.17.0`; Agent Roles table grew from 5 to 7; new Clio cross-workspace memory subsection linking the quickstart guide.
    - `CLAUDE.md`: Architecture Overview "five agent roles" → "seven agent roles" with iteration/interactive split; new bullet for structured pause actions (item 6.25) with all 5 `ResumeAction` values + `loop-stopped` history event type; expanded `packages/cli/src/commands/` list to include `spec.ts`, `doctor.ts`, `self-update.ts`, `help.ts`, `completion.ts`; `guides/` doc tree expanded from 2 files to the actual 7-file set.

## [0.17.0] -- 2026-05-02

**First public release after the v0.16.x dogfood-only series.** Bumps the minor version for the substantial UX and signal-vocabulary additions since 0.16.4 (the last npm-published release). **Includes everything from the tag-only `v0.16.5` + `v0.16.6` releases** (see those entries below for full detail) — most notably the structured pause actions feature (item 6.25) and the reflection-on-SUCCESS disambiguation (PR #26) — **plus** the post-6.25 polish below that surfaced during dogfooding.

### Added — Architect `SCOPE_COMPLETE` readiness verdict (item 6.25 follow-up)

Surfaced 2026-05-02 dogfooding: re-running the loop on a previously-completed workspace forced the Solution Architect into a misleading `NEEDS_REFINEMENT` verdict because the existing 3-value enum had no way to say *"spec is fine but the work is already done."* Same vocabulary-conflation pattern as the structured pause actions fix (single field overloaded across orthogonal axes). Full design rationale + holistic agent-signal audit + 4 lessons in [`docs/decisions-log.md`](docs/decisions-log.md) (2026-05-02 SCOPE_COMPLETE entry).

- **`ArchitectReadiness` enum extended**: new `"SCOPE_COMPLETE"` value joining `READY` / `NEEDS_REFINEMENT` / `BLOCKED`. Always blocks the loop **regardless of `readinessGate` setting** (no semantic where "proceed despite no work" makes sense).
- **`LoopState.pauseReason` extended**: new `"scope_complete"` value joining `cadence` / `anomaly` / `user_input_needed` / `max_iterations`. Distinct from `"anomaly"` so the UI doesn't mislabel "scope already done" as a problem state.
- **`pauseReasonAllowedActions` matrix entry**: SCOPE_COMPLETE narrows to `finish_loop` / `stop_loop_now` / `refine_plan`. Hides `continue` (loop has nothing to build) and `consult_reflection` (no iterations to reflect on).
- **`buildPreLoopBlockReason` dedicated branch**: plain-English message tailored to the SCOPE_COMPLETE case, mentioning the three applicable actions concretely.
- **`pauseReasonTitle("scope_complete")`**: `"Loop paused: scope already complete"`.
- **Architect prompt extension**: `cfcf-architect-instructions.md` documents the new value with guidance on when to use it (workspace previously completed, or implementation done outside cfcf).
- **Web UI rendering**: `readinessColor.SCOPE_COMPLETE` = info/neutral (not success — loop didn't run; not warning — spec isn't broken). `ArchitectReview.readinessMeta.SCOPE_COMPLETE` has dedicated guidance text. `FeedbackForm`'s contextual button matrix narrows correctly when paused with `scope_complete`.
- **CLI**: `cfcf review` auto-handles via passthrough (prints `Readiness: SCOPE_COMPLETE`); `cfcf resume --action <name>` validates against the narrowed action set per the harness's matrix.
- **12 new unit tests** in `iteration-loop.test.ts` covering `readinessGateBlocks` (always-blocks regardless of gate), `buildPreLoopBlockReason` (dedicated message + gate-independence), and `pauseReasonAllowedActions` (correct action narrowing). Total now 55, was 43.

### Added — Holistic agent-signal audit (item 6.25 follow-up)

After SCOPE_COMPLETE landed, audited every agent role's signal vocabulary against real-world cases to identify other gaps. **Outcome: only the architect needed extending.** Dev / judge / reflection / PA all have sufficient expressivity through existing signals or compositions thereof. Full audit + per-role verdicts captured in the same 2026-05-02 decisions-log entry — confirms no further signal additions are warranted at this time, with the conflation-anti-pattern lens captured for future signal expansion reviews.

### Fixed — UX gaps in the structured pause actions feature

Surfaced 2026-05-02 in dogfooding the v0.16.6 release.

- **`loop-stopped` history rows now render correctly.** Previously the new `loop-stopped` event type wasn't in the web `HistoryEventType` enum, so rows showed empty Type/Agent/Result columns and a broken "log" button. Now: type label "Loop stopped by user · after iter N", agent column "(user action)", result column shows a feedback summary with click-to-expand pill, expandable detail panel renders the full feedback verbatim.
- **Pre-loop pause message rewritten** to plain English. Was: *"Pre-loop review readiness=missing does not satisfy gate=needs_refinement_or_blocked. Edit the Problem Pack and resume."* Now: clear explanation of what happened, what the gate means in concrete terms, what files to edit, and which resume actions apply.
- **Top-level Resume / Stop / Document buttons hidden during pause.** They competed with the new structured FeedbackForm action panel, and the legacy `Resume` button bypassed the structured action by defaulting server-side to `"continue"`. Now: the FeedbackForm's 5 action buttons are the single control surface during pause.
- **No-cache headers on the SPA host page** (`packages/web/index.html` + server response on `/` and `/index.html`). Prevents the "stale browser bundle" class of bug where users navigating after a server upgrade load the cached `index.html` → cached asset hashes → cached JS still in memory. Vite's content-hashed `/assets/*` get aggressive caching (`max-age=31536000, immutable`) since their content can never change for the same URL. Net cost: one ~0.4 KB `index.html` round-trip per page load; net benefit: no more stale-SPA bugs after server upgrades.

### Changed

- `BaseHistoryEvent.logFile` and `BaseHistoryEvent.agent` now optional (mirrors core type). User-action events (`loop-stopped`) correctly omit them.

## [0.16.6] -- 2026-05-02

Tagged but **not published to npm or GitHub Releases** — internal release for local-install dogfooding. Skips `0.16.5` on npm (which was also tag-only); the next published release will jump from `0.16.4` directly to whatever's current at the time.

Includes the contents of the `0.16.5` tag (UX bundle + 5.15 research + workspace settings UI note) **plus** the items below.

### Added — Reflection `recommend_stop=true` disambiguation on judge SUCCESS (precursor fix)

Shipped via PR #26 (`fix/reflection-success-disambiguation`, 2026-05-01). Surfaced during dogfooding the tracker workspace: iter-5 had judge `SUCCESS` (9/10, 20/20 tests, plan 100%); reflection ran via the `reflectSafeguardAfter=3` ceiling, observed "loop has nothing left to do", set `recommend_stop=true` — harness misinterpreted the agreement as a stuck-loop signal and surfaced a "Questions needing your input" popup.

`makeDecision` now disambiguates `recommend_stop=true` on judge SUCCESS via `iteration_health`:

- `converging` / `stable` → reflection AGREES with SUCCESS; let the judge's determination handle the stop (no popup)
- `stalled` / `diverging` / `inconclusive` → reflection DISAGREES with SUCCESS; surface the popup so the user can arbitrate

On non-SUCCESS judge determinations, `recommend_stop=true` retains its original meaning (loop stuck → pause + popup) regardless of `iteration_health`.

5 new unit tests in `iteration-loop.test.ts` covering each `iteration_health` value × judge=SUCCESS combination.

### Added — Structured pause actions (item 6.25)

When the iteration loop pauses for arbitration, the user now picks **one of five structured actions** that drives the harness's next move; the textarea remains optional context routed to the right destination per action. Surfaced 2026-05-01 during dogfooding; full design + matrix in [`docs/research/structured-pause-actions-design.md`](docs/research/structured-pause-actions-design.md); root-cause + lessons in [`docs/decisions-log.md`](docs/decisions-log.md) (2026-05-02 entry).

- New `ResumeAction` enum: `continue` (default; resume next iter w/ feedback as dev context) | `finish_loop` (run documenter if `autoDocumenter=true`, else just terminate) | `stop_loop_now` (immediate termination, no docs regardless of config; feedback captured to audit history) | `refine_plan` (sync architect re-review with feedback, then continue) | `consult_reflection` (escape hatch: reflection consults user feedback + state, sets `harness_action_recommendation`, harness routes per recommendation).
- Reflection signals gain `harness_action_recommendation?: "continue" | "finish_loop" | "stop_loop_now" | "pause_for_user"` — set only when reflection runs in consult mode.
- New `LoopStoppedHistoryEvent` (`type: "loop-stopped"`) captures `stop_loop_now` events with the user's feedback as audit; written to both `history.json` (structured) and `iteration-history.md` (narrative paragraph).
- `pauseReasonAllowedActions(pauseReason, signals?)` helper — single source of truth for which actions apply per pause case (drives UI button visibility AND CLI argument validation).
- API: `POST /api/workspaces/:id/loop/resume` body now accepts `action?: ResumeAction` (defaults to `"continue"` for back-compat).
- CLI: `cfcf resume --action <continue|finish_loop|stop_loop_now|refine_plan|consult_reflection>` with `choices()` validation. Default `continue`.
- Web UI: `FeedbackForm` rewritten as contextual button matrix — shows only the buttons applicable for the current pause case. **No bare "Resume"** — user explicitly picks an action.
- Documenter runner accepts optional `userFeedback`, appended to its prompt as user direction.
- Reflection runner gains `consultMode: boolean` + `userFeedback` opts; in consult mode the prompt instructs the agent to set `harness_action_recommendation`.
- `runLoop` switches on `state.resumeAction` at the top: `stop_loop_now` and `finish_loop` terminate early; `refine_plan` runs architect synchronously then falls through; `consult_reflection` runs reflection in consult mode and routes per the recommendation.
- 10 new unit tests covering the `pauseReasonAllowedActions` matrix (9 pause cases × applicable subsets) — total `iteration-loop.test.ts` count: 43 (was 33).

### Docs

- `docs/guides/workflow.md` "User actions at pause points" section rewritten with the 5-action table + per-action examples + `stop_loop_now` vs `cfcf stop` clarification.
- `docs/decisions-log.md` 2026-05-02 entry capturing the design journey + 5 lessons learned (semantics-as-protocol-vocabulary, signals-as-contract, symmetry-is-misleading, free-text-is-precious, escape-hatch-is-a-feature).
- `docs/research/structured-pause-actions-design.md` updated with locked-in decisions (rename `stop_and_document`→`finish_loop` + `stop`→`stop_loop_now`, allow A6 consult, mandatory action, dual history write).

### Changed

- `BaseHistoryEvent.logFile` and `BaseHistoryEvent.agent` are now optional (were required) — user-action events like `loop-stopped` don't have an associated agent or log file.

### Compatibility

- API: pre-6.25 callers omitting `action` still get `"continue"` behavior identical to the previous default.
- CLI: pre-6.25 invocations of `cfcf resume --feedback "..."` still work; default action is `continue`.
- No agent prompt changes for routine post-iteration reflection runs — the new `harness_action_recommendation` field is documented in consult-mode prompts only.

## [0.16.5] -- 2026-05-01

UX-improvement bundle. Tagged but **not published to npm or GitHub Releases** — these are internal polish over 0.16.4 (no breaking changes, no urgency to push to users). Next published release will jump from 0.16.4 to whatever's current at the time.

### Changed

- **`cfcf server start` banner** rewritten. Now reports Web UI URL, API URL, Clio DB path (with doc count + active embedder, with graceful fallback if the stats fetch fails), logs path, and PID — labelled-list format aligned with `cfcf server status`. Replaces the previous two-line `started on port X (pid: Y)` output.
- **`cfcf init` already-configured message** — when run on a machine that already has a config, points the user at `cfcf config show`, `cfcf config edit`, and `cfcf init --force` (was: only `--force` mentioned).
- **`scripts/install.sh` post-install banner** gains `cfcf server start` + `cfcf workspace init --repo <path> --name <name>` between `cfcf doctor` and `cfcf --help`. Walks new users from "I just installed cfcf" → "I'm tracking my first repo" without a doc round-trip.
- **Post-install / post-upgrade banner unified across all three install paths** (curl-bash install.sh, npm postinstall, `cfcf self-update`). Replaces the heavy `╔══╗` box + numbered steps + parenthetical caveats with the same indented `command  # comment` format the install.sh + `cfcf server start` banners use. Drops the `printFollowUp` redundancy in `self-update.ts` (its two lines were already covered by the box).
- **Single source of truth for version**. `resolveVersion()` in `packages/core/src/constants.ts` now finds the **monorepo root** `package.json` (identified by its `workspaces` field) instead of stopping at the first workspace sub-package. Per-package `version` fields removed from `packages/{core,cli,server,web}/package.json` — they had drifted (root said `0.16.4`, sub-packages said `0.16.1`) and were ignored at publish time anyway. Dev mode now reports `<root.version>-dev` accurately.

### Added

- **`cfcf doctor` "Install location" check** — reports where the running cfcf binary lives on disk, categorised against the known install paths (canonical `~/.bun/lib/node_modules`, Bun-only alternative `~/.bun/install/global`, legacy `~/.npm-global`, dev mode). Diagnostic / informational only; symmetric with `uninstall.sh`'s multi-location detection.
- **`scripts/local-install.sh`** — wraps `stage-dist.sh` + `install.sh` + `cfcf doctor` into a single command for end-to-end local UX testing of install-pipeline changes. Auto-derives version label from root `package.json` (`v<root.version>-local`); cleans existing cfcf install first by default (`--keep` to skip). After the session, restore the published version via `cfcf self-update --yes`.
- **`scripts/README.md` "Developer workflow" section + `CONTRIBUTING.md` "Local development" section** — three-mode iteration story (dev mode → local-install → real release) with when-to-use guidance for each.
- **`README.md` "End-to-end UX testing" subsection** under Development — points contributors at `local-install.sh`.
- **`docs/research/pa-ha-web-ui-investigation.md`** — research deliverable for plan item 5.15. Industry survey + cfcf-specific analysis + L0–L5 spectrum + 6 options with trade-offs. Recommendation: small additive bundle (B1 + B2 + B5) for HA discoverability + PA Clio-write surfacing; defer interactive-in-browser (xterm.js / shadow chat / two-surface) until a real use case appears. Plan row 5.15 marked ✅ (research scope complete; v1 implementation is a separate plan entry to be opened when work begins).
- **Workspace Settings UI note** — clarification paragraph at the bottom of the per-workspace Settings → "Agent roles" section explaining that Product Architect (`cfcf spec`) and Help Assistant (`cfcf help assistant`) are configured globally, with a link to the global Settings page. Closes a UX-discoverability gap; an earlier hotfix attempt (`ee15bd2`, reverted in `d35fa59`) tried to add per-workspace overrides for those two roles but was wrong — the launchers don't read workspace-level config and the workloads don't motivate per-workspace tuning. The lighter-touch note is the right answer; full design discussion in PR #25.

## [0.16.4] -- 2026-05-01

Friction-free install: curl-bash one-liner; cfcf installs into `~/.bun` via `npm install -g --prefix ~/.bun`. Full design rationale + the four-option journey: [`docs/decisions-log.md`](docs/decisions-log.md) (2026-05-01 install entry).

### Added

- `curl -fsSL .../install.sh | bash` one-liner that bootstraps Bun + npm if missing, then runs `npm install -g --prefix ~/.bun @cerefox/codefactory`. Prints a next-steps banner; conditionally adds an "IMPORTANT" block when `~/.bun/bin` isn't on the parent shell's PATH (first-time Bun users only) and a server-restart hint when a cfcf server was running.
- `INSTALL.md` asset on every GitHub Release.
- `troubleshooting.md` sections for "`cfcf` not found after running `install.sh`" + EACCES + the bun-trust workaround.
- `cfcf doctor` "Install location" check — reports where the running cfcf binary lives on disk, categorised against the known install paths (canonical `~/.bun/lib/node_modules`, Bun-only alternative, legacy `~/.npm-global`, dev mode). Diagnostic / informational only; symmetric with `uninstall.sh`'s multi-location detection so users troubleshooting "which cfcf am I actually running?" get a single-line answer.

### Upgrade note

- **From 0.16.2: `cfcf self-update` works but uses Bun's install path** (0.16.2's `self-update.ts` predates the v0.16.4 npm rewrite). Cleaner upgrade: `bun remove -g @cerefox/codefactory @cerefox/codefactory-native-*` once, then re-run `install.sh`. From 0.16.4 onwards, `cfcf self-update` uses the new npm-with-prefix flow.

### Changed

- `scripts/install.sh` rewritten to use `npm install -g --prefix ~/.bun` (replaces both the v0.16.3 `bun install -g` flow and a v0.16.4 draft using `~/.npm-global`). install.sh writes nothing to the user's shell rc.
- `scripts/uninstall.sh` detects cfcf at all known install locations (`~/.bun/lib/node_modules`, `~/.npm-global`, npm system prefix, `~/.bun/install/global`) and cleans each via the right tool. Per-platform native package removed alongside the main package.
- `packages/cli/src/commands/self-update.ts` mirrors install.sh's destination (`npm install -g --prefix ~/.bun`).
- Published `trustedDependencies` in `scripts/build-cli.sh`: `["onnxruntime-node", "sharp"]` → `["onnxruntime-node", "protobufjs"]` (sharp no longer has a postinstall; protobufjs does).
- Docs sweep — `README.md` + `docs/guides/installing.md` + `docs/guides/manual.md` + `docs/guides/troubleshooting.md` + `docs/guides/cli-usage.md` + `docs/design/cfcf-stack.md` updated to match the shipped install flow. `docs/research/installer-design.md` banner-marked as historical.
- `docs/plan.md` rows 5.5b + 5.14 marked ✅.

## [0.16.3] -- 2026-05-01

npm publish pipeline switched to **OIDC trusted publishing** + sigstore provenance for all 4 `@cerefox/codefactory*` packages. Bootstrap-vs-durable auth rationale + threat model: [`docs/decisions-log.md`](docs/decisions-log.md) (2026-05-01 npm publish auth entry).

### Changed

- `release.yml`: `NPM_TOKEN` removed; `permissions: id-token: write` added; each package's npmjs.com page now lists this repo's `release.yml` as a Trusted Publisher. Only `release.yml` on `fstamatelopoulos/cfcf` (manually triggered with `publish_to_npm=true`) can publish new versions.
- All `npm publish` calls use `--provenance`. Each tarball now carries a sigstore-signed attestation visible as a "Provenance" badge on npmjs.com.
- Workflow uses Node 22 + `npm install -g npm@latest` to satisfy npm CLI ≥ 11.5.1 (the Trusted Publishing minimum; Node 22 ships npm 10.x). Pre-flight version check fails fast if the install lands below 11.5.
- Publishing access on all 4 packages set to "Require 2FA and disallow tokens (recommended)".
- `README.md` Install section: leads with `bun install -g @cerefox/codefactory`; "once cfcf is on npmjs.com" hedging removed; Status section trimmed (long-form history moved to `docs/plan.md` / `CHANGELOG.md` / `docs/decisions-log.md`).
- `docs/guides/installing.md`: 3-step quick install (Bun → cfcf → verify), curl-bash wrapper as alternate, tarball/offline separate.
- `docs/guides/manual.md` + `docs/guides/troubleshooting.md` install snippets: stale `cfcf-releases` references swapped for `bun install -g @cerefox/codefactory`.

### Removed

- `NPM_TOKEN` repo secret. The bypass-2FA npm token used to bootstrap v0.16.2 was revoked.

## [0.16.2] -- 2026-05-01

**First public release on npmjs.com.** Closes plan item 5.5b. The 4 published packages:

- [`@cerefox/codefactory`](https://www.npmjs.com/package/@cerefox/codefactory) — the CLI (~388 KB)
- [`@cerefox/codefactory-native-darwin-arm64`](https://www.npmjs.com/package/@cerefox/codefactory-native-darwin-arm64)
- [`@cerefox/codefactory-native-darwin-x64`](https://www.npmjs.com/package/@cerefox/codefactory-native-darwin-x64) — cross-compiled on macos-14 via `clang -arch x86_64`
- [`@cerefox/codefactory-native-linux-x64`](https://www.npmjs.com/package/@cerefox/codefactory-native-linux-x64)

Package-naming, license, going-public sweep, and `os`/`cpu` decisions: [`docs/decisions-log.md`](docs/decisions-log.md) (2026-04-30 going-public entry).

### Added

- `LICENSE` (Apache-2.0) at repo root. Published packages' license switched from `UNLICENSED` to `Apache-2.0`.
- `SECURITY.md` + `CONTRIBUTING.md` at repo root.
- `release.yml`: `publish_to_npm` `workflow_dispatch` input (default OFF — GitHub Release leg unchanged); unconditional `npm publish --dry-run` canary job; gated real `npm publish --access public` job (native packages first, CLI second) that runs only when `publish_to_npm=true` AND the dry-run passed.
- `os` + `cpu` declared on the main package (`darwin`/`linux` × `arm64`/`x64`) so unsupported platforms fail fast with `EBADPLATFORM`.
- Post-install banner item: "First time? Run `cfcf doctor && cfcf init`" so direct-`bun install -g` users get the same first-run nudge as `install.sh` users.

### Changed

- npm package name: `@cerefox/cfcf-cli` → `@cerefox/codefactory`. Per-platform native packages: `@cerefox/cfcf-native-*` → `@cerefox/codefactory-native-*`. CLI binary stays `cfcf`.
- Repo flipped from private to public on GitHub (2026-04-30) after a clean `gitleaks` sweep on 351 commits / 4.43 MB of history.
- `scripts/install.sh` defaults to npm; tarball mode auto-engages when `CFCF_BASE_URL` is set or with `CFCF_INSTALL_SOURCE=tarball`.
- `scripts/build-cli.sh` version resolution: positional arg → `CFCF_VERSION` env → root `package.json` (was hardcoded `v0.0.0-dev`). Published `package.json` carries proper npm metadata (`repository`, `homepage`, `bugs`, `keywords`, `description`).
- Cross-compile darwin-x64 on macos-14 via `clang -arch x86_64` (replaces macos-13, whose runner pool became unviable for free-tier public repos).
- `cfcf self-update` rewritten to mirror `install.sh`'s install-source resolution. Default: `bun install -g @cerefox/codefactory@latest`. Latest-version detection via `https://registry.npmjs.org/@cerefox/codefactory/latest`. 17 unit tests cover the resolver.

### Removed

- Legacy `@cerefox/cfcf-*` resolution fallback in `constants.ts` / `clio/db.ts` / `doctor.ts` (security — hard cut).
- Dead-code MANIFEST detection in self-update (silently failing since 5.5).

## [0.16.1] -- 2026-04-29

### Bug fixes

- **`iteration-history.md` now includes the final iteration of every loop run.** Previously the history rebuild only fired at the START of each iteration (inside `writeContextToRepo`), so iter-N's own log was never folded in unless iter-N+1 kicked off — meaning every loop's last iteration was permanently missing from history.md. The fix adds an end-of-dev-phase rebuild via a new `refreshIterationHistory` helper in `context-assembler.ts`, called from `iteration-loop.ts` right after `archiveHandoff`. Best-effort: a rebuild failure logs a warning but doesn't fail the iteration. Surfaced in dogfood by the Product Architect spotting that iter 4's log was on disk but history.md still stopped at iter 3. PR #23.

### CI

- **`Embed help bundle` step added to the test job** (`.github/workflows/ci.yml`). The typecheck depends on `packages/core/src/help-content.generated.ts` (gitignored, generated by `scripts/embed-help-content.ts`); the workflow already had the equivalent step for the web bundle but not the help bundle. Pre-existing silent failure — CI had been red on `main` for ~5 consecutive runs since v0.15.0; nobody noticed because no required-status-check gate exists yet (private-repo limitation; revisited when going public).

### Documentation

- New decisions-log entry: **"Codex `failed to record rollout items: thread ... not found` is benign telemetry noise; we don't filter it"** — captures the dogfood-time investigation of the codex stderr warning that PA flagged alongside the iteration-history bug. Records why we don't filter (codex stderr ≠ cfcf stderr; risks masking real errors) + what would change our mind (co-occurrence with actual breakage / codex documents an opt-out / wording stabilises enough to filter safely).

## [0.16.0] -- 2026-04-29

### Product Architect role (5.14)

A new top-level SDLC role: **`cfcf spec`** launches the Product Architect (PA), an interactive cf²-expert agent that owns the front of the SDLC — repo setup, workspace registration, Problem Pack authoring + iteration. PA is a peer to dev / judge / Solution Architect / reflection / documenter; unlike them, it runs **interactively** (your shell, agent's TUI). It has the entire cfcf documentation bundle in its system prompt, so it understands the SDLC end-to-end and can guide spec authoring with full context.

```
cfcf workspace init   →   cfcf spec   →   cfcf review   →   cfcf run   →   cfcf reflect / cfcf document
                          ↑
                          NEW: interactive Problem Pack authoring + iteration
```

#### CLI

```
cfcf spec [task...]                                  # interactive PA session on cwd
cfcf spec --repo <path>                              # explicit repo path
cfcf spec --agent claude-code                        # override config.productArchitectAgent
cfcf spec --print-prompt                             # debug: emit prompt + exit
cfcf spec --safe                                     # opt back into per-command permission prompts
cfcf spec "Tighten the success.md auth criteria"     # opens with this task
```

#### Behaviour

- **Self-introduces on launch** (Flavour A). Both claude-code and codex accept a positional `[PROMPT]` argument that becomes the user's opening message in interactive mode — the agent responds immediately rather than waiting for the user to type. Default greeting triggers PA's session-start protocol; an explicit `[task...]` argument flows in as the task verbatim.
- **State assessment at launch**. cfcf computes + injects: repo path, git status, workspace registration (symlink-aware), cfcf server status, iteration history (if any), Problem Pack file states under `<repo>/problem-pack/`, `.cfcf-pa/` cache contents, memory inventory, session_id. PA's first response branches on this snapshot.
- **Drives setup itself**. On a fresh repo PA insists on `git init` + `cfcf workspace init` first (collects workspace name in conversation, then runs the command non-interactively). No `--bootstrap` flag needed.
- **Full permissions by default**, mirroring the iteration-time agents (the user accepted this trust contract at `cfcf init`):
  - claude-code: `--dangerously-skip-permissions`
  - codex: `-c approval_policy=never` + `-c sandbox_mode=danger-full-access` (the latter lifts codex's loopback restriction so cfcf CLI commands that hit `localhost` work from inside the agent's sandbox)
- **`--safe` opt-out** for cautious sessions: claude reverts to default permission mode; codex reverts to `untrusted` + `workspace-write` sandbox.
- **Hard "no implementation drift" boundary** in the prompt — PA refuses to play dev / judge / SA / reflection / documenter and redirects to the right role.
- **Cost + control framing**: when PA could plausibly run something the user might prefer to drive themselves (`cfcf run`, watching a long process), PA nudges toward user-driven control. Token cost is mentioned as a dimension, not a refrain.

#### Memory architecture (disk + Clio hybrid)

A **three-tier** memory model for per-workspace continuity:

| Tier | Where | Naming | Purpose | Compactable? |
|---|---|---|---|---|
| A — Digest | Clio | `pa-workspace-memory` (one per workspace, fixed title; Project: `cfcf-memory-pa`) | Rolling summary: current state + recent sessions verbatim + older sessions one-line + cumulative decisions/preferences. Injected into every PA prompt. | YES — gets shrunk in place when > 30 KB |
| B — Archive | Clio | `pa-session-<sessionId>` (one per session; Project: `cfcf-memory-pa`) | Full session transcript captured at save time. Listed (titles + outcomeSummary) in the prompt's Memory Inventory; full content fetched on demand. | NEVER — immutable canonical history |
| C — Disk log | `<repo>/.cfcf-pa/session-<sessionId>.md` | one per session | Live scratchpad written turn-by-turn during the session. Identical to Tier B but local + immediate. | NEVER |

Plus a single cross-workspace doc: **`pa-global-memory`** (Project: `cfcf-memory-global`, shared with HA). User preferences spanning all workspaces (TDD, language, test framework). Lives only in Clio.

**Disk + Clio asymmetry**:
- Disk = canonical LIVE memory; updated **turn-by-turn** (every user message). Nothing is lost on Ctrl-D.
- Clio = durable cross-machine backup; updated at session end (or sooner per user preference / explicit request).
- The prompt explicitly tells PA to answer "did you save?" by acknowledging both layers and never to say "partially saved" when disk is up to date.
- If `pa-global-memory` records a cadence preference (e.g. "update memory on every prompt"), PA honours it as standing permission — no per-turn re-asking.

**Project-agnostic reads** in cfcf: at launch, cfcf reads `pa-workspace-memory` + `pa-global-memory` by metadata triple (role + artifact_type + workspace_id), NOT scoped by Clio Project. This is robust to docs that historically auto-routed to `default` before the launcher's pre-create step landed. The launcher pre-creates `cfcf-memory-pa` + `cfcf-memory-global` Projects on every launch so future writes land correctly.

#### Workspace history + web UI

- **`pa-session` event type** added to the workspace History tab. Each PA session appears as a `Product Architect · session` row with status / agent / outcome columns (the row label is consistent with the broader `<Role> · <task>` rename: `Dev + Judge · iter N`, `Solution Architect · review`, etc.).
- **Rich detail panel** (`PaSessionDetail.tsx`): expands to show session bracket info, pre-state pills (git? workspace registered? problem-pack file count), outcome summary, Clio doc UUID (when synced), tabbed body (Session log / Workspace summary / meta.json) with full Markdown rendering.
- **New API endpoint** `GET /api/workspaces/:id/pa-sessions/:sessionId/file` serves the session scratchpad + workspace summary + meta.json in one request.
- **Status tab broadens** to track PA activity — when one or more PA sessions are running, the Status tab shows them with live duration; when the workspace's most recent activity was a PA session, it shows up as "Last Product Architect session" with outcome summary. The empty-state message ("nothing has run yet") only fires on a truly empty workspace + now mentions `cfcf spec` alongside Review + Start Loop.

#### Plumbing

- **`productArchitectAgent: AgentConfig`** on `CfcfGlobalConfig`, backfilled to `architectAgent`'s adapter (broad-context profile; closer to PA's spec-iteration workload than dev's). For claude-code the default model is **Sonnet** (HA defaults to Haiku). Codex stays account-tied.
- **`cfcf init`** gains a 7th role picker (Product Architect alongside the existing six). `cfcf config show` prints the row.
- **Web UI**: Server Info page's agent-roles section lists PA. Role label for the Solution Architect updated to "Solution Architect" (was "Architect") to disambiguate from PA at a glance.
- **`cfcf doctor`** "Product Architect prerequisites" check verifies a supported agent CLI is reachable.
- **Race-condition fix**: `cleanupStaleRunningEvents` (called on server startup to recover from crashed iteration agents) now skips `pa-session` events. PA agents run in the user's terminal — server restart doesn't affect them — so marking them failed at cleanup time would corrupt an actually-running session.
- **macOS symlink fix**: workspace registration lookup uses `realpath` (with safe fallback). Prior bug: `process.cwd()` returns `/private/tmp/...` while `cfcf workspace init --repo /tmp/...` stored the literal `/tmp/...`; plain string compare missed the match and PA reported the workspace as unregistered.

#### Module shape

- `packages/core/src/product-architect/` — 4 source files (`prompt-assembler.ts`, `state-assessor.ts`, `memory.ts`, `launcher.ts`) + index. **68 unit tests**.
- `packages/cli/src/commands/spec.ts` — wires the top-level `cfcf spec`.
- `packages/web/src/components/PaSessionDetail.tsx` — the rich detail panel.
- `packages/web/src/utils/markdown.tsx` — Markdown renderer extracted from the Help tab so PA + Help share it.

### Help Assistant — self-introduction (5.8 follow-up)

`cfcf help assistant` now self-introduces on launch via the same Flavour A pattern as PA. Mirrors HA's role briefing: the agent introduces itself + asks what you'd like help with, instead of opening to an empty prompt. Default greeting in `cli/src/commands/help.ts`; argv builder appends the positional `[PROMPT]` last.

### Documentation

- **NEW** `docs/guides/product-architect.md` — dedicated PA reference (~13 KB, 8th help topic; aliases `pa`, `product-architect`).
- **Updated**: `manual.md` (5 → 7 agent roles framing), `workflow.md` (Step 4 leads with `cfcf spec` over manual editing), `cli-usage.md` (full PA section), `clio-quickstart.md` (role-specific Clio Projects table), `troubleshooting.md` (5 PA-specific scenarios), `api/server-api.md` (history `pa-session` row + new endpoint).
- **NEW** decisions-log entry (2026-04-29): "Embed the full cfcf docs into interactive role agents' system prompts" — captures the breakthrough validated in dogfood.
- **Design baseline**: `docs/research/product-architect-design.md` (the canonical design reference; supersedes the deleted v1 doc).

### Glossary changes worth highlighting

- `<repo>/problem-pack/*` — the user-owned Problem Pack files. cfcf-managed artifacts live separately under `<repo>/cfcf-docs/`.
- `<repo>/.cfcf-pa/*` — Product Architect's working memory cache (gitignore-friendly).
- `pa-workspace-memory`, `pa-session-<id>`, `pa-global-memory` — standardised Clio doc titles + naming convention.
- `session_id` — timestamp-based UUID PA generates at every launch; tagged into all memory writes; surfaced in the workspace history.

---

_Other iter-6 backlog: web UI integration research for HA + PA roles (5.15), CLI verb-rename audit for the remaining cfcf top-level verbs, Clio FTS title boost (6.24)._

## [0.15.0] -- 2026-04-28

Plan item **5.8 PR4** v1: Help Assistant (`cfcf help assistant`) — interactive cf² support agent that runs the user's configured dev agent (claude-code / codex) in the current shell with a curated system prompt + the full embedded help bundle + Clio memory access. Plus a substantial follow-up sweep of fixes flagged immediately in dogfood.

### Help Assistant (5.8 PR4)

`cfcf help assistant` launches an interactive cf² support session. The agent CLI's TUI takes over the current shell until exit — no new terminal, no chat UI inside cfcf, no fragile OS-spawning. **Read-only by default; mutations gated by the agent CLI's per-command permission prompt** (no `--dangerously-skip-permissions`). Replaces the original "Ask the Agent" one-shot design (now superseded; see `docs/research/ask-the-agent.md`).

Architecture:

- **HA is a cf² role**, like dev / judge / architect / reflection / documenter. New `helpAssistantAgent` field on `CfcfGlobalConfig` defaults to `devAgent`'s value.
- **System prompt** (~170 KB) embeds the full help bundle + Clio memory inventory + optional workspace state. Comfortably within modern context windows.
- **Clio "memory" Projects** are the persistence layer:
  - `cfcf-memory-global` — cross-role: things every cf² role should know about this user (e.g. "always TypeScript", "Pacific time zone")
  - `cfcf-memory-ha` — HA-specific lessons / preferences
  - Future per-role projects (`cfcf-memory-pa` etc.) reuse the same scheme

CLI:

```bash
cfcf help assistant                          # launch with config defaults
cfcf help assistant --workspace my-project   # include workspace state in system prompt
cfcf help assistant --agent claude-code      # override config.helpAssistantAgent
cfcf help assistant --print-prompt           # debug: emit the assembled prompt + exit
```

Adapter support (researched empirically — both verified end-to-end):

| Adapter | Flag | Default model |
|---|---|---|
| **claude-code** | `--append-system-prompt <text>` (inline) | **`haiku`** — HA's Q&A workload doesn't need a top-tier model; haiku is ~10× faster + ~12× cheaper. Explicit model in config still wins. |
| **codex** | `-c model_instructions_file=<tempfile>` (the canonical config key; `experimental_instructions_file` is deprecated but still accepted with a warning) | account-default; launch banner hints at `/fast` for in-session model switching since codex's `--model` is account-tied and can fail for ChatGPT-account installs |

Codex tempfile is cleaned up in a `finally` block on every exit path (success, error, Ctrl-C).

UX / discoverability:

- **`cfcf help assistant` is a real subcommand**, not a positional value, so tab completion picks it up automatically.
- **Levenshtein-based "did you mean?"** for typo'd topics: `cfcf help assitant` → "Did you mean: cfcf help assistant?"
- **Launch banner** spells out the abbreviation: `[Help Assistant (ha)] launching claude-code (haiku); type your question. Ctrl-D to exit.`

Configuration plumbing:

- **`cfcf init`** interactive flow now prompts for both Help Assistant AND Reflection (both were previously missing — relied on backfills). Heal-on-existence covers both when re-running with `--force`. Matching model prompts.
- **`cfcf config show`** displays Help Assistant alongside the other roles.
- **`cfcf config edit`** delegates to `init --force`; inherits the new prompts.
- **Web UI Server Info** agent-roles section automatically picks up `helpAssistantAgent` (the editor + readout are data-driven via `ROLE_KEYS`).

Doctor:

- New **"Help Assistant prerequisites"** check verifies at least one supported agent CLI is reachable. Best-effort: `warn` worst case, never `fail`.

Architecture documentation (for iter-6):

- `docs/research/help-assistant.md` §"Alternative approaches considered" captures **two valid patterns** for system-prompt injection:
  - **Pattern A** — `model_instructions_file` tempfile via `-c` (used by HA): ephemeral, system-level, independent of any pre-existing AGENTS.md.
  - **Pattern B** — `cfcf-docs/AGENTS.md` + `--cd` + initial-prompt task hint (reserved for iter-6 PA): durable per-repo guidance for the role that writes Problem Pack files. Codex auto-loads AGENTS.md from cwd; claude-code's analog is CLAUDE.md.
- Plan item 5.8 PR5 (iter-6 PA) inherits this comparison.

Deferred to iter-6:

- **Product Architect (PA) role** — same architecture, narrower scope (Problem Pack creation + spec iteration); uses Pattern B (AGENTS.md/CLAUDE.md auto-load).
- **Web UI Help Assistant button** — once CLI flow is dogfooded.
- **Multi-turn session persistence** across cf² restarts.
- **Smarter memory retrieval** (v1 dumps the whole memory project; iter-6 retrieves selectively).

### Bun-dedup workaround (v3 — finally correct)

`bun install -g <local-tarball>` appends duplicate `"<key>": <value>` entries to `~/.bun/install/global/{package.json,bun.lock}`. After the previous two attempts at a fix (silent `JSON.parse` round-trip; identical-line dedup; content-based keep-last) each missed a different aspect, the final fix is **run-based key-dedup keeping the LAST occurrence**, tracked by **index** (not content — content equality is undecidable when content is identical). Empirically verified: zero `Duplicate key` warnings on first AND subsequent installs.

Full lessons captured in `docs/decisions-log.md` (2026-04-28 entry "Bun-dedup workaround: lessons from getting it wrong three times"):

1. Best-effort code that fails silently is a debugging trap.
2. Empirical loop > assumptions about file structure.
3. When deduping, track by stable identifier (index) not by content.
4. Dump file state between operations.

### Brand consistency: cf² in user-facing surfaces, cfcf in code

Convention now codified in `docs/decisions-log.md`:

- **`cf²`** in user-facing documentation, UI labels, prose mentions, headings — the brand.
- **`cfcf`** in source code, CLI commands, file paths, package names, env variables, sentinel comments — the keystroke-friendly form.

Sweep applied to `docs/guides/manual.md`, `troubleshooting.md`, `installing.md`. Embedded help bundle regenerated.

### Other UX fixes that landed alongside

- **`cfcf help` (no arg) prints a glanceable hub** instead of dumping the full 280-line manual. Same shape as `git help`, `gh help`, `kubectl help`. The full manual is still available via `cfcf help --full`. Hub now mentions `cfcf --help` for the standard command listing.
- **Web UI Help tab dark-mode contrast** fixed — switched every inline style to use the existing CSS variable theme tokens.
- **Tab completion picks up `cfcf help assistant`** — removed a stale filter in the completion generator that was skipping the `help` command entirely (a leftover from when commander's auto-help was conflicting).
- **`cfcf` help output** no longer shows HA-only flags on the parent command — they live on the `assistant` subcommand only.

Plan item 5.8 PR4. Full design + decisions in `docs/research/help-assistant.md`.

## [0.14.2] -- 2026-04-27

Brand-consistency fix in user-facing docs.

- **Established convention** (recorded in [`docs/decisions-log.md`](docs/decisions-log.md)): **"cf²"** in user-facing documentation and UI; **"cfcf"** only in source code, CLI commands, file paths, and package names.
- The user-manual + help-bundle work in v0.14.0 mixed both forms in the user-facing prose. Swept `docs/guides/manual.md`, `troubleshooting.md`, and `installing.md` to use `cf²` for prose mentions while preserving `cfcf` for CLI commands (`cfcf help`), config paths (`~/.cfcf/`), package names (`@cerefox/cfcf-cli`), and source-code references (`packages/core`).
- Regenerated the embedded help bundle so `cfcf help` and the web UI Help tab pick up the corrected text.

## [0.14.1] -- 2026-04-27

Two UX fixes for the v0.14.0 user-manual + Help-tab work, both flagged immediately in dogfood:

- **Web UI Help tab: dark-mode contrast.** v0.14.0 hardcoded light-mode hex colors (`#1f2937`, `#6b7280`, `#f5f5f5`, …) inline. On the cfcf dark theme (`--color-bg: #0f1117`) they rendered as low-contrast / unreadable. Switched every inline style to use the existing CSS-variable theme tokens (`--color-text`, `--color-surface-alt`, `--color-border`, etc.), which is what the rest of the web UI already does. Topic list, code blocks, headings, blockquotes, links — everything now reads correctly.
- **`cfcf help` (no arg) now prints a glanceable hub** instead of the full ~280-line manual. Same shape as `git help`, `gh help`, `kubectl help`: one-line summary per topic + drill-in tips. The full manual is still available via `cfcf help --full`. Explicit topics (`cfcf help workflow`) still print in full as before. Discoverability without the wall-of-text.

## [0.14.0] -- 2026-04-27

Plan item **5.8 PR2 + PR3 + PR4 (design only)** combined. User manual + embedded help bundle + `cfcf help` + web UI Help tab. Ask-the-Agent design captured for iter-6 implementation.

### User manual + help content (5.8 PR2/PR3, combined)

- **`docs/guides/manual.md`** (NEW, hub-and-pointer style) — canonical entry point. 3-minute getting started + concepts + pointers to focused guides + Shell completion section + glossary. Replaces the implicit "read the README + scattered docs" experience with one clearly-labeled hub.
- **`docs/guides/troubleshooting.md`** (NEW) — dedicated diagnostics page covering "tab doesn't fire", "cfcf server won't start", "cfcf init fails to download embedder", "iteration stuck", "Clio search returns nothing", Bun dup-key warnings, Node 20 deprecation noise, oh-my-zsh / prezto / starship interactions, asdf/mise/fnm Bun-version mismatch, worst-case clean reinstall.
- **`cli-usage.md` Clio section restructured** — was a single code-block dump; now one `### subsection` per verb matching the rest of the file's style. Adds a new top-level "Shell completion" section covering `cfcf completion {bash,zsh,install,uninstall}`, sentinel-marked rc-file behaviour, `--no-rc-edit`, manual-setup detection, supported shells.
- **`installing.md` refresh** — mentions auto-installed completion + rc-edit, links forward to `troubleshooting.md`, updates the doctor-check count.
- **README** — new "Start here" callout pointing at `manual.md`. Same pointer reused for `cfcf help` (via the embedded bundle below).
- **Embedded help bundle** — new `scripts/embed-help-content.ts` generator reads `docs/guides/*.md` + `docs/api/server-api.md` and emits `packages/core/src/help-content.generated.ts` (gitignored). Same pattern as `web-assets.generated.ts`. Survives `bun build --compile` and npm-format installs without external files at runtime. Wired into `scripts/build-cli.sh`.
- **`cfcf help [topic]`** — new CLI command. With no arg → prints the manual (default topic). With arg → resolves slug or alias (`cfcf help cli` → `cli-usage.md`; `cfcf help memory` → `clio-quickstart.md`; `cfcf help install` → `installing.md`; `cfcf help troubleshoot` → `troubleshooting.md`; `cfcf help api` → `server-api.md`). `--list` shows all topics + aliases. Output is plain Markdown — pipe through `glow` or `bat -l md` for prettified terminal rendering.
- **`/api/help/topics`** + **`/api/help/topics/:slug`** — new HTTP routes powering the web UI. Server reads from the embedded bundle; no filesystem lookup at runtime.
- **Web UI Help tab** — new top-bar `Help` link (next to `Settings`), route `#/help` (defaults to `manual`) / `#/help/<slug>`, two-pane layout (topic list on the left, rendered Markdown on the right). Minimal in-tab Markdown renderer (~100 LOC, no external library) handles headings/paragraphs/lists/fenced-code/inline-code/bold/em/links/blockquote/hr. Intra-doc `.md` links rewrite to `#/help/<slug>` so they navigate the Help tab in-place; external URLs open in a new tab.
- **`cfcf doctor` "User manual + help content" check** — verifies the embedded bundle is present and the canonical topics (`manual`/`workflow`/`cli`/`troubleshooting`) are all there. Best-effort: `warn` worst case.

## [0.13.0] -- 2026-04-27

Plan item **5.8 PR1b**: tab completion (zero-config across every install path) + Bun-bug workaround + GitHub Actions hardening + iter-6 plan entry for Clio FTS title boosting.

### Tab completion (5.8 follow-up)

- **`cfcf completion bash`** + **`cfcf completion zsh`** — emit static shell completion scripts derived from the commander.js command tree at script-generation time. No runtime dependency on `cfcf` per tab press (fast: no Bun cold-start).
- **`cfcf completion install`** — auto-installs the completion file AND auto-adds a sentinel-marked block to the user's `~/.zshrc` / `~/.bashrc` so tab-complete just works after the next shell reload. Same convention as bun, nvm, rbenv, pyenv, fnm, mise. Trust principle preserved: cfcf only modifies content **between** the `# >>> cfcf shell completion >>>` and `# <<< cfcf shell completion <<<` markers; the rest of the user's rc file is untouched. Pass `--no-rc-edit` to skip the rc edit (write only the completion script). Pass `--print-only` for the old print-instructions-only behaviour.
- **`cfcf completion uninstall`** — symmetrical: removes both the rc block and the completion script. User content outside the sentinels stays untouched. Idempotent.
- **Manual-setup detection.** If the user has their own `fpath=(~/.zsh/completions ...)` line or `source ~/.cfcf-completion.bash` line outside our sentinels, we leave their rc alone (`skipped-manual` action). cfcf doesn't fight users who hand-managed their setup.
- **`cfcf doctor` gains a "Shell tab completion" check** — verifies the completion script exists at the canonical path AND the user's rc file references it (either via our sentinel block or via a manual fpath/source line). Specific actionable hint when something's missing (e.g. "run `cfcf completion install`"). Best-effort: `warn` worst case, never `fail` — completion is a quality-of-life feature, not a correctness one.
- **Visible "next steps" banner** — every install path (`scripts/install.sh`, `cfcf self-update`, `bun install -g` postinstall) ends with a bordered ASCII banner showing the two one-time post-install actions: (1) reload shell to activate completion, (2) restart cfcf server if it was running. ANSI-bold the action lines (TTY-conditional). Replaces the previous walls-of-text post-install output that buried the call-to-action.

### Bun bug workaround: deduplicate global package.json

- **Issue.** `bun install -g <local-tarball>` (and at least some non-registry URL forms) appends a duplicate key to `~/.bun/install/global/package.json` on every install instead of overwriting. After a few iterations of `cfcf self-update` or `scripts/install.sh`, the file accumulates dozens of duplicate `"@cerefox/cfcf-cli"` keys and bun spams `warn: Duplicate key` on every subsequent install (hundreds of warnings on tarball reinstalls). Functionally harmless (last-occurrence wins on parse) but extremely noisy.
- **Fix.** `scripts/install.sh` and `cfcf self-update` both dedup the file before invoking `bun install -g`: parse + restringify (JSON.parse keeps the last occurrence of duplicate keys, so a round-trip yields a clean object). Best-effort — never fails the install.
- **Doctor check.** New "Bun global package.json (duplicate-key check)" diagnostic in `cfcf doctor` warns when accumulated dups are detected, with an actionable hint to re-run the installer (which auto-cleans).
- **Auto-installed on every install path.** No manual step needed:
  - `scripts/install.sh` calls `cfcf completion install` after `bun install -g`.
  - `cfcf self-update` regenerates after the in-place upgrade finishes.
  - **`bun install -g @cerefox/cfcf-cli`** (the 5.5b npmjs path) triggers a `postinstall` hook in the published `package.json` that runs the same regeneration. So the completion stays in sync with the actual verb tree across upgrades, regardless of which install method the user picked.
- **Source of truth = commander tree.** No hardcoded verb list to keep in sync — the generator walks `program.commands` recursively, so adding a new verb anywhere in the CLI flows automatically into the next regenerated completion script.
- Tab-complete works on every level of the CLI: `cfcf <TAB>` → top-level commands; `cfcf clio <TAB>` → namespaces + headline verbs; `cfcf clio docs <TAB>` → all doc verbs + flags; prefix completion (`cfcf clio doc<TAB>` → `docs`).
- 17 unit tests in `packages/cli/src/commands/completion.test.ts` cover tree-walking, deduped+sorted flags, autogenerated `help` filtering, bash/zsh script structure, idempotent regeneration across runs, fish/sh/empty-shell no-op behaviour, sandbox safety (only canonical paths get touched), and the dir-creation path for zsh's `~/.zsh/completions/`.

### CI workflow fixes

- **Artifact storage quota.** Reduced retention from 7d (CI smoke build) and 14d (release artifacts) to **1d** across the board. Release artifacts only need to outlive the workflow run — once attached to a GitHub Release they're served from there. CI's smoke artifact is debug-only. Addresses the artifact-quota-exceeded error on run [25021362097](https://github.com/fstamatelopoulos/cfcf/actions/runs/25021362097).
- **Node 24 compatibility.** Set `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"` at workflow level on both `ci.yml` and `release.yml`. Forces JavaScript-based actions (`upload-artifact`, `download-artifact`, `checkout`) onto Node 24 even when they declare Node 20. Workaround until the actions ship Node-24-default versions; addresses the deprecation warning per [GitHub's announcement](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/).
- **Bumped `actions/upload-artifact@v4 → v5` and `actions/download-artifact@v4 → v5` and `actions/checkout@v4 → v5`** in `release.yml` (CI was already on v5; aligned).

## [0.12.0] -- 2026-04-27

Plan item **5.8 PR1**: Clio CLI verb normalisation. BREAKING — no deprecation aliases (single user, pre-OSS-launch).

### CLI verb normalisation (BREAKING)

The Clio CLI now follows a single mechanical rule for noun-namespacing:

> 1. Collection-wide / Clio-wide / headline operations stay top-level (`search`, `audit`, `reindex`, `stats`).
> 2. Verbs that operate on a specific noun-instance go under that noun's namespace (`docs`, `projects`, `embedder`).
> 3. A sub-concept with multiple operations of its own gets its own namespace (`metadata`).

Verb moves (no deprecation aliases — clean break):

| Old | New |
|---|---|
| `cfcf clio ingest` | `cfcf clio docs ingest` |
| `cfcf clio get` | `cfcf clio docs get` |
| `cfcf clio versions` | `cfcf clio docs versions` |
| `cfcf clio delete` | `cfcf clio docs delete` |
| `cfcf clio restore` | `cfcf clio docs restore` |
| `cfcf clio metadata-search` | `cfcf clio metadata search` |
| `cfcf clio metadata-keys` | `cfcf clio metadata keys` |
| `cfcf clio project create` | `cfcf clio projects create` |
| `cfcf clio project show` | `cfcf clio projects show` |
| `cfcf clio project` (alias) | dropped |

Default actions: `cfcf clio docs` and `cfcf clio projects` default to `list`; `cfcf clio metadata` (no subcommand) prints help. The `cfcf memory` root alias still maps to the same tree.

Full proposal + killed-alternatives analysis in [`docs/research/cli-verb-normalisation.md`](docs/research/cli-verb-normalisation.md). Decision recorded in `docs/decisions-log.md` under "2026-04-27 — Clio CLI verbs: namespaced surface with a three-clause rule".

## [0.11.0] -- 2026-04-27

This release covers everything from the `iteration-5/clio-update-api` branch — items **5.11** (update-doc API + version snapshots), **5.12** (agent-parity API surface), **5.13** (audit log + soft-delete + metadata-only edit), plus a Cerefox-parity audit pass that landed several follow-ups.

### Cerefox-parity, agent-facing search

- **Doc-level search is now the default.** `cfcf clio search` returns one row per matching document (Cerefox parity), with `versionCount` + `matchingChunks` + `isPartial` + the best-scoring chunk's content per hit. `--by-chunk` falls back to the raw chunk-level view for debugging or callers that need the engine's per-chunk ranking explicitly. HTTP: `GET /api/clio/search?by=doc` (default) / `?by=chunk`.
- **Hybrid search switched from RRF to α-weighted score blending** (`α × cosine + (1−α) × normalised_BM25`, default α=0.7). Min-max normalisation of FTS5's BM25 score within the candidate pool makes it comparable to cosine. Per-call `--alpha` / `?alpha=` overrides; global `clio.hybridAlpha`.
- **Small-to-big retrieval is now per-document** (Cerefox parity). Documents whose `total_chars` is at most `clio.smallDocThreshold` (default 20000) return the FULL document content per hit; larger documents return matched chunk + `clio.contextWindow` (default 1) neighbours. New `isPartial: bool` field on `DocumentSearchHit`. Per-call `--small-doc-threshold` / `--context-window` overrides.

### Update-doc API + versioning + soft-delete (5.11)

- **`cfcf clio docs ingest --document-id <uuid>`** — deterministic update by UUID; preserves existing title/author/metadata when the caller omits them.
- **`cfcf clio docs ingest --update-if-exists`** — title-based update; matches by exact title within the same Project, falls through to create on miss.
- **`IngestResult.action`** — `"created" | "updated" | "skipped"`. Legacy `created: boolean` kept for backward compat.
- **Version snapshots** — every update path archives prior chunks into `clio_document_versions`; `version_id IS NULL` on a chunk means "live".
- **`cfcf clio docs versions <doc-id>`** + `GET /api/clio/documents/:id/versions` — list archived versions.
- **`cfcf clio docs get <doc-id> [--version-id <uuid>]`** + `GET /api/clio/documents/:id/content?version_id=<uuid>` — reconstruct full content for live or archived versions.
- **`cfcf clio docs delete <id>` / `cfcf clio docs restore <id>`** + `DELETE` / `POST /api/clio/documents/:id/restore` — soft-delete + restore (idempotent). `cfcf clio docs list [--include-deleted | --deleted-only]` with `[DELETED]` prefix on tombstones.

### Agent-parity API surface (5.12)

- **`author` is a typed first-class column** on `clio_documents`. Surfaced in search hits, listings, and version rows. Default `'agent'`.
- **Search-result `[id: <full-uuid>]` rendering** (CLI + audit + docs list) so agents can copy-paste doc IDs into follow-up `--document-id` updates without manual lookup.
- **`cfcf clio metadata search`** + `POST /api/clio/metadata-search` — exact-match metadata filter (no FTS query required); supports `updated_since` for catch-up workflows.
- **`cfcf clio metadata keys`** + `GET /api/clio/metadata-keys` — discover which metadata keys + sample values exist in the corpus.
- **Pre-flight warnings on embedder switch** — new `GET /api/clio/embedders/:name/switch-impact` returns `embeddedChunkCount` + `chunksOverNewCeiling` + `configMaxOverCeiling`. CLI prompts y/N (refuses in non-TTY without `--yes`) when any signal fires.
- **Confirmation prompt on `cfcf clio reindex`** — shows active embedder + scope + cost hint before running. `--yes` skips for non-interactive use.
- **Embedder-recommended chunk size acts as a SAFETY CEILING.** Smaller user `clio.maxChunkChars` values are honoured; larger values are capped at the active embedder's recommendation with a stderr warning at ingest. Without an embedder, no ceiling.

### Audit log (5.13)

- **`cfcf clio audit`** + `GET /api/clio/audit-log` — query mutation events (`create` / `update-content` / `edit-metadata` / `delete` / `restore` / `migrate-project`) with filters: `event_type`, `actor`, `project`, `document_id`, `since`, `limit`.
- Write-only by design. Reads (search, get, list) intentionally not logged — would dwarf real mutation entries; the trust story is "who changed what". Cerefox precedent.
- Audit writes are best-effort, outside the mutation transaction. A failure warns to stderr without rolling back the underlying operation.

### Metadata-only edit (5.13 follow-up, Cerefox parity)

- **`cfcf clio docs edit <id>`** + `PATCH /api/clio/documents/:id` — mutate `title`, `author`, Clio Project, and metadata WITHOUT re-ingesting content. Closes the last Cerefox-parity gap: previously the only way to change these fields was a full content update, which forced a version snapshot for what isn't a content change.
- **No version snapshot is taken** on metadata edits. Versions exist to protect chunks/content from accidental overwrite; metadata edits don't touch chunks. The audit log carries a before/after diff under one `edit-metadata` row.
- **Set/unset metadata semantics** (`--set-meta key=value`, `--unset-meta key`) — incremental rather than full-blob replace. Avoids the read-modify-write footgun where an agent accidentally drops keys it didn't know about. A future `CerefoxRemote` adapter can reconstruct the full blob from these deltas at the abstraction boundary if upstream demands it.
- **Idempotent**: an edit that makes no actual changes is a no-op (no audit row, no `updated_at` bump). Useful for agents that re-apply the same set/unset on every iteration.
- Move docs between Projects via `--project <name>` (or `projectName` / `projectId` in the JSON body). Closes the gap that previously required either a SQL one-liner or a delete-and-reingest dance.

### Configuration knobs (`ClioGlobalConfig`)

New fields, all editable via the Web UI Server Info page:

- `hybridAlpha` (default 0.7)
- `smallDocThreshold` (default 20000)
- `contextWindow` (default 1)
- `maxChunkChars` (default 4000) — capped at the active embedder's `recommendedChunkMaxChars` when one is active
- `minChunkChars` (default 100)

### CLI ergonomics

- **Stderr spinners** on the slow embedder-bound paths: `cfcf clio docs ingest`, `cfcf clio reindex`, `cfcf clio embedder set --reindex`. TTY-only; suppressed under `--json`.
- **`docs list` shows `versions=N`** when N > 0, plus `[DELETED]` prefix + restore hint for tombstones. `--deleted-only` for the trash-bin view.
- **Project names surfaced consistently** in `cfcf clio search` (was missing entirely), `docs list`, `metadata-search`, `get`, and `ingest` result rendering. Display format: `<name> [<id>]` so the human-friendly name is primary and the UUID stays available for scripts that want to copy it. Powered by a new optional `ClioDocument.projectName` field populated via SQL JOIN on read paths.
- **Version banner unified.** `cfcf --version`, `cfcf server start`, `cfcf server status`, and `GET /api/health` all report the same string, resolved at runtime from the installed package's `package.json` (or workspace's `package.json` with `-dev` suffix in source mode).

### Schema + tooling

- **Migration runner** gained an explicit `-- @migration-flags: disable-foreign-keys` marker for the rare cases where a migration drops + rebuilds a parent table with `ON DELETE CASCADE` children. The pragma is bracketed outside the wrapping transaction (the only place it takes effect).
- **Migrations consolidated** to a single `0001_initial.sql` representing the v0.11.0 schema. Pre-public housekeeping; future migrations are forward-only.
- **`cfcf server stop` waits** for the server's HTTP port to actually free + the OS process to exit before returning, so a follow-up `cfcf server start` doesn't race for the port.

### Out of scope (tracked for iter-6)

- **6.22**: on-demand version retention cleanup (`cfcf clio cleanup-versions`).
- **6.23**: re-chunk on embedder switch (`cfcf clio reindex --rechunk`).

## [0.10.0] -- 2026-04-26

This release ships the **installer + distribution rewrite (item 5.5)**, a UX polish for re-running `cfcf init --force` (item 6.21), and the post-pivot dogfood fixes that surfaced when the new install was exercised on Intel Mac. Plan item 6.17 (Clio update-doc API) was newly flagged and prioritised but not implemented in this release.

### Pivot: distribution model (item 5.5)

cfcf now distributes as a standard npm-format CLI package (`@cerefox/cfcf-cli`) rather than a `bun --compile` self-contained binary. Bun ≥ 1.3 becomes a runtime requirement; the curl-bash installer (`scripts/install.sh`) bootstraps it automatically when missing. Per-platform native libs (pinned libsqlite3 + sqlite-vec) ship as separate `@cerefox/cfcf-native-<platform>` optional npm packages with `os` + `cpu` fields, the same pattern Claude Code, sharp, swc, and esbuild use. Phase-0 dogfood verified end-to-end on Intel Mac (darwin-x64); `cfcf doctor` reports all 11 health checks passing including `sqlite_version = 3.53.0` (proof the pinned custom libsqlite3 loaded). Full post-mortem of why we abandoned `--compile`: see [`docs/decisions-log.md`](docs/decisions-log.md) 2026-04-26 entries.

### Added
- **`cfcf doctor`** — self-check command rewritten for the npm-format shape. 11 checks: Bun runtime, cfcf package metadata, per-platform native package presence + libsqlite3 + sqlite-vec, custom-libsqlite-loadable proof (opens an in-memory DB and asserts `sqlite_version()` matches the pin), three runtime deps (`@huggingface/transformers`, `onnxruntime-node`, `sharp`), two agent CLIs (`claude-code`, `codex`), Clio DB. `--json` flag emits structured results for scripted use.
- **`cfcf self-update`** — `bun install -g <new-tarball>` wrapper. `--check` polls remote MANIFEST.txt without installing; `--yes` is non-interactive; `--version vX.Y.Z` pins a specific tag; `--base-url` overrides the install URL. Atomic from the user's perspective; if the install fails the previous version stays intact.
- **`scripts/build-cli.sh`** — bundles `packages/cli/src/index.ts` via `bun build` (no `--compile`), externalises the heavy native deps, stages a publish-shaped `@cerefox/cfcf-cli` package, runs `bun pm pack` → `dist/cfcf-X.Y.Z.tgz`.
- **`scripts/build-native-package.sh`** — per-platform tarball builder. Compiles libsqlite3 from the pinned amalgamation (3.53.0, `SQLITE_ENABLE_LOAD_EXTENSION=1`), fetches sqlite-vec 0.1.9, packs `@cerefox/cfcf-native-<platform>-X.Y.Z.tgz` with matching `os`/`cpu` fields.
- **`scripts/stage-dist.sh`** — convenience wrapper that wipes `dist/`, builds CLI + host-platform native tarballs, copies `install.sh`, writes `MANIFEST.txt`, and prints the one-liner to dogfood-install via `file://`.
- **`docs/guides/installing.md`** — rewritten end-to-end for the npm-format shape. Covers curl-bash + direct `bun install -g` + file:// + upgrade + uninstall + troubleshooting.
- **Plan item 6.17 (re-scoped + prioritised)**: Clio update-doc API + version snapshots + soft-delete. Surfaced during dogfood when ingesting `decisions-log.md` — `LocalClio.ingest()` dedups by content_hash but has no update verb, so re-ingesting modified content creates a brand-new UUID and orphans the old document. Breaks the `MemoryBackend` parity commitment to Cerefox. Implementation pending; tracked for iteration 5 wrap-up.

### Changed
- **Build pipeline**: replaced the per-platform `bun --compile` matrix with a single `bun build` (no `--compile`) that bundles into `dist/cfcf.js` shipped inside an npm tarball. The bundled JS is platform-independent; native deps live in per-platform packages. Net result: 250 KB CLI tarball + ~1 MB native tarball per platform vs the old 22 MB darwin / 38 MB linux self-contained binaries.
- **`release.yml`** — `workflow_dispatch` only (no auto-trigger on tag push). Per-platform `build-native` matrix + single `build-cli` job + `release` step that uploads cli tarball + 3 native tarballs + SHA256SUMS + MANIFEST.txt + install.sh as GitHub Release assets.
- **`ci.yml`** — drops the per-platform `--compile` build matrix; runs a single `scripts/build-cli.sh` smoke per PR. Linux runner only (CLI tarball is platform-independent). Each push uploads ~250 KB instead of ~140 MB.
- **`install.sh`** slimmed from ~200 lines to ~100. Bootstraps Bun via `https://bun.sh/install` if missing, detects host platform, fetches the matching `@cerefox/cfcf-native-<platform>` tarball + cli tarball, runs `bun install -g` against both, hands off to `cfcf init`. The earlier MANIFEST verification + Gatekeeper xattr + `~/.cfcf/bin/` symlink steps are gone — Bun's package manager handles all of that.
- **`uninstall.sh`** is now a one-liner around `bun remove -g @cerefox/cfcf-cli`. Preserves user data (`~/.cfcf/clio.db`, `~/.cfcf/logs/`, `~/.cfcf/models/`) by default.
- **`cfcf init --force`** (item 6.21) now reads the existing config and offers the user's current values as prompt defaults — agent picks, models, embedder, max iterations, notification settings — rather than the hardcoded `createDefaultConfig` bootstrap defaults. Each role's adapter is healed against the current `available` list (a previously-installed agent that's since been removed falls back to the bootstrap default). `cfcf config edit` works for free since it delegates to `init --force`.
- **`packages/core/src/clio/db.ts`** — `applyCustomSqlite()` and `getSqliteVecPath()` now resolve `@cerefox/cfcf-native-<platform>` via `createRequire(import.meta.url).resolve('@cerefox/cfcf-native-<platform>/package.json')` instead of looking under `~/.cfcf/native/`. Dev mode falls back to system SQLite (FTS5 still works; sqlite-vec features unavailable).
- **`cfcf --version`** now resolves the installed package's version via `require.resolve('@cerefox/cfcf-cli/package.json')` so it reflects the actually-installed version, not the in-repo VERSION constant.
- **Docs sweep** across 8 files (`README.md`, `CLAUDE.md`, `docs/design/cfcf-stack.md`, `docs/design/clio-memory-layer.md`, `docs/plan.md`, `docs/research/clio-implementation-decisions.md`, `docs/research/clio-test-plan.md`) to remove stale `cfcf-binary` / `bun --compile` / `~/.cfcf/native/` references. Sections that intentionally describe the old shape (decisions-log post-mortems, CHANGELOG entries for past releases) are preserved as historical record.

### Fixed (post-pivot dogfood)
- **`cfcf server start` failed silently under the npm-format install.** The spawn-self mechanism inherited from the `--compile` shape used `process.execPath`, which under npm-format resolves to the bun runtime itself, not the cfcf entry — re-spawning bare `bun` with no script argument launched a Bun REPL, which never started the server. The readiness poll timed out with a misleading "Try running directly: bun run dev:server" message (which itself is dev-mode advice that doesn't apply to installed users). Fix: derive the bundled JS path from `import.meta.url` and spawn `bun run <bundle>` with `CFCF_INTERNAL_SERVE=1`.
- **Embedder install progress bar glitched on re-runs.** Three pre-existing bugs in `OnnxEmbedder.progress_callback` surfaced together: (a) lines clobbered each other because `finalizeLine()` only fired when `activeFile === file`; (b) cached files showed `(? MB)` because the renderer fell through when no prior progress events fired; (c) bogus `[streaming...] 0.0 MB` for tiny files because the indeterminate-mode heuristic latched on `total === loaded` from the first event. All three fixed in [`packages/core/src/clio/embedders/onnx-embedder.ts`](packages/core/src/clio/embedders/onnx-embedder.ts).
- **`cfcf init --force` re-ran the warmup-with-progress-bar dance even when the embedder was fully cached + active.** New `isEmbedderCached(entry)` helper checks for the dtype-aware ONNX weights file under `~/.cfcf/models/<hf-id>/`; init short-circuits with `✓ Clio ready (already cached and active; …)` when both DB row and cache match. First-time installs and embedder switches still hit the full download + progress path.
- **GitHub Actions artifact storage quota hit.** Old `--compile` binary builds (~22 MB darwin + ~38 MB linux per push) accumulated on a 90-day default retention; the earlier `retention-days: 7` change only applies to NEW artifacts, not retroactively. ~104 stale artifacts ≈ 3 GB, 6× the free-tier 500 MB quota. Bulk-deleted via `gh api -X DELETE`. The new ci.yml produces ~250 KB tarballs per push so this won't recur.

### Removed
- Build scripts that no longer apply: `scripts/build-release-tarball.sh`, `scripts/stage-runtime-deps.sh`, `scripts/resolve-runtime-deps.js`, `scripts/write-manifest.sh`.
- `cfcf-binary` artefact and the `--compile` invocation in `package.json`'s build script.
- The `~/.cfcf/bin/` + `~/.cfcf/native/` + `~/.cfcf/MANIFEST` install layout. Those paths no longer exist after a v0.10.0 install. User data (`~/.cfcf/clio.db`, `~/.cfcf/logs/`, `~/.cfcf/models/`) is unchanged.
- macOS Gatekeeper / `com.apple.quarantine` xattr workaround in `install.sh`. Bun handles its own binary; cfcf is plain JS.

## [0.9.0] -- 2026-04-25

This release ships **Clio**, cf²'s persistent cross-workspace memory layer (item 5.7), plus a long tail of post-review refinements driven by dogfooding on Intel Mac. The full Clio surface lands in one branch: SQLite + FTS5 + ONNX-embedder hybrid search, iteration-loop auto-ingest, full CLI + HTTP + web-UI exposure, and a `MemoryBackend` interface designed to swap in a future remote Cerefox adapter. Default mode is `auto` (hybrid when an embedder is active, else FTS), with a Cerefox-style 0.5 cosine threshold on the vector branch.

Headline behaviour:
- `cfcf init` walks you through agent picks (numbered list, validated) + downloads the default embedder (nomic-embed-text-v1.5, q8, 768d, ~130 MB) inline with a stderr progress bar; when init exits, hybrid search is ready.
- `cfcf clio {search, ingest, get, docs list, projects, project, embedder, reindex, stats}` is the full CLI surface. `cfcf memory` is a top-level alias.
- HTTP API under `/api/clio/*` mirrors the CLI; the web UI's Server Info page exposes the new global Clio settings (default search mode, min search score, preferred embedder readout).
- Iteration loop auto-ingests reflection / architect / decision-log / iteration-summary artifacts (gated by `workspace.clio.ingestPolicy`); each agent role gets a `cfcf-docs/clio-relevant.md` preload and a `cfcf-docs/clio-guide.md` cue card.
- Platform support: darwin-arm64, darwin-x64, linux-x64 — all native ORT, same code path. Intel Mac kept first-class via the `transformers@3.8.1` + `onnxruntime-node@1.21.0` pin (Microsoft dropped Intel-Mac binaries in ORT-node 1.24+; we pinned to the last compatible pair). Exit criteria for revisiting documented in `docs/decisions-log.md`.

Items 6.15-6.18 hold the deferred v2 follow-ups (sqlite-vec HNSW, audit log, soft-delete + versioning, full web Clio tab). The 5.5 installer is up next; it ships colocated `node_modules/` + a pinned SQLite with `loadExtension` enabled so end-user installs don't need any of the dev-mode workarounds described in `docs/decisions-log.md` item 7.

Detailed entries below.

### Added
- **Clio (item 5.7) — `@huggingface/transformers` pinned to 3.8.1 for Intel Mac support (2026-04-25).** `onnxruntime-node@1.24.x` (which transformers 4.x pins) ships no darwin-x64 binary — Microsoft dropped Intel-Mac builds. Investigated three alternatives (drop Intel Mac, FTS-only fallback, WASM-via-onnxruntime-web) before settling on the simplest: pin `@huggingface/transformers@3.8.1` + `onnxruntime-node@1.21.0`, the last pair where darwin-x64 ships natively. Verified end-to-end on this Intel Mac via the actual `LocalClio.installActiveEmbedder({ loadNow: true })` path: HF download with progress bar, 127 MB `bge-small-en-v1.5` cached at `~/.cfcf/models/`, embedding 2 strings in 21 ms (full native speed, no WASM fallback). All platforms — including Intel Mac — now use the same code path with the same performance. Trade-off: a few minor versions behind latest transformers; cfcf only uses the long-stable `pipeline("feature-extraction", ...)` API so no functional impact today. Decision + investigation captured in [`docs/research/installer-design.md`](docs/research/installer-design.md) §14a (decision) and §14b (deferred Option D / WASM, with what we learned). The WASM-via-transformers path was probed and would require either vendoring transformers.js or rolling our own embedder — deferred unless Microsoft permanently stays off darwin-x64 AND staying behind on transformers becomes a real cost.
- **Clio (item 5.7) — `loadNow` actually downloads now (2026-04-25 fix).** The 2026-04-22 "pick-equals-install" change wrote the active-embedder DB row + claimed "Clio ready" but never actually triggered the HF download. Root cause: `installActiveEmbedder({ loadNow: true })` called `getEmbedder()` which only constructed the OnnxEmbedder shell; the download lives in `OnnxEmbedder.ensurePipeline()` and was lazy until the first `embed()` call. Verification only checked the DB row, not the model on disk -- so the failure was silent. Fix: added `Embedder.warmup()` (optional method); OnnxEmbedder implements it as `await this.ensurePipeline()`; `installActiveEmbedder({ loadNow: true })` now calls `warmup()` after constructing. After this fix `cfcf init` (which has always passed `loadNow: true`) genuinely downloads the model + materialises the inference pipeline before returning, so when "✓ Clio ready: ..." prints the model is on disk in `~/.cfcf/models/`, active in the DB, and warm. Same fix flows through `cfcf clio embedder install <name>`, which uses the same `loadNow: true` code path. The future installer (5.5) `--with-embedder` flag becomes the non-interactive provisioning equivalent.
- **Clio (item 5.7) — post-review refinements (2026-04-22/23).**
  - **Default embedder switched to `nomic-embed-text-v1.5` (2026-04-22).** bge-small's ~512 token context splits long design docs / iteration-handoffs into many small chunks; nomic's 8k token context comfortably fits the Cerefox chunker's ~4k-token effective chunk window so the same docs embed as one coherent passage. `DEFAULT_EMBEDDER_NAME` in the catalogue is the single source of truth — `cfcf init`'s `★` marker, the `cfcf clio embedder install` no-arg fallback, `cfcf clio stats`'s "none" hint, and the FTS-only next-steps line all read from it. Design doc, test plan, and catalogue descriptions updated.
  - **`cfcf init` pick-equals-install (2026-04-22 follow-up to the 2026-04-23 prompt).** The initial landing made the picker a preference-only record; users then had to re-type the embedder name in a separate `cfcf clio embedder install <name>` step — unnecessary friction. The flow now opens a `LocalClio` inline, runs `installActiveEmbedder` on the chosen entry (download + activate), and surfaces either a "Clio ready" confirmation or a retryable error in "Next steps". The preference is still saved to `clio.preferredEmbedder` first, so a network failure during the download doesn't lose the user's pick. Install runs against the local `~/.cfcf/clio.db` directly (no server dependency), so `cfcf init` keeps working offline-to-local even though the HF download needs network. Pairs with `cfcf clio embedder install [name]` — the arg is now optional and defaults to `clio.preferredEmbedder`, letting `cfcf clio embedder install` with no arg act as "retry what I picked during init" (falls back to the catalogue default if no preference recorded).
  - **Download progress bar (item 6.19 partial).** `OnnxEmbedder.ensurePipeline` now passes a `progress_callback` to `transformers.pipeline()` that renders a one-line-per-file stderr progress bar (`[████░░░░░░] 45%  54.0/120.0 MB  model.onnx`) throttled to ≥5% ticks so multi-file downloads don't flood the terminal. Removes the previous "silent stare for 60 seconds" behaviour on first install.
  - **Pre-download bandwidth hint + post-install auto-verification (item 6.19 remainder, 2026-04-22).** The loading line now carries a size + ETA anchored at two realistic link speeds (`~140 MB; est. 22s-2m at 50-10 Mbps`) so users can decide whether to wait before the download starts. After `installActiveEmbedder` returns, init reads the `clio_active_embedder` row back and fails hard if the row doesn't match the chosen entry (catches the theoretical case where the install call returns OK but the DB state is wrong); on success prints `✓ Clio ready: <name> (dim=N, chunk=N chars)`. Installer pre-warm (the one remaining 6.19 item) blocks on item 5.5 and is tracked there; 6.19 stays 🔄 until 5.5 lands.
  - **`cfcf init` now prompts for embedder install (2026-04-23 baseline).** The flow lists the catalogue (default marked), accepts a numeric pick or `S` to skip.
  - **`cfcf workspace set --migrate-history` is now workspace-scoped by default.** Before this, `--migrate-history` ran `UPDATE clio_documents SET project_id = <new> WHERE project_id = <old>` which over-migrated when sibling workspaces shared the old Clio Project. Fix: the default path filters by `json_extract(metadata, '$.workspace_id') = <this-workspace-id>` so only this workspace's own history moves. New `--all-in-project` flag opts back into the wide sweep for the "I'm collapsing a Project into another and I know it" case. `MemoryBackend.migrateDocumentsBetweenProjects(from, to, opts)` signature grew `opts.workspaceId` + `opts.allInProject` (one is required; the method throws when neither is set).
  - **`cfcf clio reindex [--project <name>] [--force] [--batch-size <n>]`**: re-embeds chunks under the currently-active embedder. Idempotent: chunks whose `embedder` + `embedding_dim` already match are skipped unless `--force`. Batches embedder calls (default 32); per-batch transactions so partial failures don't poison the corpus. `POST /api/clio/reindex` on the HTTP side. Throws when no embedder is active with a clear next-step message.
  - **`cfcf clio embedder set <name> --reindex`**: the canonical, safe embedder-switch flow. Atomically flips the active-embedder record + re-embeds every existing chunk under the new model. Replaces the old "only `--force` available" approach. `--force` is still there for recovery scenarios but prints a warning about degraded vector search.
  - **Plan updates** in `docs/plan.md`: item 5.7 marked ✅; v2 follow-ups broken out as 6.15 (sqlite-vec HNSW), 6.16 (audit log wiring — reuse Cerefox logic), 6.17 (soft-delete + versioning — reuse Cerefox), 6.18 (web UI Clio tab), 6.19 (`cfcf init` Clio onboarding polish). Installer (5.5) description updated to note it should also ship a pinned SQLite + sqlite-vec per-platform so 6.15 has a clean loadExtension path on macOS.
  - Tests: +4 new (2 LocalClio migrate workspace-scope + 1 HTTP all-in-project + 7 reindex scenarios spanning no-embedder / idempotent / backfill / model-switch / force / project-filter / unknown-project). 90 Clio tests total, 22 Clio HTTP tests, 345 core tests pass overall.

- **Clio (item 5.7) -- complete.** Full memory layer with hybrid search + iteration-loop integration. Ships with staged behavior: FTS keyword search works out of the box; hybrid/semantic vector search activates once an embedder is installed via `cfcf clio embedder install <name>`.

- **Clio (item 5.7) -- PR2: embeddings + hybrid search.** Vector search on top of PR1's FTS foundation, behind an embedder-install opt-in so the cf² binary stays lean.
  - **Embedder catalogue** (`packages/core/src/clio/embedders/catalogue.ts`): `bge-small-en-v1.5` (default, 384 dims, ~120 MB), `all-MiniLM-L6-v2` (~23 MB), `nomic-embed-text-v1.5` (long-context 8k token window, ~140 MB), `bge-base-en-v1.5` (~430 MB). Each entry locks its `recommendedChunkMaxChars` and `recommendedExpansionRadius` -- chunk size is owned by the embedder, not user config, so getting it wrong can't silently break search.
  - **ONNX embedder** via `@huggingface/transformers` (new runtime dep). Lazy model download on first `embed()` call, cached to `~/.cfcf/models/`. Stderr progress line. Embedding failures downgrade gracefully to FTS-only per-document so a transient network error doesn't break ingest.
  - **Active-embedder tracking** (`clio_active_embedder` table, migration 0002). Single-row record of the pinned model. `cfcf clio embedder install/set` validates dim-compat: refuses to switch when the old embedder has live embeddings unless `--force` (v2 reindex is the supported path).
  - **Hybrid RRF search**: parallel FTS + vector candidates fused via `score = Σ 1 / (60 + rank)`. Brute-force cosine over the candidate set (<100k chunks per design doc §4.1 assumption; sqlite-vec HNSW is a v2 optimization).
  - **Small-to-big expansion**: each hit's `content` is expanded inline with its ±N sibling chunks so passages read naturally. Radius picked from the embedder manifest (2 for 384-dim models, 1 for larger-context ones).
  - **Ingest**: `LocalClio.ingest` now chunks using the active embedder's `recommendedChunkMaxChars`, computes + stores embeddings per chunk. Chunker falls back to Cerefox's 4000-char default when no embedder is active.
  - **HTTP**: `GET /api/clio/embedders`, `POST /api/clio/embedders/install`, `POST /api/clio/embedders/set`.
  - **CLI**: `cfcf clio embedder list | active | install <name> | set <name>` (+ `--force`).
  - **Build tweak**: `bun build --compile` now marks `@huggingface/transformers`, `onnxruntime-node`, `sharp` as external (their native bindings aren't bundle-friendly). Binary stays lean; Node deps are installed via `package.json` on the target machine.
  - Tests: +16 new (store: 6; hybrid/semantic with a deterministic MockEmbedder: 9; catalogue sanity: 1). Real ONNX integration is validated via manual user testing.

- **Clio (item 5.7) -- PR3: iteration-loop integration.** Auto-ingest hooks + context preload + agent cue card.
  - `cfcf-docs/clio-guide.md`: new agent cue-card template, written fresh every iteration, pointing agents at the Clio CLI commands they can run during a loop run. Linked from the generated `CLAUDE.md`/`AGENTS.md` Tier-2 reads.
  - `cfcf-docs/clio-relevant.md`: per-iteration top-k Clio hits matched against the workspace's `problem.md`. Generated by the loop's prepare phase. Broad cross-Project search + narrow same-Project search filtered by `artifact_type ∈ {reflection-analysis, architect-review}`.
  - Auto-ingest hooks in `iteration-loop.ts` (all respect `workspace.clio.ingestPolicy`):
    - After pre-loop architect commits → `ingestArchitectReview` (trigger=loop).
    - After reflection commits → `ingestReflectionAnalysis`.
    - After end of iteration (before DECIDE) → `ingestRawIterationArtifacts` (policy=all only), `ingestDecisionLogEntries` (summaries-only=semantic categories only), `ingestIterationSummary` (cf²-generated short summary of dev + judge + reflection).
  - `cfcf review` (manual) → `ingestArchitectReview` (trigger=manual) after history event updates.
  - All ingest calls are try/catch-wrapped: Clio failures log a warning but never break an iteration. The loop is the product; Clio is an adjunct.
  - Tests: +21 new for loop-ingest (policy resolution, decision-log parser, every hook, clio-relevant generation).

- **Clio (item 5.7) -- PR1: foundation.** (already in [Unreleased] earlier; kept for coherence.) New memory layer for cross-workspace knowledge. Ships FTS5-only keyword search against a local SQLite DB at `~/.cfcf/clio.db` (override via `CFCF_CLIO_DB`). Schema + migrations infrastructure + markdown chunker + HTTP + CLI surfaces. **No embedder yet; hybrid/semantic search arrives in PR2 with sqlite-vec + bge-small-en-v1.5.** No iteration-loop integration yet; that's PR3.
  - **Schema** (`packages/core/src/clio/migrations/0001_initial.sql`): `clio_projects` (Cerefox-compatible domain grouping), `clio_documents` (content-hash-dedup'd), `clio_chunks` (partial-unique on current chunks; embedding columns declared but unpopulated), `clio_chunks_fts` (FTS5 virtual table with triggers excluding archived chunks), `clio_document_versions` + `clio_audit_log` (shapes land now so v2 doesn't need a migration), JSON-extract indexes on `metadata.workspace_id` / `role` / `artifact_type` / `tier` for cheap filter queries.
  - **Migrations runner** (`packages/core/src/clio/db.ts`): `bun:sqlite` + WAL + FKs on + busy_timeout 5s. Each migration applies in a transaction so broken migrations roll back cleanly. Migrations are embedded via `import ... with { type: "text" }` so the compiled binary carries them.
  - **Markdown chunker** (`packages/core/src/clio/chunking/markdown.ts`): 1:1 TS port of `cerefox/src/cerefox/chunking/markdown.py @2026-04` so the same input produces the same chunk boundaries as Cerefox. Heading-aware greedy accumulation across H1-H3; oversized sections paragraph-split; H4+ inlined.
  - **`MemoryBackend` + `LocalClio`** (`packages/core/src/clio/backend/`): swap-point interface plus the default SQLite-backed impl. FTS5 MATCH via a sanitized operator-free user query, optional project + metadata filters via `json_extract`, BM25 ordering with score flipped to "higher = better" for downstream.
  - **HTTP** (`packages/server/src/routes/clio.ts`): `GET /api/clio/projects`, `POST /api/clio/projects`, `GET /api/clio/projects/:idOrName`, `POST /api/clio/ingest`, `GET /api/clio/search`, `GET /api/clio/documents/:id`, `GET /api/clio/stats`, `PUT /api/workspaces/:id/clio-project`. Tests: 21 pass.
  - **CLI** (`packages/cli/src/commands/clio.ts`): `cfcf clio search | ingest | get | projects | project create | project show | stats`. `cfcf memory` top-level alias. Every verb supports `--json` for raw output.
  - **Workspace init** (`cfcf workspace init`): new `--project <clio-project>` flag. Interactive prompt on TTY when flag is omitted (lists existing Clio Projects, offers "new", offers "skip"). `--no-prompt` suppresses. Workspace config gains `clioProject?` + `clio?: { ingestPolicy? }` + `CfcfGlobalConfig.clio?: { ingestPolicy? }` (default `summaries-only`).
  - **`cfcf workspace set <name> --project <new>`**: rewires a workspace's Clio Project assignment. Default affects only future ingests; `--migrate-history` re-keys existing Clio documents via a single SQL UPDATE.
  - **On first start-up:** `~/.cfcf/clio.db` is created + migrations applied lazily on the first Clio HTTP or CLI call. Graceful shutdown flushes + closes the DB handle.
  - **Not yet in PR1:** no embedder / no vector search (`mode=hybrid` / `semantic` are accepted but fall back to FTS); no iteration-loop auto-ingest; no `cfcf-docs/clio-relevant.md` preload; no `cfcf-docs/clio-guide.md` agent cue card. Those land in PR2 + PR3.

## [0.8.0] -- 2026-04-22

**Breaking change**: cf²'s `project` noun is renamed to `workspace` everywhere. This is plan item 5.10 -- a prerequisite for Clio (item 5.7, the upcoming memory layer), which reserves the `Project` concept for Cerefox-aligned domain groupings of knowledge. Resolution: cf²'s "one managed git repo" entity becomes a **workspace**, and Clio's `Project` stays free to mean what Cerefox expects.

This is a clean break -- no CLI or API aliases. If you have scripts that invoke `cfcf project ...` or call `/api/projects/*`, update them before upgrading.

### Changed -- user-facing rename
- **CLI**: `cfcf project *` → `cfcf workspace *` (init/list/show/delete). `--project <name>` flag on `run`, `resume`, `stop`, `review`, `document`, `reflect`, `status` → `--workspace <name>`.
- **REST API**: `/api/projects/*` → `/api/workspaces/*` (every sub-route). Response bodies now use `workspaceId` / `workspaceName` instead of `projectId` / `projectName`.
- **Web UI**: "Projects" nav → "Workspaces"; project detail page → workspace detail page; `#/projects/:id` hash route → `#/workspaces/:id`; all labels + empty states + hints.
- **Notifications**: `NotificationEvent.project.{id,name}` → `NotificationEvent.workspace.{id,name}` (only relevant to custom webhook channels).
- **On-disk config directory**: `<cfcf config dir>/projects/` → `<cfcf config dir>/workspaces/`. The config dir is platform-specific (`~/Library/Application Support/cfcf/` on macOS; `~/.config/cfcf/` or `$XDG_CONFIG_HOME/cfcf/` on Linux; `%APPDATA%/cfcf/` on Windows). The old `projects/` subdirectory is **not migrated** -- new workspaces are written to `workspaces/`. Delete the old `projects/` directory manually once you've verified the rename works for you.
- **Types** (`@cfcf/core` + `@cfcf/web`): `ProjectConfig` → `WorkspaceConfig`, `ProjectStatus` → `WorkspaceStatus`, `getProject`/`listProjects`/`createProject`/`findProjectByName`/`updateProject`/`deleteProject`/`validateProjectRepo` → `getWorkspace`/`listWorkspaces`/`createWorkspace`/…, `dispatchForProject` → `dispatchForWorkspace`, `getProjectLogDir`/`ensureProjectLogDir` → `getWorkspaceLogDir`/`ensureWorkspaceLogDir`, `getProjectDir`/`getProjectsDir` → `getWorkspaceDir`/`getWorkspacesDir`.
- **Templates**: `{{PROJECT_NAME}}` placeholder in agent instruction templates → `{{WORKSPACE_NAME}}`.
- **Modules**: `packages/core/src/projects.ts` → `workspaces.ts`; `project-history.ts` → `workspace-history.ts`; `packages/cli/src/commands/project.ts` → `workspace.ts`; `packages/web/src/pages/ProjectDetail.tsx` → `WorkspaceDetail.tsx`; `ProjectCard.tsx` → `WorkspaceCard.tsx`; `ProjectHistory.tsx` → `WorkspaceHistory.tsx`.

### Not renamed (deliberate)
- The word "project" when it refers to the **user's codebase / problem domain** in prose, templates, or user-authored content. Only cf²'s own infrastructure noun changes.
- Cerefox's `Project` vocabulary (Clio design docs, SQL table names like `clio_projects`) -- that's the upstream concept cf² is rhyming with, not overloading.
- Iteration branch names (`cfcf/iteration-N`) and per-iteration archive directories under `cfcf-docs/` -- no `project` in the path.

See [`docs/research/workspace-rename-plan.md`](docs/research/workspace-rename-plan.md) for the full rationale + rename surface enumeration, and [`docs/design/clio-memory-layer.md`](docs/design/clio-memory-layer.md) §2 for the Cerefox alignment that motivated the rename.

## [0.7.6] -- 2026-04-20

Two related brownfield-context bugs fixed, plus a small architecture improvement to the dev handoff lifecycle so the pre-loop architect and the next iteration's dev agent actually see the previous iteration's outputs.

### Fixed
- **`judge-assessment.md` clobbered on pre-loop review.** When `autoReviewSpecs=true` ran on a project with prior iterations, the pre-loop review's `writeContextToRepo` call silently overwrote the existing iteration-N judge verdict with the default "No previous judge assessment. This is the first iteration." placeholder, so the architect (and any subsequent agent in that loop) saw a fresh-project view of a brownfield repo. Fix: `runReviewSync` now reads the existing `judge-assessment.md` and passes it through as `previousJudgeAssessment` before calling `writeContextToRepo` (same pattern as the v0.7.2 `userFeedback` fix).
- **`iteration-handoff.md` reset before the next dev agent could read it.** The file was unconditionally rewritten to the blank template at the start of every iteration, so the forward-looking handoff iter-N left behind was never visible to iter-(N+1)'s dev agent. Fix: switched from `writeTemplate` (always reset) to `writeTemplateIfMissing` (only populate when absent). The previous iteration's handoff is preserved as context; the dev agent is told to **replace** it with their own handoff by end of iteration.

### Added
- **`cfcf-docs/iteration-handoffs/iteration-N.md`** -- per-iteration archive of the dev's forward-looking handoff. cfcf copies the live `iteration-handoff.md` here at end of each iteration (right after the dev commit), mirroring how `iteration-reviews/` archives judge assessments and `reflection-reviews/` archives reflection analyses. Gives the full audit trail of forward-looking notes without git archaeology.
- **Architect re-review template** (`cfcf-architect-instructions.md`) gains `iteration-handoffs/iteration-*.md` + `judge-assessment.md` in the "Read everything first" list for re-review mode -- so on a brownfield re-review the architect sees the previous iteration's forward-looking notes and the last judge verdict, not just the logs.
- **Dev agent's generated CLAUDE.md / AGENTS.md instructions** now include `iteration-handoffs/` in the Tier-2 read list and explain the handoff-replace semantics explicitly: "starts with the previous iteration's handoff as context; replace with your own before exiting."
- **`archiveHandoff(repoPath, iteration)`** helper in `context-assembler.ts` + +5 tests covering the new lifecycle (handoff preserved across `writeContextToRepo`, `previousJudgeAssessment` pass-through, archive happy path, missing-file fallback, auto-mkdir).

### Removed
- **Dead `previousHandoff` field on `IterationContext`.** Declared since the iteration-2 days but never set or read anywhere -- cleanup while we're in the area.

## [0.7.5] -- 2026-04-20

Small cleanup pass: remove the unused `repoUrl` project field everywhere, and fix a user-facing string on the global-settings page that leaked internal plan-item references + claimed out-of-date UI state.

### Removed
- **`ProjectConfig.repoUrl`.** Optional field that was stored on project configs and rendered in `cfcf project show` / the old Remote URL input on the Config tab, but never actually consumed anywhere in the codebase -- `cfcf` has no push/pull logic yet, and when that lands (item 6.3 `cfcf push`) it will use the repo's own `git remote -v` (`origin`) rather than this field. Removed from: `ProjectConfig` type (core + web), `createProject` signature, `POST /api/projects` body, `cfcf project init --repo-url` CLI option, `cfcf project show` output, the Config tab's "Remote" section, `docs/design/technical-design.md`, `docs/api/server-api.md`, `docs/guides/cli-usage.md`. Existing project configs that happen to have the field set in JSON are harmless -- cfcf ignores unknown top-level fields.

### Changed
- **Global settings banner rewritten to be user-facing.** Was: "This page edits the global defaults. Per-project overrides live in each project's Config tab, which is read-only today and becomes editable in plan item 6.14." Now: "This page edits the **global defaults**. To override any of these for a specific project, open that project and edit its **Config** tab — per-project settings take precedence over the global defaults." The old text leaked an internal plan-item reference and incorrectly claimed the project Config tab was read-only (it became editable in v0.7.4).
- **Page title renamed** from "Server & settings" to "Server Info and Global Settings" -- more accurate since the top section is read-only runtime info and the bottom is the editable global config.

## [0.7.4] -- 2026-04-20

Ships plan item **6.14** (pulled forward from iteration 6 since 5.9 set the editor pattern and the two pages share structure): the read-only `Config` tab on the project detail page becomes a full editable form, wire-compatible with the CLI-hit `PUT /api/projects/:id`.

### Added
- **Editable per-project config tab in the web UI.** Identity + runtime fields (id, name, repo path, status, iterations completed, process template) render read-only at the top; below that, five editable sections: Remote URL / Agent roles (5) / Iteration defaults (maxIterations, pauseEvery, reflectSafeguardAfter, onStalled, mergeStrategy) / Behaviour flags (autoReviewSpecs / autoDocumenter / readinessGate / cleanupMergedBranches) / Notifications override with an explicit "inherit global" toggle. Save / Cancel buttons track a dirty flag; success message appears briefly after save; errors surface inline.
- **`saveProject()`** helper in `packages/web/src/api.ts`.
- **Validation + identity-preservation on `PUT /api/projects/:id`.** The endpoint now validates bounded numeric fields (`maxIterations >= 1`, `pauseEvery >= 0`, `reflectSafeguardAfter >= 1`), enums (`onStalled`, `mergeStrategy`, `readinessGate`), and agent role objects (`adapter` required when setting an agent role). Identity + runtime fields (`id`, `name`, `repoPath`, `currentIteration`, `status`, `processTemplate`) are stripped from any incoming patch regardless of client input. Sending `notifications: null` clears the per-project override (project re-inherits the global notification settings). +12 tests in `app.test.ts` covering happy path, identity preservation, every rejection, and the null-notifications clear.
- **Banner at the top of the Config tab:** "These override the global defaults for this project only. Global settings live in the top-bar Settings link."

### Changed
- Docs refreshed: `docs/api/server-api.md` expands the `PUT /api/projects/:id` section with the full body shape, response, and error matrix. `docs/plan.md` item 6.14 flipped ❌ → ✅.

## [0.7.3] -- 2026-04-20

Ships plan item **5.9**: the read-only `#/server` page becomes a full editable global-settings form in the web UI, wire-compatible with `cfcf config edit` on the CLI.

### Added
- **`PUT /api/config` endpoint.** Accepts a full `CfcfGlobalConfig` body or a partial patch; merges onto the current config, preserves server-owned fields (`version`, `permissionsAcknowledged`, `availableAgents`), validates through the same `validateConfig` used by `readConfig`, and writes the result. Returns the saved config. Explicit 400 on `maxIterations < 1`, `pauseEvery < 0`, invalid JSON, or required-field violations. Bounded fields with invalid values (e.g. an unknown `readinessGate`) are silently backfilled to their defaults — same behaviour as `readConfig`. +7 tests in `app.test.ts`.
- **Top-bar nav:** `Projects` + `Settings` links added to the web Header next to the logo. Settings routes to `#/server`.
- **Editable global-settings page.** Promotes `ServerInfo` from read-only into a four-section form:
  - **Agent roles** — five roles (dev, judge, architect, documenter, reflection), each with an adapter dropdown (constrained to `availableAgents`) and an optional model text input.
  - **Iteration defaults** — `maxIterations`, `pauseEvery`, `reflectSafeguardAfter`.
  - **Behaviour flags (item 5.1)** — `autoReviewSpecs`, `autoDocumenter`, `cleanupMergedBranches` as checkboxes. `readinessGate` appears as a 3-option dropdown only when `autoReviewSpecs` is on.
  - **Notifications** — master `enabled` toggle + a 3 events × 4 channels matrix of checkboxes.
  - Save / Cancel buttons; dirty indicator; success confirmation. Server-owned read-only rows (version, port, PID, uptime, available agents) stay at the top.
- **Explicit scope banner on the Settings page:** "This edits the global defaults. Per-project overrides live in each project's Config tab, which is read-only today and becomes editable in plan item 6.14."
- Exposed `validateConfig` from `@cfcf/core` so the server's PUT handler can reuse the same validation/backfill rules as the client-side read path.

### Changed
- `GlobalConfig` interface on the web client widened to reflect the editable surface (`autoReviewSpecs`, `autoDocumenter`, `readinessGate`, typed `notifications`).
- Docs refreshed: `docs/guides/workflow.md` mentions the new Settings link; `docs/guides/cli-usage.md` points to the editable web UI as the wire-compatible mirror of `cfcf config edit`; `docs/api/server-api.md` documents `PUT /api/config` with sample body, response, and error matrix.

### Fixed
- **Web project detail's Config tab was missing several fields** (mirror of the `cfcf project show` gap fixed in 0.7.1). `ConfigDisplay` now renders `status`, `reflectionAgent`, `reflectSafeguardAfter`, `cleanupMergedBranches`, and all three 5.1 flags (`autoReviewSpecs`, `autoDocumenter`, `readinessGate`), plus `processTemplate`. Still read-only -- the editable version lands in plan item 6.14.

## [0.7.2] -- 2026-04-20

Small but meaningful follow-up pass after first real-world autoReviewSpecs testing: one regression fix surfaced mid-test, one UX consistency improvement, plus a UX protection against a gotcha the user hit.

### Fixed
- **User feedback was dropped on pre-loop-review resume.** When the loop paused at the pre-loop review phase (architect returned `NEEDS_REFINEMENT` + readiness gate rejected) and the user provided guidance on Resume (web FeedbackForm or `cfcf resume --feedback "..."`), the feedback was stored on `state.userFeedback` but `runReviewSync` built its own `IterationContext` without the field, so `cfcf-docs/user-feedback.md` was written as the default "No user feedback yet." on the next architect spawn. User feedback now plumbs through correctly on both the web and CLI resume paths (they share the server's `resumeLoop`).

### Added
- **`trigger` field on `ReviewHistoryEvent`.** `"loop"` for pre-loop reviews triggered by the iteration loop; `"manual"` for user-invoked `cfcf review` / web Review button / `POST /api/projects/:id/review`. Web History tab now labels loop-triggered reviews as "Pre-loop review" instead of the plain "Review" used for manual runs. Older events without the field are treated as `"manual"` for backward compat.
- **Generated-copy banner on `cfcf-docs/` files sourced from `problem-pack/`.** `cfcf-docs/problem.md`, `success.md`, `constraints.md`, `hints.md`, `style-guide.md`, and `context/*` all get an HTML-comment banner prepended at write time saying "this file is generated from problem-pack/..., do not edit here — your changes will be lost, edit the source". Banner renders invisibly in markdown viewers, is idempotent (won't stack on re-runs), and explains the filepath to edit instead. Addresses a real user-experienced gotcha where an edit to `cfcf-docs/problem.md` was silently clobbered on the next `writeContextToRepo`.
- **`docs/guides/workflow.md`** gains a new "Files you edit vs. files cfcf regenerates" table covering every user-facing file in `problem-pack/` and `cfcf-docs/` with edit-safe vs. not indicators, plus the `CLAUDE.md` / `AGENTS.md` sentinel rule for completeness.

## [0.7.1] -- 2026-04-19

Ships plan item **5.1** end-to-end plus two small polish fixes surfaced during smoke-testing.

### Added
- **`autoReviewSpecs` + `autoDocumenter` + `readinessGate` config keys (item 5.1).** Three tiers (global / project / per-run) following the same priority order as existing keys, with backfill on pre-5.1 configs + projects so nothing breaks. Defaults: `autoReviewSpecs=false`, `autoDocumenter=true`, `readinessGate="blocked"`.
  - When `autoReviewSpecs=true`, Start Loop first runs the Solution Architect as a pre-loop phase. The standalone Review button is hidden in the web UI (a muted hint "Review is part of the Loop (autoReviewSpecs is on). Change in Settings." appears under the button row). A leading `Review (agent)` step appears in the `PhaseIndicator`. Review output commits to main (not an iteration branch -- it's a deterministic input to the loop, not iteration work). If the `readinessGate` rejects the architect's readiness signal, the loop pauses with the architect's gaps as `pendingQuestions`.
  - When `autoDocumenter=false`, the loop reaches SUCCESS and skips the Documenter entirely; the `Document (agent)` step disappears from the phase indicator. `cfcf document` continues to work manually.
  - `readinessGate` levels: `"never"` (always proceed), `"blocked"` (default; stop only on `BLOCKED`), `"needs_refinement_or_blocked"` (strictest; stop on anything but `READY`).
- **`cfcf run` CLI flags:** `--auto-review` / `--no-auto-review`, `--auto-document` / `--no-auto-document`, `--readiness-gate <level>`. Per-run overrides persisted on `loop-state.json` so pause + resume keep the same behaviour.
- **`cfcf init` prompts** for the three new keys (with contextual explanation, including that `readinessGate` is only asked when auto-review is on) + the reflection safeguard (`reflectSafeguardAfter`).
- **`cfcf config show` + `cfcf project show`** now print the full current config, including the three new keys and the pre-existing `reflectionAgent`, `reflectSafeguardAfter`, and `cleanupMergedBranches` fields that were previously hidden from the text output.
- **New `pre_loop_reviewing` loop phase.** Surfaced in `/api/activity`, the top-bar pulsing indicator, history-polling cadence, and the web `PhaseIndicator`.
- **Shared `resolveLoopConfig` + `readinessGateBlocks` helpers** in `iteration-loop.ts` / `architect-runner.ts` implementing the priority + gate rules. +11 tests in `auto-flags.test.ts`.
- **`runReviewSync`** in `architect-runner.ts`, mirroring the `runDocumentSync` / `runReflectionSync` shape so the loop can run the architect in-line (same re-review detection + non-destructive plan validation as the async entry).

### Fixed
- **`(item 5.1)` tag leaking into `cfcf run --help`.** The `.option()` descriptions for the three new flags referenced the internal plan item -- harmless but noisy for end users. Tags stripped from user-facing strings; code comments still reference items for maintainer context.
- **`cfcf project show` was missing several fields.** Didn't list `reflectionAgent`, `reflectSafeguardAfter`, `cleanupMergedBranches`, or any of the three 5.1 keys. All now rendered, with `readinessGate` conditionally shown when auto-review is on (consistent with `cfcf config show`).

### Changed
- **Docs** refreshed for 5.1: `docs/guides/workflow.md` gains a pre-loop review block in the flow diagram and a new "Behaviour flags" subsection; `docs/guides/cli-usage.md` documents the new `cfcf init` prompts and `cfcf run` flags; `docs/api/server-api.md` updates the `/api/config` response sample, the loop-phase table (`pre_loop_reviewing`), and the `/loop/start` body sample.

## [0.7.0] -- 2026-04-18

Post-0.6.0 hardening and UX refinement pass driven by first real-world testing of the Reflection role against an existing repo ("cfcf-calc"). Two small features (architect re-review, CLAUDE.md sentinel merge), a behavior-changing bug fix (iteration-row status during reflection), and a pass of UI polish on the History tab.

### Added

- **Architect re-review mode.** When `cfcf review` is invoked on a project whose `cfcf-docs/plan.md` already has completed items (`[x]`), cfcf now treats it as a re-review rather than a first-run scaffold. `architect-runner` snapshots `plan.md`, sends a re-review prompt that tells the agent to read the full history (iteration logs, decision log, reflection reviews), and enforces the same non-destructive rule the reflection role uses -- any rewrite that removes a completed item or an iteration header is automatically reverted. Template [cfcf-architect-instructions.md](packages/core/src/templates/cfcf-architect-instructions.md) gains a "Two modes" section documenting first-run vs. re-review, with explicit "append new iterations" / "leave plan untouched and say so" / "skip scaffolding docs/*.md" rules.
- **Sentinel-based `CLAUDE.md` / `AGENTS.md` merge.** cfcf no longer overwrites the dev agent's instruction file unconditionally. The file is now carved into a cfcf-owned section delimited by `<!-- cfcf:begin --> ... <!-- cfcf:end -->` markers; anything outside those markers (user notes, team conventions, skills the user added) is preserved across iterations. First-run: if the file exists without markers, cfcf prepends the sentinel block and keeps user content below. Subsequent runs: only the content between markers is refreshed. Markers missing after a user edit: cfcf falls back to the "prepend" branch on the next iteration. Idempotent when inputs are unchanged.
- **Shared `plan-validation.ts` module.** `validatePlanRewrite`, `extractCompletedItems`, `extractIterationHeaders`, `planHasCompletedItems` extracted from `reflection-runner.ts` so both the Reflection role and the Architect re-review path use one implementation (backward compatible: `reflection-runner` still re-exports `validatePlanRewrite`).
- **PhaseIndicator labels distinguish harness vs agent steps.** Across all three workflows -- loop, review, document -- phase labels now read `Prepare (cf²)` / `Dev (agent)` / `Judge (agent)` / `Reflect (agent)` / `Decide (cf²)` / `Document (agent)` (for loop) and `Prepare (cf²)` / `Execute (agent)` / `Collect (cf²)` (for review + document). Makes it obvious at a glance which phases are cfcf plumbing vs LLM invocations.
- **Richer expanded History rows.**
  - Collapsed judge pill now includes test counts alongside quality, e.g. `PROGRESS (8/10 · 5/5) ▸`.
  - Expanded panel now surfaces judge `user_input_needed` (warning-styled auto-open section when true), `should_continue`, and the iteration's branch name in a "Decision flags" footer.
  - `planRejectionReason` (new on `ReflectionHistoryEvent`) is shown in the expanded reflection detail when the non-destructive validator reverts a plan rewrite -- you can see *why* it was rejected.
  - Happy-path dev self-assessment collapses to a single muted inline line (`Dev self-reported high quality · status: completed · no blockers, no user input needed.`) instead of a click-to-expand with an effectively-empty body.

### Changed

- **Iteration history row flips to `completed` as soon as the judge commits**, not after reflection finishes. Reflection has its own row in the History tab; making the iteration wait for it made the tab look stuck for the duration of the reflection phase. `devSignals` / `judgeSignals` / exit codes / determination are all persisted in this earlier update; the separate `merged` flip in the DECIDE block is unchanged.

### Fixed

- (Retroactive -- also in the 0.6.0 polish commit [db9ceff](https://github.com/fstamatelopoulos/cfcf/commit/db9ceff) that merged as part of PR #6) `LoopPhase` in the web types and the `LOOP_ACTIVE_PHASES` constant in `ProjectDetail.tsx` didn't include `reflecting`, so the UI showed "Decide" during the reflection phase and the history polling dropped from 3s back to 10s. Both fixed in 0.6.0.

## [0.6.0] -- 2026-04-18

Iteration 5 loop-quality phase. Ships item **5.6 Tier 3 Strategic Reflection + iterative planning** end-to-end. cfcf now has a fifth role — **Reflection** — that runs after the judge on every iteration (unless the judge opts out), reviews the full cross-iteration history, and may non-destructively rewrite the pending part of `plan.md`. Full design: [`docs/research/reflection-role-and-iterative-planning.md`](docs/research/reflection-role-and-iterative-planning.md).

### Added
- **Reflection role (item 5.6).** New `reflection-runner.ts` (sync entry for loop + async entry for ad-hoc). Reads decision-log, per-iteration changelogs, prior reflections, a compact per-iteration-branch git log (`cfcf-docs/cfcf-reflection-context.md`), and the tail (~500 lines) of the last dev log. Produces `reflection-analysis.md` + `cfcf-reflection-signals.json` + (optionally) a rewritten `plan.md`. Non-destructive validation: completed items and iteration-header numbers must survive any plan rewrite or cfcf reverts `plan.md` to the prior version. `recommend_stop` pauses the loop (never auto-stops).
- **`cfcf reflect` CLI.** `cfcf reflect --project <name> [--prompt "<focus hint>"]` runs the Reflection role ad-hoc against the current state. Does not mutate `loop-state.json` or write an `iteration-log`. Web parity: `POST /api/projects/:id/reflect`, `GET .../reflect/status`, `POST .../reflect/stop`.
- **Judge opt-out signal.** `JudgeSignals` gains `reflection_needed` and `reflection_reason`. When the judge sets `reflection_needed: false`, cfcf skips reflection for that iteration, up to `reflectSafeguardAfter` consecutive skips (default 3) — on the (N+1)th, cfcf forces reflection regardless.
- **Iteration-log artifact.** The dev agent now writes `cfcf-docs/iteration-logs/iteration-N.md` at the end of each iteration (backward-looking changelog of changes, tests, commits, plan items closed). Complements `iteration-handoff.md` (forward-looking). cfcf rebuilds `iteration-history.md` from these files each iteration, so history survives loop restarts.
- **Decision-log multi-role charter.** `decision-log.md` is now the shared append-only journal for dev, judge, architect, reflection, and user. Entries use the tagged format `## <ISO-UTC>  [role: X]  [iter: N]  [category: decision|lesson|observation|strategy|risk|resolved-question]`. All four role-instruction templates updated with per-role appending guidance.
- **Three-commit discipline per iteration.** Each iteration now produces up to three commits: `cfcf iteration N dev (<adapter>)`, `cfcf iteration N judge (<adapter>)`, and (when reflection ran) `cfcf iteration N reflect (<health>): <key_observation>`.
- **New config fields.** `reflectionAgent` and `reflectSafeguardAfter` on both `CfcfGlobalConfig` and `ProjectConfig`. Existing configs are backfilled on read (reflection defaults to the architect agent's adapter, safeguard defaults to 3).
- **Web UI: reflection row in History tab.** Color-coded `iteration_health` (converging=green, stable=blue, stalled=yellow, diverging=red, inconclusive=grey), `✎ plan edited` badge when `plan_modified`, `! stop` badge when `recommend_stop`, and `key_observation` underneath.
- **New templates.** `cfcf-reflection-instructions.md`, `cfcf-reflection-signals.json`, `iteration-log.md` (format reference for the dev agent).
- **Expandable judge + reflection detail rows** (`JudgeDetail.tsx` + `ReflectionDetail.tsx`), mirroring the `ArchitectReview` expansion pattern. Iteration rows expand to show dev + judge signals together (quality, tests, concern, blockers, reflection opt-out); reflection rows expand to show health rationale + plan-modified / rejected state + `recommend_stop` banner.
- **Full parsed `devSignals` + `judgeSignals` persisted inline on iteration history events**, so rows stay expandable even after the on-disk signal files are overwritten next iteration.
- **Cross-project activity endpoint + pulsing top-bar indicator.** New `GET /api/activity` returns currently-running agent runs across all projects (reads each project's `history.json` + `loop-state.json`; loop state has priority for finer-grained phase info). Header polls /activity (3s active, 10s idle) and shows a pulsing blue dot + label (`project-name: reflect #3` or `N agents running`) whenever anything is in flight.
- **Read-only server + config page.** New route `#/server` rendered via `ServerInfo.tsx`: server status (version, port, PID, uptime, available agents, configured) and global config defaults (per-role agent + model, max iterations, pause cadence, `reflectSafeguardAfter`, `cleanupMergedBranches`). Linked from a new `server & config →` button on the Dashboard header.

### Changed
- **`makeDecision` accepts reflection signals.** Reflection's `recommend_stop` takes precedence over the judge's determination (research doc Q6): when reflection flags the loop as fundamentally stuck, cfcf pauses for the user even if the judge said PROGRESS. `max_iterations` and dev `user_input_needed` still short-circuit first.
- **New `reflecting` phase** in `LoopPhase`. Iteration flow: `preparing → dev_executing → judging → reflecting (conditional) → deciding → documenting (on success)`.
- **Decision-log size warning.** Once iteration count crosses 50, cfcf fires a single informational notification per loop run. No auto-trim — the user owns the log.
- **Docs:** full markdown sweep aligning every user + design + API doc with the reflection role and 0.7.0 features — `workflow.md`, `cli-usage.md`, top-level `README.md`, `CLAUDE.md`, `docs/README.md`, `docs/api/server-api.md`, `docs/design/technical-design.md`, `docs/design/agent-process-and-context.md`, `docs/design/cfcf-requirements-vision.md`. `docs/plan.md` item 5.6 marked ✅; `docs/research/reflection-role-and-iterative-planning.md` §10 stamped "Shipped 2026-04-18".

### Fixed
- **`iteration-history.md` loop-restart bug.** The file is now rebuilt each iteration from the committed `cfcf-docs/iteration-logs/iteration-*.md` files instead of relying on the in-memory `LoopState.iterations`, so it survives `cfcf stop` / restart cycles.

## [0.5.0] -- 2026-04-18

Iteration 5 distribution phase. Single self-contained `cfcf-binary` with no Bun runtime, no repo checkout, and no external assets on the user's disk. Finalized design for the upcoming Reflection role (item 5.6) now lives under `docs/research/`.

### Added
- **Binary self-hosting (item 5.3):** compiled `cfcf-binary` hosts the server itself. `cfcf server start` detects whether the server source file exists on disk; if not (compiled binary), it re-spawns itself with `CFCF_INTERNAL_SERVE=1`, and the CLI entry point dispatches straight to `startServer()`. Dev mode (`bun run dev:cli`) keeps the original `bun run packages/server/src/index.ts` spawn path. Verified end-to-end: a fresh 64 MiB `cfcf-binary` copied to `/tmp` with no repo and no Bun runtime starts the server, serves the API, serves the web GUI, and shuts down cleanly.
- **Embedded runtime assets (item 5.4):** templates (13 `.md` / `.json` files) and the web dist bundle (222 KB JS + 14 KB CSS + HTML, ~237 KB total) are now compiled into the binary, so the compiled artifact is self-contained.
  - `packages/core/src/templates.ts` — embedded template registry + resolver. Lookup order: `<repoPath>/cfcf-templates/<name>` (project-local override) → `<CFCF_CONFIG_DIR>/templates/<name>` (user-global override) → embedded default. All four template consumers (`architect-runner`, `judge-runner`, `documenter-runner`, `context-assembler`) migrated to `getTemplate()`. 12 unit tests cover embedded resolution, override precedence, and `writeTemplateIfMissing` non-clobbering behavior.
  - `scripts/embed-web-dist.ts` — runs as part of `bun run build:web`; reads `packages/web/dist/**` and writes a gitignored `packages/server/src/web-assets.generated.ts` whose exported `WEB_ASSETS` map is served by Hono. Dev fallback reads from disk when the generated file is absent.
- **`cleanupMergedBranches` flag (item 5.2):** new optional config field on both `CfcfGlobalConfig` (default for new projects) and `ProjectConfig` (per-project override). When `true`, the iteration loop deletes the `cfcf/iteration-N` branch after a successful auto-merge to main. Default `false` so the audit trail is preserved by default. Non-fatal on delete failure (logged warning, loop continues). Tests added: `git-manager` round-trip (create → merge → delete) and `projects.createProject` default verification.
- **Finalized design for Reflection role (item 5.6, implementation deferred):** `docs/research/reflection-role-and-iterative-planning.md` captures the full flow — per-iteration reflection with judge opt-out + `reflectSafeguardAfter` ceiling, non-destructive plan rewrites, single `decision-log.md` as multi-role journal with tagged entries, new `cfcf-docs/iteration-logs/iteration-N.md` changelog artifact (dev-agent authored), `cfcf reflect` CLI for ad-hoc reflection, three-PR implementation plan. All open questions resolved. Ready for a dedicated implementation session.

### Changed
- `bun run build:web` now runs both the Vite build and `scripts/embed-web-dist.ts` so the generated server-side asset bundle stays in sync with the Vite output.
- `bun run build` now depends on `build:web` so the compiled binary always carries a fresh embedded web bundle.
- `tsconfig.json` `include` extended to cover `packages/core/src/templates/*.json` (so the `with { type: "text" }` import resolution is well-typed). An ambient `packages/core/src/templates.d.ts` declares `*.md` and `*/templates/*.json` as string modules so the `type: "text"` imports type-check cleanly without disabling `resolveJsonModule`.
- `docs/plan.md`: item 5.6 marked "designing" and linked to the research doc; item 6.12 added for CLI ↔ web-GUI parity audit (surfaced by the `cfcf reflect` work).
- Doc sanity pass across `CLAUDE.md`, `README.md`, `docs/design/cfcf-stack.md`, `docs/design/technical-design.md`, `docs/design/cfcf-requirements-vision.md`, `docs/design/agent-process-and-context.md` to reflect shipped 0.4.0, in-flight 0.5.0, and the upcoming Reflection role.

## [0.4.0] -- 2026-04-18

Iteration 4: Web GUI + operational robustness + notifications + architect-review UI + live timer + per-iteration scope discipline.

### Added

**Web GUI (`packages/web`, React + Vite):**
- Dashboard with project list and status badges
- Project detail page with Status / History / Logs / Config tabs
- PhaseIndicator for loop / review / document runs
- LoopControls with Start / Stop / Resume / Review / Document buttons; Stop Review and Stop Document while running
- FeedbackForm for resuming paused loops with user direction
- Real-time log streaming via SSE; persists across tab switches
- Unified ProjectHistory timeline (reviews + iterations + documents) with per-entry log link
- Hono serves built assets via `serveStatic`; CORS for `/api/*` during dev

**Server API:**
- `GET /api/projects/:id/history` — persistent history of all agent runs
- `GET /api/projects/:id/logs/:filename` — generic log streaming by filename (with path-traversal safety)
- `GET /api/projects/:id/loop/events` — SSE stream of loop phase transitions
- `POST /api/projects/:id/review/stop` — kill a running review
- `POST /api/projects/:id/document/stop` — kill a running documenter

**Persistence and state:**
- `loop-state.json` per project persists across server restarts
- `history.json` per project tracks every agent run (review, iteration, document) across loop restarts
- Sequence-numbered logs for architect and documenter (`architect-001.log`, `documenter-001.log`, etc.) so re-runs preserve history
- `documenting` phase added to `LoopPhase` (loop stays active while docs are generated post-SUCCESS)

**Operational robustness (item 4.16):**
- Central active-processes registry (`packages/core/src/active-processes.ts`) tracks all running agent processes
- Graceful shutdown on SIGINT/SIGTERM: kills all tracked processes, marks history events + loop states as failed, removes PID file
- Startup recovery: stale "running" history events and stale active loop states are marked failed (recovers from crashes)
- `--watch` mode warning at startup so users know file changes will kill active agents
- `process.on('unhandledRejection')` and `process.on('uncaughtException')` handlers trigger graceful shutdown
- Fire-and-forget `.catch()` handlers in runners now try/catch themselves so recording failures don't silently swallow the original error

**Notifications (item 4.18):**
- 3 event types: `loop.paused`, `loop.completed`, `agent.failed`
- 4 channels: `terminal-bell` (BEL to stderr), `macos` (osascript), `linux` (notify-send), `log` (JSON Lines audit trail)
- Fire-and-forget dispatcher with 5s per-channel timeout
- Global + per-project config; configured during `cfcf init`
- Webhook channel and additional events (iteration.completed, review.completed, etc.) deferred to iteration 5

**Architect review presentation (item 4.23):**
- Full parsed `ArchitectSignals` now persisted inline on `ReviewHistoryEvent.signals` (the repo file `cfcf-docs/cfcf-architect-signals.json` is overwritten by every review run, so inline persistence is what makes prior reviews viewable)
- New `ArchitectReview` React component renders readiness + guidance banner keyed to readiness (e.g. "Edit files under `problem-pack/` and rerun Review" for `NEEDS_REFINEMENT`) + collapsible gaps / suggestions / risks / recommended_approach sections
- Integrated into Status tab (latest review) and History tab (clickable readiness pill expands an inline detail row in compact mode)
- Backward-compatible: pre-4.23 review events without `signals` still render their readiness label as plain text

**Per-iteration plan execution discipline (item 4.24):**
- One-phase-per-iteration discipline injected at three levels: (1) `context-assembler.generateInstructionContent()` embeds an "Iteration Scope" section in the Tier-1 instruction file regenerated fresh every iteration — reaches existing projects whose static `process.md` was copied before this change; (2) one-line dev-agent CLI prompt spells out "execute only the next pending chunk from `plan.md`"; (3) static `process.md` and architect `plan.md` templates model the same phases-as-iterations structure for new projects
- Agent-agnostic — same generated content is written to whichever filename each adapter specifies (Claude Code: `CLAUDE.md`; Codex: `AGENTS.md`)
- Discovered empirically via a user-authored hint while running the tracker example, promoted into the core prompts so every project gets checkpointed iterations by default

**Live elapsed-time counter (item 4.25):**
- Shared `formatDuration` util + `useElapsed` hook (1s local tick, no server calls) renders the active agent-run's elapsed time next to the title row (e.g. "Iteration 2 · 2m 14s")
- Same format used by the History tab Duration column (now sourced from the shared util)
- Hides on completed/failed/stopped; freezes on paused
- First web-package test suite added (9 tests for `formatDuration`); `test:web` script added at the root

**Other:**
- `git merge --no-ff` for iteration merges — preserves iteration boundaries in `git log --graph`
- Claude Code adapter: added `--verbose` flag (note: `-p` print mode still emits final-only; `--verbose` helps in mixed modes)
- `docsFileCount` / `committed` / `exitCode` fields on Document history events, shown in the History tab
- Test repo setup/cleanup scripts (`scripts/setup-test-repos.sh`, `scripts/cleanup-test-repos.sh`)
- Tabular iteration plan format in `docs/plan.md`
- 205 tests total (170 core + 24 server + 2 cli + 9 web)

### Changed
- `ReviewHistoryEvent` now persists full `signals` inline (`packages/core/src/project-history.ts`). Backward-compatible with pre-4.23 entries.

### Fixed
- Log viewer performance on large logs (50K+ lines) — single `<pre>` block with all lines
- Review / Document buttons: auto-switch to Logs tab and stream the log on click
- History tab correctly shows completion status for reviews and documents (previously could get stuck at "running" when polling was disabled)
- Review / Document / Start Loop buttons remain visible (disabled) while another agent is running — no longer disappear
- Configuration validation backfills `architectAgent` and `documenterAgent` in older config files

## [0.3.0] -- 2026-04-15

Iteration 3: Iteration loop, judge agent, Solution Architect, human-on-the-loop. **This is the MVP.**

### Added
- **Iteration loop controller**: full dark factory loop (dev → judge → decide → repeat)
- **Decision engine**: maps judge signals to deterministic actions (continue/pause/stop)
- **Judge runner**: spawns judge agent, parses assessment + signal file, archives reviews
- **Solution Architect**: `cfcf review --project <name>` for pre-iteration Problem Pack review
  - Readiness assessment (READY / NEEDS_REFINEMENT / BLOCKED)
  - Gap analysis, security review, solution options
  - **Initial plan outline** written to `cfcf-docs/plan.md` for dev agents to build on
- **Human-on-the-loop controls**:
  - `cfcf resume --project <name> [--feedback "..."]` to resume paused loops
  - `cfcf stop --project <name>` to halt running loops
  - Pause-every-N cadence with user review
  - Signal-driven pause when agents need user input
- **Model selection per role**: `cfcf init` asks for model per agent role (dev, judge, architect)
- **Architect agent config**: `architectAgent` in global and project config
- **Enhanced `cfcf status --project <name>`**: shows loop phase, iteration history, judge determinations
- Server endpoints: `POST .../loop/start`, `GET .../loop/status`, `POST .../loop/resume`, `POST .../loop/stop`, `POST .../review`, `GET .../review/status`
- Templates: judge instructions, judge signal file, architect instructions, architect signal file
- Auto-merge to main on PROGRESS/SUCCESS (configurable: auto vs PR-based)
- Push to remote on success
- **Documenter role**: runs automatically post-SUCCESS to produce polished final documentation
  - `cfcf document --project <name>` for on-demand documentation generation
  - Produces: `docs/architecture.md`, `docs/api-reference.md`, `docs/setup-guide.md`, `docs/README.md`
  - Server endpoints: `POST .../document`, `GET .../document/status`
- **Three-layer documentation strategy**: Architect creates doc stubs → Dev agent maintains them each iteration → Documenter polishes post-SUCCESS
- **Loop state persistence**: loop state saved to disk on every phase transition, survives server restarts
- Elapsed time counter in CLI polling (replaces dots)
- 172 tests (335 assertions) -- 52 new tests covering all new components

### Changed
- `cfcf run --project <name>` now starts the full iteration loop (dark factory mode) by default
- Manual mode preserved with `cfcf run --project <name> -- <cmd>`
- `ProjectConfig` now includes `architectAgent`, `documenterAgent`, `status` fields
- `AgentAdapter.buildCommand()` accepts optional `model` parameter
- Log storage supports architect role alongside dev and judge
- Codex adapter updated to use `codex -a never exec -s danger-full-access` (headless exec mode, full access)

### Fixed
- Codex adapter: updated CLI flags for current Codex CLI (was using removed `--approval-mode` flag)
- Codex adapter: global flag `-a` must precede `exec` subcommand
- Judge failure now shows helpful error message with log file path (was showing bare "anomaly")
- Judge retry on resume: when dev succeeds but judge fails, resume retries only the judge on the same branch
- Problem Pack validated before branch switch (was switching to empty branch first, losing access to files)
- Stale iteration branches from failed runs are deleted and recreated off current HEAD

## [0.2.0] -- 2026-04-12

Iteration 2: Problem Pack, context assembly, agent-mode run. First successful end-to-end agent iteration.

### Added
- Problem Pack parser: reads problem.md, success.md, constraints.md, hints.md, context/
- Context assembler: generates CLAUDE.md (or AGENTS.md for Codex) with tiered context (Tier 1 embedded, Tier 2 files, Tier 3 reference)
- Agent-mode `cfcf run --project <name>`: launches configured dev agent with assembled context
- Manual mode `cfcf run --project <name> -- <cmd>` preserved for testing/debugging
- cfcf-docs/ templates: process.md, iteration-handoff.md, cfcf-iteration-signals.json, decision-log.md, plan.md, iteration-history.md, judge-assessment.md, user-feedback.md
- `cfcf project init` scaffolds problem-pack/ directory with problem.md and success.md templates
- Post-iteration parsing of handoff document and signal file
- `instructionFilename` on AgentAdapter interface (CLAUDE.md for Claude Code, AGENTS.md for Codex)
- Async iteration runner: server runs agent in background, CLI polls for status
- Real-time log streaming: agent output written to disk incrementally with flush
- Iteration status endpoint: `GET /api/projects/:id/iterations/:n/status`
- Latest iteration endpoint: `GET /api/projects/:id/iterations/latest`
- Example Problem Pack: calculator module (problem-packs/example/)
- 120 tests (227 assertions) covering all new components

### Changed
- `POST /api/projects/:id/iterate` now returns 202 (async) instead of blocking until agent completes
- Process manager streams logs to disk in real-time instead of buffering in memory

### Fixed
- HTTP timeout on long agent runs: refactored from synchronous request/response to async pattern with status polling

## [0.1.0] -- 2026-04-12

Iteration 1: Project management, process manager, git manager, CI pipeline.

### Added
- Project management: `cfcf project init/list/show/delete` with per-project config stored under `~/.cfcf/projects/`
- Global config commands: `cfcf config show`, `cfcf config edit`
- Process manager: spawn commands, stream logs, capture output to disk, kill/timeout support
- Git manager: feature branch creation (`cfcf/iteration-N`), commit, diff, reset, push, merge
- `cfcf run --project <name> -- <command>` executes the next iteration (creates branch, runs command, captures logs, commits)
- Server endpoints: project CRUD, `POST /api/projects/:id/iterate`, `GET /api/projects/:id/iterations/:n/logs` (SSE), `POST /api/shutdown`
- Reliable `cfcf server stop` using PID file and `/api/shutdown` endpoint
- Log storage at `~/.cfcf/logs/<project>/iteration-NNN-dev.log`
- GitHub Actions CI: test + typecheck on Ubuntu and macOS, cross-platform binary builds
- `bun run build` compiles a self-contained 64MB binary
- CLI usage guide: `docs/guides/cli-usage.md`
- 90 tests (169 assertions) covering all new components

### Changed
- Simplified execution model: removed "run" concept. Iterations are monotonically numbered per project (project → iteration, not project → run → iteration)
- `ProjectConfig` now tracks `currentIteration` counter
- SSE events renamed: `project.paused`, `project.completed` (was `run.*`)

## [0.0.0] -- 2026-04-11

Iteration 0: Project scaffolding, server skeleton, CLI, first-run configuration.

### Added
- Bun monorepo with `@cfcf/core`, `@cfcf/server`, `@cfcf/cli` workspace packages
- Hono-based HTTP server with `/api/health`, `/api/status`, `/api/config` endpoints
- Commander.js CLI with `cfcf init`, `cfcf status`, `cfcf server start/stop/status`
- First-run interactive configuration: agent detection, user prompts, permission acknowledgment
- Agent adapter interface with Claude Code and Codex CLI adapters
- Platform-specific config storage (XDG on Linux, Application Support on macOS, AppData on Windows)
- 35 tests (74 assertions) covering core config, adapters, server API, and CLI client
- Project documentation suite: requirements & vision (v0.4), tech stack, technical design, agent process & context, development plan, server API reference
- CLAUDE.md with project principles for AI coding agents
- docs/ structure: design/, api/, research/, guides/

[Unreleased]: https://github.com/fstamatelopoulos/cfcf/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/fstamatelopoulos/cfcf/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/fstamatelopoulos/cfcf/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/fstamatelopoulos/cfcf/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/fstamatelopoulos/cfcf/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/fstamatelopoulos/cfcf/compare/v0.0.0...v0.1.0
[0.0.0]: https://github.com/fstamatelopoulos/cfcf/releases/tag/v0.0.0
