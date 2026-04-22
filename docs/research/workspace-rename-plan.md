# Plan item 5.10 — `project` → `workspace` rename: execution plan

**Branch:** `iteration-5/workspace-rename` (this branch).
**Status:** Execution checklist, 2026-04-21. No code changes yet — this doc exists so the next session can execute mechanically against a pre-surveyed rename surface.
**Target release:** `v0.8.0` (breaking change; precedes Clio v1).
**Context:** see [Clio design doc §2](../design/clio-memory-layer.md#2-naming-project-tension). TL;DR: Cerefox reserves "Project" for domain groupings of knowledge; cf² currently overloads "project" to mean "one managed git repo". The two collide when Clio lands. Resolution: rename cf²'s noun to "workspace", leave Cerefox's "Project" free to mean what Clio expects.

This is a **mechanical, breadth-first rename**. The goal is to execute it in one focused session against this checklist. Survey numbers below were produced by `grep` on `main` at commit `d02c61d` (the Clio design doc commit).

---

## 1. What renames, what doesn't

### Renames (user-facing + types + code identifiers)

| From | To | Surface |
|---|---|---|
| "project" (a cf²-managed git repo) | "workspace" | UI labels, docs, status messages, prompts |
| `ProjectConfig` | `WorkspaceConfig` | TS type (core + web) |
| `ProjectStatus` | `WorkspaceStatus` | TS type |
| `projectId`, `projectName` | `workspaceId`, `workspaceName` | fields on LoopState, HistoryEvent, NotificationEvent, ReflectState, ReviewState, DocumentState, etc. |
| `project` (as a local variable / parameter for a cf²-managed git repo) | `workspace` | Function signatures + variable names where it refers to the cf²-managed git repo |
| `cfcf project <verb>` | `cfcf workspace <verb>` | CLI subcommand tree |
| `--project <name>` flag | `--workspace <name>` flag | CLI flag on run/review/resume/stop/document/reflect/status |
| `/api/projects/*` | `/api/workspaces/*` | REST route paths |
| `fetchProject`, `fetchProjects`, `saveProject` etc. | `fetchWorkspace`, `fetchWorkspaces`, `saveWorkspace` etc. | web API client fns |
| `ProjectCard`, `ProjectDetail`, `ProjectHistory` | `WorkspaceCard`, `WorkspaceDetail`, `WorkspaceHistory` | web components |
| "Projects" top-bar label | "Workspaces" | web UI |
| `#/projects/:id` hash route | `#/workspaces/:id` | web router |
| `page: "project"` | `page: "workspace"` | useRoute state |

### Deliberately NOT renamed (internal / on-disk / shared vocabulary)

| Thing | Why |
|---|---|
| `~/.cfcf/projects/<id>/config.json` on-disk path | Existing users have state there. No migration pain: internal detail, never shown to the user, doesn't affect functionality. Can rename later if it actually matters. |
| `~/.cfcf/logs/<project-id>/` | Same reason. Internal. |
| `cfcf-docs/` file tree (`iteration-logs/`, `iteration-reviews/`, etc.) | These paths don't reference "project" — no work needed. |
| `iteration-N.md` filenames | Per-iteration artifacts, no "project" in the name. |
| Git remote config (`git push` uses repo's own `origin`) | We already decided the `repoUrl` field was unneeded (v0.7.5). |
| The word "project" in user-authored content (problem.md, etc.) | User's problem domain may legitimately use the word for its own meaning. Only cf²'s own usage changes. |
| The word "project" inside **Cerefox docs** ingested via Cerefox tool | That's Cerefox's vocabulary, not cf²'s. |
| "iteration-handoff", "iteration-log" variable names | Don't reference "project". |
| `clio_projects` table name in Clio design doc | That's Cerefox's `Project` concept which is staying. Clio table names are intentionally Cerefox-aligned. |

### Kept as deprecated aliases (one release)

| Alias | Why |
|---|---|
| `cfcf project <verb>` as hidden CLI alias | Scripts, CI, user muscle memory. Emits a one-line deprecation notice to stderr. Removed in v0.9.0. |
| `/api/projects/*` REST routes as thin wrappers around `/api/workspaces/*` handlers | External scripts that curl the API. Same deprecation horizon as CLI. |
| `#/projects/:id` hash routes → redirect to `#/workspaces/:id` | Bookmarked URLs. Small client-side hook. |
| `ProjectConfig` type alias = `WorkspaceConfig` | For third-party plugins if any exist (none today). Zero runtime cost. Remove in v0.9.0. |
| `projectId` / `projectName` fields on **persisted** JSON (loop-state, history events) | Old cf² writes produced these. New cf² reads both; writes only the new names. Removed from read tolerance in v0.9.0. |

---

## 2. Rename surface — file-by-file enumeration

**Total:** 46 source files across packages + 13 doc files. Plus 8 template files for prompt language.

### 2.1 Core types (the source of truth)

- `packages/core/src/types.ts`
  - `ProjectConfig` → `WorkspaceConfig` (interface, ~150 lines). Add `export type ProjectConfig = WorkspaceConfig;` as a deprecated alias at the bottom of the file with a `@deprecated` JSDoc.
  - `ProjectStatus` → `WorkspaceStatus` type alias. Same deprecated-alias treatment.
  - No field inside the interface is called `project*` — the interface itself carries the name.

### 2.2 Core functionality (16 TS files)

Files that import `ProjectConfig` / `ProjectStatus` and/or use `projectId`/`projectName`:

- `packages/core/src/projects.ts` — **hot spot**. Rename the file? No, keep as `projects.ts` so existing import paths continue to resolve — but all exports inside rename:
  - `createProject` → `createWorkspace` (+ deprecated alias re-export)
  - `getProject` → `getWorkspace` (+ alias)
  - `listProjects` → `listWorkspaces` (+ alias)
  - `findProjectByName` → `findWorkspaceByName` (+ alias)
  - `updateProject` → `updateWorkspace` (+ alias)
  - `deleteProject` → `deleteWorkspace` (+ alias)
  - `getProjectDir` / `getProjectsDir` — internal path helpers. Keep names (on-disk path unchanged per §1).
  - `validateProjectRepo` → `validateWorkspaceRepo` (+ alias)
  - `nextIteration` — no rename needed.
  - The module-level doc-comment "Project management for cfcf" → "Workspace management for cfcf".
- `packages/core/src/config.ts` — no `ProjectConfig` usage; skip.
- `packages/core/src/iteration-loop.ts` — ~20 sites. `projectId`/`projectName`/`project` everywhere as local variables/params. Rename. `ProjectConfig` → `WorkspaceConfig`.
- `packages/core/src/judge-runner.ts` — `ProjectConfig` + `project.repoPath` style refs.
- `packages/core/src/architect-runner.ts` — same.
- `packages/core/src/documenter-runner.ts` — same.
- `packages/core/src/reflection-runner.ts` — same.
- `packages/core/src/context-assembler.ts` — `project: ProjectConfig` in `IterationContext`; rename to `workspace: WorkspaceConfig` with a one-release alias.
- `packages/core/src/log-storage.ts` — `getProjectLogDir(projectId)`. **Keep function name** (on-disk path unchanged). But the parameter `projectId` → `workspaceId`; update all call sites.
- `packages/core/src/active-processes.ts` — `projectId` field rename (typed, not persisted).
- `packages/core/src/project-history.ts` — filename? **Rename file to `workspace-history.ts`** and update imports. `history.json` on disk stays under `~/.cfcf/projects/<id>/`. Events inside stay as-is in the file format but the TS types gain the `workspace*` field names (see §3 on persisted-state compat).
- `packages/core/src/notifications/dispatcher.ts` — `projectId` / `projectName` params on `makeEvent`; `event.project.{id,name}` shape on `NotificationEvent`. Rename carefully: the persisted structure is loose (log channel writes JSON), so a shape change here needs thought — see §3.
- `packages/core/src/plan-validation.ts` — no project refs expected; verify during execution.
- `packages/core/src/index.ts` — re-exports; update.

### 2.3 Core tests (7 files, ~30 sites)

- `packages/core/src/projects.test.ts` — rename all.
- `packages/core/src/iteration-loop.test.ts`
- `packages/core/src/auto-flags.test.ts`
- `packages/core/src/context-assembler.test.ts`
- `packages/core/src/judge-runner.test.ts`
- `packages/core/src/reflection-runner.test.ts`
- `packages/core/src/architect-runner.test.ts`
- `packages/core/src/documenter-runner.test.ts`
- `packages/core/src/active-processes.test.ts`
- `packages/core/src/notifications/dispatcher.test.ts`

Each has a `makeProject` / `makeProjectConfig` helper. Rename to `makeWorkspace` consistently.

### 2.4 Server (2 files, ~40 route/test sites)

- `packages/server/src/app.ts` — **biggest concentration**. 32 `/api/projects/*` route registrations. Strategy:
  1. Rename the handler functions from `projectsController.*` patterns (inline today) to operate under `/api/workspaces/*`.
  2. Add thin alias wrappers under `/api/projects/*` that `await` the same handler (or re-register with both paths pointing at the same function).
  3. Either approach works; prefer approach 2 — one function per verb, two route paths pointing at it, marked with a comment block "deprecated in v0.8.0, remove in v0.9.0".
- `packages/server/src/app.test.ts` — ~50 sites. Add a small shared helper `workspaceUrl(id, suffix)` so the test file can flip between old and new paths; for v0.8.0 we run tests against both paths (ensures aliases work) and then drop the alias tests in v0.9.0.
- `packages/server/src/iteration-runner.ts` — `ProjectConfig` usage; rename.
- `packages/server/src/start.ts` — only log messages; check for "project" language.

### 2.5 CLI (9 files, ~40 sites)

- `packages/cli/src/commands/project.ts` — **rename file** to `workspace.ts`. Inside:
  - `.command("project")` → `.command("workspace")`.
  - Register the old command as an alias that prints `[deprecated] "cfcf project ..." is now "cfcf workspace ..."; this alias will be removed in v0.9.0.` to stderr then dispatches to the new handler.
  - All sub-verbs (`init`, `list`, `show`, `delete`) operate the same; just the top-level noun changes.
- `packages/cli/src/index.ts` — import rename + register both old and new commands during the alias window.
- `packages/cli/src/commands/run.ts` — `--project <name>` → `--workspace <name>` with `--project` as deprecated alias. `projectParam` local variable → `workspaceParam`.
- `packages/cli/src/commands/review.ts` — same flag treatment.
- `packages/cli/src/commands/resume.ts` — same.
- `packages/cli/src/commands/stop.ts` — same.
- `packages/cli/src/commands/document.ts` — same + `ProjectStatusResponse` type rename.
- `packages/cli/src/commands/reflect.ts` — same.
- `packages/cli/src/commands/status.ts` — same + `ProjectConfig` usage.
- `packages/cli/src/commands/init.ts` — help text mentions "create a project": update to "create a workspace".

CLI alias strategy per flag: Commander.js supports `.option("-w, --workspace <name>")` + `.option("--project <name>", { hidden: true })`. During parsing both populate the same key if we set them up correctly, OR we handle both in the action handler (`opts.workspace || opts.project`). Go with the explicit-handler approach — clearer when debugging.

### 2.6 Web UI (10 files, ~60 sites)

- `packages/web/src/types.ts` — `ProjectConfig` / `ProjectStatus` / `IterationHistoryEvent`'s `projectId` / etc.
- `packages/web/src/api.ts` — `fetchProject`, `fetchProjects`, `saveProject`, `startReview(projectId)` etc. All rename with aliased re-exports for v0.8.0.
- `packages/web/src/App.tsx` — imports `ProjectDetail`; route dispatch `route.page === "project"` → `"workspace"`. The hash is handled by useRoute; that's where the redirect lives.
- `packages/web/src/hooks/useRoute.ts` — add: if hash is `#/projects/<id>`, transparently treat it as `#/workspaces/<id>` (one-line `.replace` in `parseHash`) + update the type union to `"workspace"`.
- `packages/web/src/pages/Dashboard.tsx` — heading "Projects" → "Workspaces"; nav link; "No projects" empty state → "No workspaces"; code example string mentions `cfcf project init` → `cfcf workspace init`.
- `packages/web/src/pages/ProjectDetail.tsx` — **rename file** to `WorkspaceDetail.tsx`. Update imports in App.tsx.
- `packages/web/src/pages/ServerInfo.tsx` — the scope banner says "per-project overrides live in each project's Config tab" — update to "per-workspace". The `Settings` link in Header doesn't reference "project"; check.
- `packages/web/src/components/ProjectCard.tsx` → `WorkspaceCard.tsx` (file + export rename).
- `packages/web/src/components/ProjectHistory.tsx` → `WorkspaceHistory.tsx` (file + export rename).
- `packages/web/src/components/ConfigDisplay.tsx` — `project` prop → `workspace` prop; labels "Project ID" → "Workspace ID"; banner "override the global defaults for this project only" → "this workspace only". The `onSaved` callback's parameter.
- `packages/web/src/components/StatusBadge.tsx` — `ProjectStatus` type usage.
- `packages/web/src/components/Header.tsx` — the `Projects` nav link. Update label + href to `#/workspaces` (index route). Keep `#/` as the root (Dashboard).
- `packages/web/src/components/FeedbackForm.tsx` — any `projectId` references; check.
- `packages/web/src/components/LogViewer.tsx` — `projectId` prop if present; check.
- `packages/web/src/components/LoopControls.tsx` — same.

### 2.7 Templates (8 files)

Agent-facing prompt language. Any sentence like "this project's plan.md" → "this workspace's plan.md":

- `packages/core/src/templates/process.md`
- `packages/core/src/templates/cfcf-architect-instructions.md`
- `packages/core/src/templates/cfcf-judge-instructions.md`
- `packages/core/src/templates/cfcf-documenter-instructions.md`
- `packages/core/src/templates/cfcf-reflection-instructions.md`
- `packages/core/src/templates/iteration-handoff.md`
- `packages/core/src/templates/iteration-log.md`
- `packages/core/src/templates/decision-log.md`

**Exception:** the word "project" when referring to **the user's problem being solved** (i.e. the codebase concept, what they're building) should stay "project" — agents are used to that word. Only cf²-infrastructure-meaning "project" (the cf²-managed git-repo entity) renames to "workspace". When in doubt, keep "project" (safer default — agents won't care). Do one pass with a reviewer mindset after the mechanical rename.

### 2.8 Docs (13 files)

Update user-facing terminology, update CLI command examples, update deprecation notes:

- `README.md` — status line, Five Agent Roles table doesn't use project, file-structure tree.
- `CLAUDE.md` — internal architecture note references "project management".
- `CHANGELOG.md` — **new `[0.8.0]` entry** describing the rename + alias horizon.
- `docs/plan.md` — item 5.10 gets flipped ❌ → ✅; decision-log entry added; item 5.7 (Clio) Notes column updates the prerequisite mention.
- `docs/guides/workflow.md` — biggest doc. Every "project" referring to cf²-managed git repo becomes "workspace". CLI example blocks. Flow diagrams.
- `docs/guides/cli-usage.md` — every CLI example. Note deprecation aliases.
- `docs/api/server-api.md` — path docs.
- `docs/design/technical-design.md` — architecture references.
- `docs/design/agent-process-and-context.md` — references (if any).
- `docs/design/cfcf-stack.md` — references (if any).
- `docs/design/cfcf-requirements-vision.md` — check.
- `docs/design/clio-memory-layer.md` — already uses "workspace" prospectively; should now remove the "Wherever this doc says 'workspace' the code still uses 'project' today" caveat (§2 last paragraph).
- `docs/research/cross-project-knowledge-layer.md` — spot-check for cfcf-project vs Clio-Project mentions.
- `docs/research/reflection-role-and-iterative-planning.md` — historical; leave unless something is actively misleading.
- `docs/decisions-log.md` — keep historical entries as-is; add one new entry noting the rename.
- `docs/research/workspace-rename-plan.md` — **this doc**. Keep for historical record of the decision.

### 2.9 CI / build scripts

- `scripts/*.ts` — spot-check for any "project" references in test-repo setup scripts.
- `package.json` — scripts section doesn't reference "project".
- `.github/workflows/*.yml` — check.

---

## 3. Backward-compat strategy (persisted state)

The wire format of two on-disk files matters for users upgrading from v0.7.x:

### 3.1 `~/.cfcf/projects/<id>/config.json`

Shape today:
```json
{
  "id": "calc-5dbcfa",
  "name": "calc",
  "repoPath": "/tmp/cfcf-calc",
  "devAgent": { "adapter": "codex" },
  // ... rest
}
```

Proposed new shape:
```json
{
  "id": "calc-5dbcfa",
  "name": "calc",
  "repoPath": "/tmp/cfcf-calc",
  // NEW: "project": "cf-ecosystem" // Clio Project assignment, optional -- see design doc §12.1
  // all existing fields unchanged
}
```

**The rename affects code (`ProjectConfig` → `WorkspaceConfig`) but the JSON schema barely changes.** Only additions. No read-tolerance needed for the rename itself — field names on disk never had `project*` prefixes (except the root key names, which keep their shape). Safe.

### 3.2 `~/.cfcf/projects/<id>/loop-state.json`

Shape today contains `projectId`, `projectName`, `currentIteration`, `phase`, `iterations[]`, etc.

**Proposal:** start writing `workspaceId`, `workspaceName`; on read, accept both:
```ts
const workspaceId = raw.workspaceId ?? raw.projectId;
const workspaceName = raw.workspaceName ?? raw.projectName;
```
Document the deprecated keys in the read function's JSDoc. Drop the fallback in v0.9.0.

### 3.3 `~/.cfcf/projects/<id>/history.json`

Same treatment. Each event type has `projectId`-ish fields today — rename the schema, tolerate old on read.

### 3.4 Notification log (`~/.cfcf/logs/<id>/notifications.log`, JSON Lines)

Schema change in `NotificationEvent.project.{id,name}` → `NotificationEvent.workspace.{id,name}`. Existing log entries are historical and unlikely to be re-read programmatically; leave old format; start writing new. If a user later wants to parse their history, they'll see mixed shapes — document.

---

## 4. Phased PR plan

### PR 1 (this branch) — **the big rename** (one commit or a small handful)

Scope: everything in §2.1 through §2.8 in one atomic change. Yes, it's big, but splitting it creates an inconsistent codebase state. Tests pass on every intermediate commit if possible; if not, the final commit is a single atomic rename.

- Types (core + web): `WorkspaceConfig`/`WorkspaceStatus` + deprecated aliases.
- Core exports (`projects.ts` etc.): new names + deprecated re-exports.
- Server routes: add `/api/workspaces/*` handlers; keep `/api/projects/*` as wrapper-routes that call the same handlers; console.warn on the old path.
- CLI: `cfcf workspace` subcommand; `cfcf project` as hidden alias with stderr deprecation warning.
- Flag renames: `--workspace` added everywhere; `--project` kept, handler reads `opts.workspace || opts.project` with a warn when only the old one is present.
- Web: file renames, component renames, route hash handling, label updates.
- Templates: prompt language updates (careful — see §2.7 note about keeping "project" where it means "the user's codebase").
- Persisted-state read-tolerance (§3.2, 3.3).
- Tests: update everywhere; add a few tests that specifically exercise the alias paths (`GET /api/projects/:id` returns same as `GET /api/workspaces/:id`; `cfcf project list` dispatches to `cfcf workspace list`).
- Docs: every user-facing doc. CHANGELOG `[0.8.0]` entry.

**Target test count after PR 1:** 309 → ~320 (added alias tests; no feature tests removed).

**Smoke-test plan:**
1. `cfcf workspace init --repo <path> --name foo` → succeeds, writes config.
2. `cfcf project init --repo <path> --name bar` → emits deprecation warning, succeeds (same output).
3. `cfcf workspace list` / `cfcf project list` → both work, same output.
4. Existing projects created by v0.7.x load without error via the persisted-state read tolerance.
5. Web UI: top-bar link says "Workspaces"; `#/` dashboard loads; `#/projects/<id>` URL redirects to `#/workspaces/<id>`; `#/workspaces/<id>` works.
6. `curl localhost:7233/api/projects` still returns the list (alias works). `curl localhost:7233/api/workspaces` also works.

### PR 2 (follow-up, possibly v0.8.1) — **cleanup + dogfood**

If PR 1 surfaces gaps during smoke-testing, fix them here. Otherwise PR 2 is purely:
- Add deprecation-warning frequency control (warn only once per CLI session, not on every subcommand).
- Add a compatibility-check test pass that exercises every alias endpoint + old flag name end-to-end.
- Update any external scripts/examples we ship to use the new names.

### PR 3 (v0.9.0, later iteration) — **drop aliases**

- Remove `cfcf project *` CLI command tree.
- Remove `/api/projects/*` route aliases.
- Remove deprecated type aliases in core + web.
- Remove persisted-state read fallbacks (`raw.projectId ?? raw.workspaceId`).
- Remove `#/projects/:id` hash redirect.

Only ships after at least one release cycle of the alias window, and after confirming no known users are still on the old terminology via an ad-hoc check.

---

## 5. Per-session execution order (for next session)

Executing the PR 1 rename in a single session, this is the suggested sequence. Each step is self-contained (typecheck passes at each step if done in order).

1. **Types first** — `packages/core/src/types.ts` + `packages/web/src/types.ts`. Add new names + deprecated aliases. Nothing imports yet, so nothing breaks.
2. **Core exports** — `projects.ts`. Rename functions + add aliases.
3. **Core consumers** — update `iteration-loop.ts` + 4 runners + `context-assembler.ts` + `log-storage.ts` + `active-processes.ts` + `project-history.ts` (+ rename `project-history.ts` → `workspace-history.ts`). Each file flips to the new names; typecheck after each.
4. **Core tests** — update all tests to use the new names (aliased imports still work, so you can do this gradually or in one pass).
5. **Server routes** — `packages/server/src/app.ts`. Add new handlers + alias registrations. Update `iteration-runner.ts`.
6. **Server tests** — update `app.test.ts` with both-path exercises.
7. **CLI** — rename `commands/project.ts` → `commands/workspace.ts` + register both. Update all `--project` → `--workspace` flags + alias handling.
8. **CLI top-level** — `packages/cli/src/index.ts` + `init.ts` help text.
9. **Web types + API client** — `packages/web/src/types.ts` + `api.ts`.
10. **Web routing** — `App.tsx` + `useRoute.ts` (add the redirect).
11. **Web components** — Rename files (`ProjectCard.tsx` → `WorkspaceCard.tsx`, `ProjectDetail.tsx` → `WorkspaceDetail.tsx`, `ProjectHistory.tsx` → `WorkspaceHistory.tsx`), update imports, update internal component prop names (`project` → `workspace`).
12. **Web pages + labels** — `Dashboard.tsx`, `ServerInfo.tsx`, `Header.tsx`, `ConfigDisplay.tsx`. Copy-edit visible labels.
13. **Templates** — 8 files. Careful pass per §2.7 — only rename where "project" means cf²'s managed-repo concept.
14. **Build + test cycle** — `bun run typecheck`, `bun run test`, `bun run build`. Fix any missed references.
15. **Docs** — 13 doc files. Focus on `workflow.md`, `cli-usage.md`, `server-api.md`, `README.md`, `CLAUDE.md`. Add deprecation notes where appropriate.
16. **CHANGELOG** — new `[0.8.0]` entry covering the rename + alias horizon + design-doc link.
17. **Plan.md** — flip 5.10 ❌ → ✅. Add decision-log entry. Update 5.7's prerequisite-satisfied note.
18. **Version bump** — 0.7.6 → 0.8.0 everywhere (package.json × 5, constants.ts, constants.test.ts, app.test.ts).
19. **Binary build + smoke-test** — per §4 PR 1 list.
20. **Commit + push + PR.** Title: `feat(5.10): rename cf² project → workspace (v0.8.0 breaking change)`.

**Estimated effort in a fresh session:** 4-6 hours of focused work. Mechanical but dense. Worth having this checklist to track progress as each section completes.

---

## 6. Risks + mitigations

| Risk | Mitigation |
|---|---|
| Miss a reference, end up with mixed "project"/"workspace" in user-facing output | Final grep pass before commit: `grep -rn "project" packages/ docs/` → review every hit against this doc's "rename vs keep" rules. |
| Break existing user's persisted state | §3 read-tolerance + a manual test against an actual v0.7.x-created `~/.cfcf/projects/<id>/` directory before the commit lands. |
| Break external scripts/CI that call the API or CLI | Alias window + explicit deprecation message with upgrade path in the warning text. |
| Template prompt changes alter agent behaviour unexpectedly | Templates are the most nuanced part. Post-rename: run a single iteration on the calc test workspace to confirm the dev agent still behaves correctly. |
| Web UI has a stale reference and shows "Project" in one place, "Workspace" in another | Manual UI walkthrough pre-commit: visit every page, every modal, every form section. |
| Bundle size grows from alias-shim code | Negligible (~1 KB); non-issue. |
| Tests flake because both old + new paths run | Keep alias tests minimal and explicit; don't duplicate every feature test. |

---

## 7. Open sub-decisions for the implementing session

1. **Deprecation warning verbosity.** Print once per CLI invocation or every time? I'd say once per invocation; use a module-level flag.
2. **Should `projects.ts` itself be renamed?** Matching question for `commands/project.ts`. My preference: rename `commands/project.ts` → `commands/workspace.ts` (CLI-facing file; user greps for it); keep `packages/core/src/projects.ts` as-is (internal import path; touching it bloats the diff).
3. **Should the on-disk directory be renamed?** No (per §1). Flag in case the implementer has a better argument.
4. **Translate to "workspace" in existing user-authored files (like the calc problem.md)?** No. Those are the user's content.
5. **Naming in SQL — `clio_projects` stays** as-is (Clio is deliberately Cerefox-aligned). Confirm.

---

## 8. Changelog

- **2026-04-21**: Created this execution plan on a fresh branch as a pre-survey for plan item 5.10. No code changes yet. Next session: execute §5 in order.
