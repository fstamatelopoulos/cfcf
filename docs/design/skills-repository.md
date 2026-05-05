# Skills repository + workspace-scoped activation — design (item 6.27)

**Status:** design draft (2026-05-03). Plan-item row: [`docs/plan.md`](../plan.md) row 6.27. Not scheduled into a release yet.

This document captures the design for cf²'s skills subsystem: a way for the per-role agents (Product Architect, Solution Architect, dev, judge, reflection, documenter) to draw on curated, file-based expertise modules during their turns. It locks the format-compatibility commitment with Anthropic's official Claude skill specification, the workspace-scoped activation model, and the role-routing logic — and enumerates the open questions that need a decision before implementation starts.

## Goals

1. **Domain expertise as composable, file-based units.** Add a "skills" extension point so a skill like *"WCAG 2.2 AA accessibility compliance"* or *"REST API design conventions"* can be authored once + reused across workspaces + reused across the multiple agent roles that benefit from it. No code, no plumbing per skill — drop in a folder, declare its applicability, done.
2. **Strict superset of Anthropic's Claude skill format.** A skill written for vanilla Claude (Claude Code, the API, anywhere skills are supported) loads in cf² unmodified. A skill authored for cf² remains a valid Claude skill and works outside cf². cf²-specific behaviour rides as optional YAML frontmatter fields the official spec ignores.
3. **Deterministic, user-controlled activation.** Skills activate per workspace based on user selection — not per-conversation based on model-side relevance scoring. cf² is a deterministic harness; what's in a role's prompt should be a function of workspace config, not of mid-loop model decisions. (Same principle that drives 6.25's structured pause actions: the harness's behaviour is the user's responsibility, not the agent's.)
4. **Self-routing skills.** A skill's frontmatter declares which roles it applies to. Workspace-level selection is therefore one knob ("which skills are active for this workspace?"); cf² automatically splices each active skill into the right roles' prompts at turn-time. Users don't manually wire skill-to-role assignments.
5. **Validate the loop end-to-end.** Ship 3 reference skills bundled with the cfcf install so the system is testable + dogfoodable from day one rather than being plumbing-without-content.

## Non-goals (this iteration)

- **Model-driven skill activation** ("Claude decides which skills to load this turn"). The official Claude skill spec works this way; cf² deliberately doesn't. Future iterations could add it as an opt-in alongside user-curated activation, but it's out of scope for 6.27.
- **Skill marketplace / remote registry / install-from-URL.** Skills are loaded from disk locations cf² knows about (bundled, user-global, in-repo); installing a third-party skill is a `git clone` or a file copy. A package-style `cfcf skills install <url>` verb is a follow-up if demand emerges.
- **Skill authoring tooling.** No web editor for skills, no `cfcf skills create` scaffolder. Authors edit markdown files directly. (Possible follow-up if dogfooding reveals friction.)
- **Conditional / templated skills.** Skill content is static markdown. No "if workspace.language == TypeScript then …" templating. If a skill needs to differentiate, author multiple skills.
- **Skill composition / inheritance.** No `extends:` field, no skill-imports-other-skill mechanism. Each skill is self-contained. If multiple skills overlap, that's the user's call to manage at activation time.
- **Per-iteration skill activation.** Skills are activated for the workspace, not for "iteration 5 only". A workspace's active skill set is a property of the workspace, not of any single run.
- **Auto-detection of skill applicability.** ("This is a Python project, auto-activate the Python skills.") The user picks. Auto-suggestions could be a follow-up; auto-application would erode the deterministic-activation principle.

## Conceptual model

Three concepts with one-to-many relationships:

```
Skill (file-based bundle on disk)
  ├─ has: 1 SKILL.md (frontmatter + body)
  ├─ has: N supporting files (referenced from SKILL.md)
  └─ declares: which agent roles it applies to (frontmatter)

Workspace (cf² unit of work)
  └─ has: 0..N "active skills" — a list of skill identifiers the user has enabled for this workspace

Role-prompt assembly (per-turn, per-role)
  └─ for each role's prompt, splice in: { active workspace skills } ∩ { skills declaring that role }
```

The skill is the unit of authorship. The workspace is the unit of activation. The role-prompt is where it lands. Skills self-route to roles; the user only manages the workspace level.

## Skill format

### Folder layout

A skill is a folder. The folder name is the skill identifier (no spaces, kebab-case by convention).

```
my-skill-name/
  SKILL.md               (required — frontmatter + body)
  examples/              (optional — referenced from SKILL.md as needed)
    good-example.md
    bad-example.md
  reference/             (optional)
    spec.pdf
    cheatsheet.md
  checklist.md           (optional)
```

Only `SKILL.md` is mandatory. Supporting files are referenced from the SKILL.md body via relative paths (e.g. `see examples/good-example.md`). The agent reads supporting files on demand the same way it reads any other file in its working tree.

### `SKILL.md` structure

YAML frontmatter followed by markdown body. Compatible with Anthropic's official Claude skill spec:

```yaml
---
# Anthropic-spec fields (vanilla Claude reads these; cf² also reads them)
name: accessibility-compliance
description: WCAG 2.2 AA compliance guidelines for web applications
version: 1.0.0

# cf²-specific extensions (vanilla Claude ignores these; cf² uses them)
cfcf:
  applicable_roles:
    - product-architect
    - solution-architect
    - dev
    - judge
    - reflection
  scope: workspace        # always "workspace" in 6.27; reserved for future scopes (project / global)
  priority: high          # ordering hint when multiple skills target the same role
---

# Accessibility Compliance — WCAG 2.2 AA

This skill provides guidelines + checklists for building web applications that
meet WCAG 2.2 AA conformance.

…body content…
```

**Frontmatter rules:**

- `name`, `description` are **required** (Anthropic-spec).
- `version` is **recommended** (Anthropic-spec) — semver-shaped string. Used for the skill-versioning workflow (open question Q4 below).
- The `cfcf:` namespace is **optional**. A skill with no `cfcf:` block applies to all roles by default + has `priority: medium`.
- Unknown keys under `cfcf:` are ignored (forward-compat).
- Unknown top-level keys are preserved unmodified (so an Anthropic-future field doesn't get stripped if the skill round-trips through cf² tooling).

**Why nest under `cfcf:` instead of `cf2_*` flat keys:** the nested form keeps the cf²-specific surface contained in one block that's easy to spot, easy to ignore, and easy to extend without polluting the top-level frontmatter namespace. Also matches how `package.json` extends with vendor-specific blocks (`{"name": "...", "scripts": {...}, "cfcf": {...}}`).

### `applicable_roles` enumeration

Valid values match the role identifiers used elsewhere in cf² (see `packages/core/src/clio/actor.ts` `ROLE_*` constants):

- `product-architect`
- `solution-architect` (alias: `architect`)
- `dev`
- `judge`
- `reflection`
- `documenter`

A skill that omits `applicable_roles` defaults to **all roles**. A skill with an empty list (`applicable_roles: []`) is a config error and the loader rejects it. Unknown role names in the list emit a warning at load-time and are ignored (forward-compat with future role names).

`help-assistant` is intentionally **excluded** from applicable_roles in 6.27 — HA is purely interactive Q&A about cfcf itself, not a domain-expertise consumer. If HA evolves to do domain work, revisit.

## Skill location + discovery

Three layers, evaluated in this order:

1. **Bundled with the cfcf install** at `<install>/skills/`. Ships with cfcf releases. Includes the 3 reference skills (Accessibility Compliance, REST API Design, Test-Driven Development). Read-only — users don't edit these directly (would be overwritten by `cfcf self-update`).
2. **User-global** at `~/.cfcf/skills/`. User-managed. A user-global skill with the same `name` as a bundled skill **overrides** the bundled one (so users can swap a bundled "REST API Design" for their own house variant).
3. **In-repo** at `<workspace.repoPath>/cfcf-docs/skills/`. Workspace-local. Lives in the repo, ships with the project's git history, useful for "this project's specific style guide" type skills. An in-repo skill with the same `name` as a user-global or bundled one **overrides** higher-priority layers for this workspace only.

Loader walks all three layers, applies the override-by-name rules, returns a flat catalogue. The CLI verb `cfcf skills list` shows where each visible skill came from (`bundled` / `user` / `in-repo`).

This mirrors the seed-models pattern (item 6.26: bundled seed + user override) and the system-projects pattern (item 6.18 round-3: bundled defaults + user-extensible).

**Anthropic-spec compatibility note:** the official Claude skill spec assumes per-project skills in a discoverable location. cf²'s `cfcf-docs/skills/` matches that expectation, so a user who's authored skills against the official spec finds them in the natural place. The bundled + user-global layers are cf² extensions but they hold standard-format skills; nothing about a bundled skill prevents it from being copied into a non-cf² project.

## Workspace activation surface

Per-workspace config field:

```ts
// in WorkspaceConfig (packages/core/src/types.ts)
interface WorkspaceConfig {
  // ...existing fields...
  activeSkills?: string[];  // skill names (matches SKILL.md frontmatter `name`)
}
```

Defaults to `[]` (no skills active). Skill names — not paths or ids — so the layer-resolution logic can swap a bundled skill for a user-global override without breaking the workspace's pinned config.

### CLI

```bash
cfcf skills list                                # global catalogue (bundled + user-global)
cfcf skills show <name>                         # render a skill's SKILL.md + supporting-file list
cfcf workspace skills list <workspace>          # active skills for a workspace
cfcf workspace skills add <workspace> <name>    # activate a skill
cfcf workspace skills remove <workspace> <name> # deactivate
```

`cfcf workspace skills add` validates that `<name>` exists in the catalogue + emits a list of "this skill targets these roles" so the user sees the routing impact at activation time.

### Web UI

Workspace Config tab gains a **Skills** section:

- A list of all available skills (bundled + user-global + in-repo for this workspace), each row showing: name, description, applicable roles (chips), source layer badge (`bundled` / `user` / `in-repo`), an active-toggle.
- An "Add custom skill" button that opens the user-global skill folder in the OS file browser (a primitive scaffolding affordance — actual authoring happens in the user's editor of choice).
- A search/filter box for when the catalogue grows large.

Mirrors the per-role agent-config pattern that already exists on Workspace Config — same column conventions, same toggle + chip UI.

## Role-routing + prompt assembly

At role-prompt assembly time (each role's existing assembler in `packages/core/src/{product-architect,help-assistant,architect,dev,judge,reflection,documenter}/`):

```ts
function activeSkillsForRole(workspace: WorkspaceConfig, role: AgentRole): Skill[] {
  const active = workspace.activeSkills ?? [];
  return active
    .map(name => skillCatalogue.lookup(name))     // null if missing (warn + skip)
    .filter(s => s && s.applicableRoles.includes(role))
    .sort((a, b) => priorityOrder(a) - priorityOrder(b));
}
```

The returned skills are spliced into the role's prompt as a new `## Active skills` section, after the role's primary instructions but before any task-specific context (problem pack / iteration history / etc.). Each skill renders as:

```markdown
### Skill: <name>

<full SKILL.md body, frontmatter stripped>
```

**Supporting files** are NOT inlined into the prompt (would balloon size). The agent has read access to the skill folder + the SKILL.md body references files by relative path; the agent reads them on demand the same way it reads any project file.

**Order:** skills with explicit `priority: high` first, then `medium` (default), then `low`, with a stable secondary sort by name. Within a priority tier, declared order in `workspace.activeSkills` is the tiebreaker. (Authors should not rely on subtle priority dynamics; explicit priority is for "this skill should be top of mind" cases like compliance rules.)

**Conflict policy:** when two skills target the same role and contain contradictory guidance, no special handling — both render in the prompt, in priority order, and the agent reads them sequentially. Agents are expected to handle apparent contradictions the way humans would: read both, prefer the more specific or the higher-priority one, ask the user if genuinely irreconcilable. Mechanically resolving contradictions in code would require parsing skill content semantically, which is out of scope.

### Prompt-budget management

Skills inflate role prompts. Soft budget guards:

- Per-skill warning if SKILL.md body exceeds **8 KB** (rough guideline; large skills should split into a brief SKILL.md + supporting files).
- Per-role warning if total active-skill-content for a single role exceeds **40 KB** (out of a typical ~200 KB system-prompt budget for interactive roles — leaves room for primary instructions + state injection + memory inventory).
- Hard cap: per-role active-skill-content > **80 KB** triggers a load-time error. The user must deactivate skills or split them.
- Disclosure path: when the soft cap fires, the role's prompt includes a `> Note: <N> active skills (~<X> KB) in this role's prompt.` header so the user (reviewing logs) knows what's there. When the hard cap fires, `cfcf workspace skills add` refuses + prints the budget breakdown.

Numbers are heuristics; revisit after dogfooding 3+ workspaces with active skills.

## Cerefox-parity question: should skills also live in Clio?

**Open question, not yet decided.** Both options have merit:

**Option A — disk only.** Skills live as files on disk, loader reads them on demand. Pure file-based, no Clio dependency, full Anthropic-spec compatibility (a skill folder is a skill folder is a skill folder).

**Option B — also ingest into Clio.** A bootstrap pass at server start ingests every skill into Clio under a system project (`cf-system-skills`) with `metadata.artifact_type: "skill"`. The role-prompt assembler can now pick from {active workspace skills on disk} ∪ {Clio search hits in `cf-system-skills` filtered by relevance to the current task}. Cross-workspace discovery: an agent in workspace X searching for "auth pattern" finds skills the user wrote for workspace Y.

**Option C (recommended) — disk as source of truth, optional Clio mirror for discovery only.** Skills always load from disk for prompt assembly (preserves Anthropic-spec compatibility + makes the skill bundle self-contained). A separate, opt-in path mirrors skill catalogues into Clio for browsing / search ("what skills exist across all my projects?"). The mirror is read-only — users still author skills as files — and the prompt-assembly path never reads from Clio. This separates the two concerns: (a) deterministic prompt assembly = disk; (b) cross-workspace discovery = Clio.

Option C lets us add the Clio integration later without changing the prompt-assembly path. Worth deciding before implementation, but Option C has the lowest commitment cost so it's the suggested default until dogfooding surfaces a reason to revisit.

## Skill versioning

A skill ships v1.0.0. Six months later cfcf releases ship a v2.0.0 of the same bundled skill (better content, expanded examples, broader role coverage). What happens to existing workspaces that had the skill activated?

Three options:

1. **Always-latest.** Workspace pins the skill `name`; the catalogue resolves to whatever version is currently on disk. Auto-upgrade on cfcf upgrade. Simple. Risk: a v2 skill that subtly changes guidance silently changes agent behaviour in a workspace that was working fine.
2. **Pin-by-default.** Workspace pins the `name@version`. Old version stays in effect until the user explicitly runs `cfcf workspace skills upgrade <skill-name>`. Predictable. Cost: requires keeping the old skill version on disk somewhere (a `<skill-name>/.versions/<version>/` subdirectory, mirroring `cfcf-docs/iteration-logs/` conventions), and the upgrade verb to manage it.
3. **Pin-with-prompt.** Workspace pins `name`. On `cfcf upgrade`, if any active workspace's skill version changed, surface a one-line notice: "Skill 'rest-api-design' upgraded from 1.0.0 to 2.0.0; review with `cfcf workspace skills diff …`". User-driven decision per upgrade.

**Recommended:** Option 1 (always-latest) for the 6.27 ship, with the caveat documented + a `version` field captured in `WorkspaceConfig.activeSkills` entries so future iterations can flip to Option 2 or 3 without a config migration. Option 1 is consistent with how cfcf treats its own bundled templates today (always-latest, regenerated each iteration via the sentinel-merge pattern). Authors of v2 skills are expected to maintain backward-compatible guidance the way npm-package authors do for minor bumps.

## Open design questions to resolve before implementation

| # | Question | Suggested default | Decision required by |
|---|---|---|---|
| Q1 | **Frontmatter namespace shape**: `cfcf: { applicable_roles, … }` nested vs `cfcf_roles:` flat keys vs `x-cfcf-*` X-prefix style. | Nested under `cfcf:`. Mirrors how `package.json` extends with vendor blocks; easy to spot + ignore. | Before format is locked. |
| Q2 | **Default `applicable_roles` when omitted**: all roles, or none, or warn + none. | All roles. Vanilla Claude skills (no `cfcf:` block at all) should "just work" everywhere by default; users opt into narrowing. | Before format is locked. |
| Q3 | **Priority semantics**: numeric weights vs `high`/`medium`/`low` enum vs ordered-list-position only. | `high`/`medium`/`low` enum + declared-order tiebreaker. Numeric weights invite micro-tuning that doesn't survive review. | Before role-routing ships. |
| Q4 | **Skill versioning model**: always-latest vs pin-by-default vs pin-with-prompt (see "Skill versioning" above). | Always-latest for 6.27, with `version` captured in `WorkspaceConfig` for forward compat. | Before workspace activeSkills schema is locked. |
| Q5 | **Clio integration**: disk only, also-Clio, or disk + optional Clio mirror (see "Cerefox-parity question" above). | Option C: disk as source of truth, optional Clio mirror for discovery only. | Before implementation, since it changes the loader interface. |
| Q6 | **In-repo skill location**: `cfcf-docs/skills/` (under cfcf's namespace) vs `.claude/skills/` (Anthropic's convention) vs both with priority. | `cfcf-docs/skills/` as primary (matches every other in-repo cfcf artifact), with optional fallback to `.claude/skills/` if Anthropic's convention solidifies. | Before in-repo loader path is wired. |
| Q7 | **Role aliases**: `solution-architect` vs `architect` (current cfcf code uses both). Pick one canonical form for `applicable_roles`. | `architect` (matches `ROLE_ARCHITECT` constant in `actor.ts`). Accept `solution-architect` as a deprecated alias with a load-time warning. | Before any reference skill is authored. |
| Q8 | **Reference-skill scope**: ship 3 (Accessibility Compliance, REST API Design, TDD) or fewer / more / different ones. | Ship the 3 proposed ones — each exercises a different role-mix (Accessibility hits everyone, REST API design is mostly architect + dev, TDD is mostly dev + judge). Validates the role-routing logic end-to-end. | Before reference-skill authoring starts. |

## Reference skills (proposed for the 6.27 bundle)

### Accessibility Compliance

- **Targets:** product-architect, architect, dev, judge, reflection.
- **Why each role benefits:** PA gathers accessibility requirements during spec; architect designs the page-structure / component-tree to support them; dev implements with semantic HTML + ARIA + keyboard support; judge verifies against WCAG criteria; reflection catches systemic regressions.
- **Body sketch:** WCAG 2.2 AA conformance criteria, common pitfalls (missing alt text, low contrast, focus traps, aria-misuse), quick-check heuristics + automated-tooling pointers (axe-core, Lighthouse), a one-page checklist.

### REST API Design

- **Targets:** product-architect, architect, dev, judge.
- **Why each role benefits:** PA shapes the API surface in problem.md; architect designs the resource model + auth boundaries; dev implements endpoints + writes API tests; judge evaluates fitness against REST conventions + the workspace's own API style guide if any.
- **Body sketch:** resource naming, HTTP-method semantics (idempotency, safety), status-code conventions, pagination + filtering patterns, versioning strategies, error-response shapes, hypertext considerations (if used).

### Test-Driven Development

- **Targets:** dev, judge.
- **Why each role benefits:** dev follows the red-green-refactor cycle when the workspace is TDD-shop; judge evaluates "did the dev write the test first?" by checking commit ordering + test/source diff overlap.
- **Body sketch:** the cycle (write failing test → minimal code → refactor), test-pyramid balance, naming conventions (Given/When/Then or Arrange/Act/Assert), how to handle legacy code without tests, the "transformation priority premise" rule of thumb.

These are intentionally generic + cross-language. Workspace-specific or language-specific skills (`Python style guide for ACME Corp`, `our internal microservice patterns`) live in user-global or in-repo layers, not in the bundled set.

## Implementation sketch

**Phase 1 — loader + format.**

- `packages/core/src/skills/types.ts` — `Skill`, `SkillFrontmatter`, `SkillCatalogue` types.
- `packages/core/src/skills/loader.ts` — read all three layers, parse frontmatter (re-use `js-yaml` if not already a dep, else a tiny in-house parser since frontmatter is well-bounded), validate, return catalogue.
- `packages/core/src/skills/catalogue.ts` — singleton-style accessor (matches how `system-projects.ts` is accessed) with refresh-on-demand.
- Tests: positive frontmatter parsing, negative (malformed YAML, missing `name`, empty `applicable_roles`), override-by-name across layers, supporting-file resolution.

**Phase 2 — workspace activation surface.**

- `WorkspaceConfig.activeSkills?: string[]` field + validation.
- CLI: `cfcf skills {list,show}` + `cfcf workspace skills {list,add,remove}`.
- Server route: `GET /api/skills` + `GET/PUT /api/workspaces/:id/skills`.
- Web: Skills section on Workspace Config tab; reuses existing `<select>` + chip patterns from agent-roles.

**Phase 3 — role-routing + prompt splice.**

- `packages/core/src/skills/route.ts` — `activeSkillsForRole(workspace, role): Skill[]`.
- Each role's prompt-assembler imports the helper + splices the rendered `## Active skills` block into the prompt at the right point. Touch every role assembler in `packages/core/src/{product-architect,help-assistant,architect,dev,judge,reflection,documenter}/` (HA gets a no-op since `help-assistant` isn't in the role enum).
- Budget guards (warnings + hard cap).
- Tests: role-routing filter (skill targeting `dev` lands in dev's prompt only), priority sort, budget-warning trigger, hard-cap rejection.

**Phase 4 — reference skills + end-to-end validation.**

- Author the 3 reference skills under `packages/core/src/skills/bundled/`.
- Bundle them into the cfcf release tarball (extend `scripts/build-cli.sh` to copy the dir into `dist/`).
- End-to-end smoke: spin up a workspace, activate one reference skill per role, run an iteration, verify each role's captured prompt contains the expected skill content.
- Docs: add a `docs/guides/skills.md` user-facing guide; cross-link from the user manual.

**Effort estimate (rough):** Phase 1 ~half-session; Phase 2 ~half-session; Phase 3 ~one session (touches every role assembler); Phase 4 ~half-session for the reference skills + smoke + docs. Total: 2–3 sessions.

## Cross-references

- Plan-item row: [`docs/plan.md`](../plan.md) row 6.27.
- Anthropic Claude skill specification (external): the format-compatibility commitment tracks the official spec; check the Anthropic docs for the current authoritative version when implementing the loader.
- Item 6.18 round-3 (system-managed Clio Projects): the `cf-system-*` naming convention + bundled-defaults + user-extensible pattern that the skills location-layer model mirrors. See [`docs/decisions-log.md`](../decisions-log.md) (2026-05-03 entry "System-managed Clio Projects").
- Item 6.18 round-3 (Clio actor convention): the `<role>|<agent>|<model>` stamp uses the same role enum that `applicable_roles` validates against. See `packages/core/src/clio/actor.ts` `ROLE_*` constants.
- Item 6.25 (structured pause actions): the deterministic-flow-control principle that justifies "user picks skills, not the model" — same lens, applied to a different surface.
- Item 6.26 (per-role model registry): the bundled-seed + user-override pattern that the skills location-layer model mirrors.
