# CLI verb normalisation — research + proposal

**Status**: Draft, awaiting user sign-off (2026-04-27).
**Plan item**: 5.8.
**Branch**: `iteration-5/cli-verb-normalisation`.

## 1. Why

The cfcf CLI accreted Clio verbs across three iterations (5.7 → 5.11 → 5.12 → 5.13). Each iteration added what was needed without revisiting the overall shape. The result is a surface that mixes:

- Top-level verbs (`clio search`, `clio ingest`, `clio get`, `clio versions`, `clio delete`, `clio restore`, `clio audit`, `clio reindex`, `clio stats`)
- Hyphenated multi-word verbs (`clio metadata-search`, `clio metadata-keys`)
- Namespaces (`clio docs list`, `clio docs edit`)
- Singular-noun namespaces (`clio project show`, `clio embedder set`)
- Aliased plural namespaces (`clio projects` ≡ `clio project`)

Two recurring dogfood pains motivated this work:

1. The "where do I rename a doc?" question (motivated `docs edit` in 0.11.0).
2. The "where's the CLI command to move a doc to another project?" question (answer: under `docs edit`, but only because we just added it).

Both are symptoms of the same root cause: **operations on the same noun live in different places**. `docs list` + `docs edit` are under `docs`; `get`, `delete`, `restore`, `versions` are top-level. Future readers (and agents) have to memorise the surface rather than infer it.

## 2. What we want

User-stated requirements (2026-04-27):

1. **Cerefox parity at the abstraction layer.** Every CLI verb must map cleanly to a `MemoryBackend` method, and every Cerefox MCP tool must have a matching cfcf verb (or be intentionally absent). The CLI surface itself doesn't need to be byte-identical to Cerefox's CLI — what matters is the abstraction.
2. **Predictable structure.** One rule, applied consistently, so agents and humans can guess the verb instead of reading docs.
3. **Wordier is OK.** `--help` is always available; the CLI doesn't need to be optimised for keystrokes.
4. **No deprecation period.** Replace cleanly. Single user (project owner) right now.
5. **Scope = Clio only this round.** Other top-level cfcf verbs (`run`, `review`, `reflect`, `document`, `workspace`, etc.) stay as-is. Iteration 6 will revisit them with the same lens.

## 3. Cerefox audit

### 3.1 Cerefox MCP tool surface (8 tools)

Source: `../cerefox/src/cerefox/mcp_server.py`.

| MCP tool | Purpose |
|---|---|
| `cerefox_search` | Search (FTS / semantic / hybrid) |
| `cerefox_ingest` | Create / update document |
| `cerefox_get_document` | Reconstruct full content (live or version_id) |
| `cerefox_list_versions` | List archived versions for a doc |
| `cerefox_list_projects` | List projects |
| `cerefox_list_metadata_keys` | Discover metadata keys + sample values |
| `cerefox_metadata_search` | Filter docs by metadata |
| `cerefox_get_audit_log` | Query audit log |

Pattern: `cerefox_<verb>_<noun?>` with no hierarchy. Tools that operate on a doc say `_document`; the others elide the object.

**Notably absent from MCP**: delete, restore, edit-metadata, ingest-dir, reindex, projects-create. These exist in Cerefox's HTTP/CLI layer but aren't exposed as agent tools. cfcf-Clio takes a wider stance — agents in cf² loops can soft-delete + restore + edit metadata via CLI.

### 3.2 Cerefox CLI surface

Source: `../cerefox/src/cerefox/cli.py`.

| CLI verb | Pattern |
|---|---|
| `cerefox ingest` | single verb |
| `cerefox ingest-dir` | hyphen |
| `cerefox search` | single verb |
| `cerefox list-docs` | hyphen, verb-noun, plural |
| `cerefox list-projects` | hyphen, verb-noun, plural |
| `cerefox list-versions` | hyphen, verb-noun, plural |
| `cerefox list-metadata-keys` | hyphen, verb-noun-noun, plural |
| `cerefox get-doc` | hyphen, verb-noun, **singular** |
| `cerefox delete-doc` | hyphen, verb-noun, **singular** |
| `cerefox metadata-search` | hyphen, **noun-verb** |
| `cerefox config-get` | hyphen, **noun-verb** |
| `cerefox config-set` | hyphen, **noun-verb** |
| `cerefox reindex` | single verb |
| `cerefox web` | single verb |
| `cerefox mcp` | single verb |

**Inconsistencies inside Cerefox itself**:
- Singular vs plural splits by intent (list-docs plural; delete-doc singular). Defensible, but two rules.
- Verb-noun (`list-docs`) vs noun-verb (`metadata-search`, `config-get`, `config-set`). Pure inconsistency.
- No `update-doc`, `delete-version`, `restore-doc` — Cerefox CLI doesn't expose those operations at all.

**Implication**: Literal Cerefox CLI parity is not desirable. We can do better at the abstraction layer — every Cerefox MCP tool maps to a cfcf verb, but the cfcf surface itself can have a cleaner structure.

## 4. Proposal — Option γ (namespaced verbs)

> **Note**: This supersedes the earlier "Option C" sketched in the conversation. Option C was a literal Cerefox-CLI rename, but the Cerefox audit above shows Cerefox CLI itself isn't a good target. Option γ keeps the parity goal at the **abstraction layer** while giving cfcf a cleaner surface.

### 4.1 The rule

> **Plural-noun namespace + verb subcommand for any noun with multiple operations. Single-noun verbs stay top-level.**

That's it. Two rules collapse into one when you treat "single verb under `clio`" and "namespace.verb under `clio`" as the same shape — the namespace defaults to the most common operation when invoked alone.

### 4.2 Final cfcf Clio surface

```
cfcf clio search <query…>                  # top-level, no noun ambiguity
cfcf clio ingest [file]                    # top-level
cfcf clio reindex                          # top-level
cfcf clio stats                            # top-level
cfcf clio audit                            # top-level (kept here per user; see §5)

cfcf clio docs                             # default action: list (alias)
cfcf clio docs list                        # was: clio docs list ✓
cfcf clio docs get <id>                    # was: clio get <id>
cfcf clio docs edit <id>                   # was: clio docs edit ✓
cfcf clio docs delete <id>                 # was: clio delete <id>
cfcf clio docs restore <id>                # was: clio restore <id>
cfcf clio docs versions <id>               # was: clio versions <id>

cfcf clio metadata search                  # was: clio metadata-search
cfcf clio metadata keys                    # was: clio metadata-keys

cfcf clio projects                         # default: list (existing alias kept)
cfcf clio projects list                    # existing
cfcf clio projects create <name>           # was: clio project create
cfcf clio projects show <nameOrId>         # was: clio project show

cfcf clio embedder list                    # singular kept (one active embedder)
cfcf clio embedder active
cfcf clio embedder install [name]
cfcf clio embedder set <name>
```

### 4.3 What changes

| From | To | Reason |
|---|---|---|
| `clio get <id>` | `clio docs get <id>` | doc operation; lives with siblings |
| `clio versions <id>` | `clio docs versions <id>` | same |
| `clio delete <id>` | `clio docs delete <id>` | same |
| `clio restore <id>` | `clio docs restore <id>` | same |
| `clio metadata-search` | `clio metadata search` | namespace, not hyphenated verb |
| `clio metadata-keys` | `clio metadata keys` | same |
| `clio project create` | `clio projects create` | pluralise for consistency with `docs` |
| `clio project show` | `clio projects show` | same |
| `clio project` (alias) | dropped | `projects` is the canonical form |

### 4.4 What stays

- `clio search`, `clio ingest`, `clio reindex`, `clio stats` — single-verb top-level.
- `clio audit` — top-level, scoped to all of Clio (not doc-specific). Per user note: parity for the audit verb is intentionally deferred to iter 6.
- `clio embedder` — singular. One active embedder; no plural concept.
- `clio docs edit` — kept as introduced in 0.11.0.
- `cfcf memory` ≡ `cfcf clio` — root alias preserved.
- `cfcf workspace` and other top-level cfcf verbs — unchanged this iteration.

### 4.5 Cerefox-MCP mapping

Every Cerefox MCP tool has a 1:1 cfcf verb under the new surface:

| Cerefox MCP | cfcf verb |
|---|---|
| `cerefox_search` | `cfcf clio search` |
| `cerefox_ingest` | `cfcf clio ingest` |
| `cerefox_get_document` | `cfcf clio docs get` |
| `cerefox_list_versions` | `cfcf clio docs versions` |
| `cerefox_list_projects` | `cfcf clio projects list` (or just `cfcf clio projects`) |
| `cerefox_list_metadata_keys` | `cfcf clio metadata keys` |
| `cerefox_metadata_search` | `cfcf clio metadata search` |
| `cerefox_get_audit_log` | `cfcf clio audit` |

cfcf adds `docs delete`, `docs restore`, `docs edit` — operations Cerefox HTTP exposes but doesn't ship as MCP tools. Future `CerefoxRemote` adapter implements these against the Cerefox HTTP API; agents calling `cfcf clio docs edit` go through the same MemoryBackend method regardless of backend.

## 5. Decisions captured

1. **Scope**: γ (namespaced, same as discussed Option C-with-the-Cerefox-correction).
2. **No deprecation aliases.** Old verbs removed in the same commit. Single-user OSS-pre-launch state means no third-party scripts to break.
3. **`embedder` stays singular.** One active at a time; no plural concept.
4. **`clio audit` stays top-level.** Audit covers all Clio mutations, not just docs. User explicitly noted "we will address verb parity broadly in iteration 6" — audit's placement isn't the hill to die on this round.
5. **Out of scope**: top-level cfcf verbs (`workspace`, `run`, `review`, `reflect`, `document`, `server`, `config`, `init`, `doctor`, `self-update`, `status`, `resume`, `stop`). Untouched. Iter 6 will audit them with the same lens.

## 6. Implementation impact

### 6.1 Code changes

- `packages/cli/src/commands/clio.ts` — restructure ~10 verb registrations. Existing handlers don't move; only the `.command()` registration tree changes.
- 7 verbs migrate from top-level to a namespace; 2 hyphenated verbs become namespace-verbs; `project` namespace pluralises to `projects` and drops the singular alias.
- One new helper for namespace-default-action (so `cfcf clio docs` → `cfcf clio docs list`).

### 6.2 Test changes

- `packages/cli/src/commands/clio.test.ts` — verb-name strings update (small).
- `packages/server/src/routes/clio.test.ts` — unaffected (HTTP routes don't change).
- `packages/core/src/clio/backend/local-clio.test.ts` — unaffected (backend unchanged).

### 6.3 Documentation churn

- `docs/guides/cli-usage.md` — full rewrite of the Clio section as a structured per-verb reference (the 5.8(d) sub-task).
- `docs/guides/clio-quickstart.md` — every example needs the new verb form.
- `docs/api/server-api.md` — unaffected.
- `docs/design/clio-memory-layer.md` — §7.2 (CLI commands example) updated.
- `CLAUDE.md` — Clio module summary line lists the new verbs.
- `README.md` — likely unchanged (no specific verbs called out).
- `cfcf-docs/clio-guide.md` template (the agent cue card) — updated; this is shipped to agents in every iteration, so the change is propagated automatically.
- `CHANGELOG.md` — new `[Unreleased]` entry: "BREAKING: Clio CLI verbs reorganised under noun namespaces."

### 6.4 Estimated effort

Half a day end-to-end. The verb registrations are ~30 LOC of changes; the heavy lifting is the doc rewrites (cli-usage + quickstart + design doc). Tests are mostly mechanical string updates.

## 7. Sequencing inside 5.8

Once this proposal is signed off:

1. **PR1** (`iteration-5/cli-verb-normalisation`): the rename itself. Single commit per topic so the diff stays scannable: (a) verb registrations + tests, (b) CLI-side doc updates + agent cue card, (c) CHANGELOG + plan note.
2. **PR2** (`iteration-5/user-manual`): the canonical user manual + structured `cli-usage.md` rewrite. Depends on PR1 — the manual references the canonical verbs, no point writing it twice.
3. **PR3** (`iteration-5/help-installer`): embed the manual + key docs in the installer; web UI Help tab; `cfcf help <topic>` CLI verb. Depends on PR2 — the embedded files are the manual.
4. **PR4** (later, possibly iter 6): the "Ask the agent" feature. Design-only inside 5.8; implementation deferred.

Each PR ships independently; reviewable diff under 800 LOC.

## 8. Open questions for review

1. Confirm option γ is the right shape (vs literal Cerefox CLI parity, which I'd argue against — see §3.2 for why).
2. Confirm `embedder` stays singular and `audit` stays top-level (your explicit calls; just paper-trailing them).
3. Confirm the four-PR sequencing; specifically that PR4 (Ask-the-agent) is design-only and lands in iter 6 rather than 5.
4. Naming detail: `cfcf clio metadata` with no subcommand — should that default to `metadata keys` (lighter, discovery-first), or print help? I'd default to help — both subcommands are equally useful and there's no obvious "primary" action.
