# Product Architect (PA) — design baseline

**Status**: Implementation baseline for PA v2. The old `product-architect.md` (v1 baseline, written 2026-04-28 before dogfood) was deleted as part of this refresh; git history retains it. This doc is the canonical design reference.
**Plan item**: 5.14.
**Branch**: `iteration-5/product-architect-spec`. Commit `0f154a9` is the v1 implementation (uses Pattern B + wrong directory model; superseded by the v2 refactor that follows this doc).

---

## TL;DR

The **Product Architect (PA)** is the cf² **Product Architect / Owner / Manager** role — interactive, user-facing, owns everything before the Solution Architect picks up. Sits at the front of the cf² SDLC; collaborates with the user before, during, and after loops. Runs interactively (TUI takeover) like the Help Assistant. Has the full cfcf docs in its prompt. Refuses to play dev/judge/SA/reflection/documenter roles; refuses to write `plan.md`. Uses a **disk-as-cache + Clio-as-canonical** memory model for low-latency interactive use plus durable cross-session continuity.

Invoked via `cfcf spec [task...]` — top-level verb, peer to `cfcf review` / `cfcf reflect` / `cfcf document`.

---

## Vision: Product Architect / Owner / Manager

PA is the user's expert collaborator at the front of the cf² SDLC. Like a thoughtful product manager paired with a senior software architect, PA helps the user think through the problem, articulate it precisely, define what "done" means, and feed all of that into the cfcf machinery. PA is the **specs + setup specialist** — but more broadly, it's the user's product-thinking partner throughout the cf² operation.

### Where PA fits in the cf² SDLC flow

```
cfcf init                       Global cf² setup (out of PA's scope; PA assumes cfcf is configured)
mkdir my-project && git init    User creates the folder
cd my-project
cfcf spec                       ← PA enters here, on a folder. May be empty, or partially set up,
                                  or even mid-flight after iterations.
                                  PA assesses + collaborates with the user.
                                  Drives `cfcf workspace init` if not yet registered.
                                  Helps author/refine problem-pack/{problem,success,...}.md.
                                  May offer to start the loop or server (with control nudges).
                                  Persists session memory locally + in Clio.

cfcf review                     Solution Architect (out of PA's scope; PA hands off here)
cfcf run                        Loop (out of PA's scope; PA may help start it but defers control)
cfcf reflect / cfcf document    Other roles' territory
```

### PA vs HA vs other SDLC roles

| Trait | PA | HA | Other SDLC roles (dev/judge/SA/reflection/documenter) |
|---|---|---|---|
| Interactive? | **Yes** — TUI takes over the user's shell | **Yes** — same | No — fire-and-forget; signal-file workflow |
| User-facing? | **Yes** — direct conversation | **Yes** — direct Q&A | No — agents talk to each other via files |
| Position relative to SDLC | **Inside** — owns the front of the SDLC | **Outside** — meta tool helping the user operate cfcf | Inside — each owns a specific SDLC phase |
| Focus | Product / problem definition / specs | cf² operation / Q&A / config | Code / verdicts / plans / docs |
| Triggered by | User explicitly (`cfcf spec`) | User explicitly (`cfcf help assistant`) | The loop (or `cfcf review` / etc.) |
| Full cfcf docs in prompt? | **Yes** — needs to understand cfcf to help shape specs | **Yes** — needs to answer cfcf questions | Partial — adapter-specific instructions only |
| Persistent memory | Per-workspace + per-user (disk + Clio hybrid) | Per-user (Clio only) | Per-workspace iteration history; reflection's Clio memory |
| System-prompt injection | **Pattern A** (ephemeral, regenerated each session) | Pattern A | N/A — runtime instructions vary per role |

PA shares HA's interactive nature + full-docs-in-prompt + Clio access. PA differs in scope (specs/setup vs cfcf usage), persistence (per-workspace not just per-user), and SDLC position (inside, owns the front; vs HA outside, meta-tool).

---

## Prerequisites

**Minimal** (PA needs these to operate at all):
- A folder for the repo. Provided via `--repo <path>` or defaults to cwd. May be empty or populated.
- The user has SOME idea of what they want to build (PA can't operate in pure vacuum — but a one-line "I want to build X" is enough; PA will ask follow-ups).

**Not prerequisites** (PA detects + assists with each):
- Git initialisation. PA detects + offers to run `git init` if missing. **PA insists on this before proceeding** (cfcf needs git).
- cfcf workspace registration (`cfcf workspace init`). **PA insists on this before any memory writes** (workspace_id is required to scope memory). PA collects the workspace name in conversation, shows the command, asks confirmation, runs it.
- `cfcf-docs/` doesn't need to exist (it's iteration-generated; the loop creates it).
- `problem-pack/` doesn't need to exist (`cfcf workspace init` scaffolds it).
- The cfcf server may or may not be running. PA detects + offers to start it.
- Iterations may or may not have run. PA reads the history if any.

---

## The cfcf directory model (what PA writes where)

cfcf has a specific directory convention that PA must respect:

| Directory | Purpose | Owner | PA's interaction |
|---|---|---|---|
| `<repo>/problem-pack/` | **User's source of truth** for spec files: `problem.md`, `success.md`, `constraints.md`, `hints.md`, `style-guide.md`, `context/*` | User (with PA's help) | **PA writes here** during spec authoring (with permission) |
| `<repo>/cfcf-docs/` | cfcf-generated mirror + iteration artifacts: `plan.md`, `iteration-history.md`, `iteration-logs/`, `iteration-handoffs/`, `iteration-reviews/`, `reflection-reviews/`, `decision-log.md`, etc. | cfcf (regenerated each iteration) | **PA reads** to understand prior iteration state. PA does NOT write here. |
| `<repo>/CLAUDE.md` and `<repo>/AGENTS.md` | Iteration-time agent instructions (sentinel-marked, regenerated each iteration) | cfcf | PA does not touch |
| `<repo>/.cfcf-pa/` | **PA's working memory cache** (NEW in v2). Local mirror of Clio's PA memory + per-session scratchpad | PA | **PA reads + writes here** throughout every session |

The v1 implementation conflated these: it wrote PA's briefing files (now deprecated) to `cfcf-docs/`, and assumed Problem Pack files lived there too. v2 corrects both.

---

## System-prompt injection: Pattern A

PA v2 uses **Pattern A** for system-prompt injection (same as HA), not Pattern B (v1's approach).

### What Pattern A means here

cfcf, at PA launch time, computes the full system prompt (with state injection + memory inventory) and passes it to the agent CLI as an ephemeral input:

- **claude-code**: `claude --append-system-prompt "<full prompt>" --model sonnet --cd <repo>`
- **codex**: `codex -c model_instructions_file=<tempfile-path> --cd <repo>` (tempfile deleted after session)

The system prompt is regenerated fresh on every PA invocation. Nothing persists in the repo for the system prompt itself.

### Why we abandoned Pattern B

Pattern B (v1's approach) wrote the system prompt to `<repo>/cfcf-docs/{AGENTS,CLAUDE}.md` and relied on the agent CLI's auto-load. The original justification was "PA needs durable per-session context." But durability is now provided by the **disk + Clio memory model** (next section), so the system prompt itself doesn't need to be durable. Pattern A is simpler:

- No briefing files in the user's tree
- Agent's cwd is the repo root (correct for editing `problem-pack/` + running cfcf commands)
- No conflict with the iteration loop's `cfcf-docs/` writes
- No sentinel-merge complexity for the briefing files
- Same plumbing as HA (one launcher seam to maintain)

### Agent cwd

Agent is spawned with `--cd <repo>` (the user's repo root). This means:
- Agent's bash tool runs commands relative to the repo root
- Edits to `problem-pack/*.md` work with simple relative paths
- `cfcf` CLI commands run in the right context
- Memory cache writes go to `<repo>/.cfcf-pa/` (relative to cwd)

---

## Memory protocol — disk + Clio hybrid

This is the most important design decision for PA v2.

### The two-tier model

```
┌────────────────────────────────────────────────────────────────────┐
│                      Tier 1: <repo>/.cfcf-pa/                      │
│                      (Working store, on disk)                      │
│                                                                    │
│  session-<id>.md     Live session scratchpad (one per session)     │
│  workspace-summary.md  Local mirror of Clio's pa-workspace-memory  │
│  meta.json           Sync timestamps + session_id + Clio doc IDs   │
│                                                                    │
│  → Low latency (file I/O, no JSON-RPC).                            │
│  → The agent reads + writes these freely during the session.       │
└────────────────────────────────────────────────────────────────────┘
                                  ▲
                                  │  sync at session start + end
                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│                      Tier 2: Clio (~/.cfcf/clio.db)                │
│                      (Canonical store, durable)                    │
│                                                                    │
│  pa-workspace-memory   ONE doc per workspace (project-scoped).     │
│                        Same content as workspace-summary.md.       │
│                                                                    │
│  pa-global-memory      ONE doc, cross-workspace.                   │
│                        Lives ONLY in Clio (no local cache).        │
│                                                                    │
│  → Survives machine reboots, supports multi-machine usage.         │
│  → Searchable via Clio's FTS + semantic.                           │
└────────────────────────────────────────────────────────────────────┘
```

### Why hybrid

- **Latency**: PA is interactive. Every Clio write is a JSON-RPC call to the cfcf server (or, in agent-spawned mode, a CLI invocation that opens the SQLite DB, runs FTS triggers, etc.). Doing this on every observation/decision during conversation is too slow + too disruptive. Disk writes are instant.
- **Durability**: Clio is the canonical record. Disk files in `<repo>/.cfcf-pa/` could be deleted, lost in a machine swap, or out of sync with another machine. Clio is the source of truth.
- **Eventually consistent**: sync happens at session boundaries (start + end), with a recovery path if a session crashes mid-write.

### Files in `<repo>/.cfcf-pa/`

| File | Purpose | Owner | Persistence |
|---|---|---|---|
| `session-<id>.md` | Live scratchpad for the current session. Agent writes throughout: decisions taken, rejections, in-progress thinking, key user statements. | Agent (PA) | Long-lived. One per session. Older session files are kept as a historical record. |
| `workspace-summary.md` | Local working copy of the per-workspace Clio doc (`pa-workspace-memory`). Agent reads at start; updates throughout; pushes back to Clio at end. | Agent (PA) | Long-lived; mirrors Clio. |
| `meta.json` | Small bookkeeping file: last Clio sync timestamp, current session_id, Clio doc IDs (so the agent can update without re-discovering). | Agent (PA) | Long-lived; updated on each sync. |

The `.cfcf-pa/` directory should be gitignored by default. cfcf can offer to add it to `.gitignore` if `.gitignore` exists at session start (with permission).

### Sync model — disk ↔ Clio

```
Session start:
  1. Read .cfcf-pa/workspace-summary.md (if exists) + .cfcf-pa/meta.json (if exists)
  2. Fetch Clio's pa-workspace-memory metadata (specifically: updated_at)
  3. Reconcile based on timestamps:
     - Clio newer → pull Clio content to disk (another machine wrote since last sync)
     - Local newer → push to Clio NOW (last session wrote disk but didn't sync; recovery path)
     - Equal → no action
  4. Fetch Clio's pa-global-memory (always fresh; no local cache)
  5. Initialise new session-<id>.md with header (timestamp, workspace_id, prior session reference)

During session:
  - Agent writes observations + decisions to session-<id>.md as they happen
  - On major decisions, agent ALSO updates workspace-summary.md (still on disk; cheap)
  - For cross-cutting user preferences, agent updates pa-global-memory in Clio directly
    (no local cache for global; one fetch + one ingest)

Session end (PA proactively asks: "Want me to save before you go?"):
  - Agent finalises session-<id>.md (writes a closing summary section)
  - Agent updates workspace-summary.md with the session's outcome
  - Push workspace-summary.md to Clio via `cfcf clio docs ingest --update-if-exists`
  - Update meta.json with new sync timestamp
  - (Optional) Ingest session-<id>.md to Clio as a separate searchable artifact

Recovery (Ctrl-D without saving):
  - Next session start: timestamp comparison shows local newer than Clio
  - Sync pushes the unfinished session's disk state to Clio
  - User loses no data; PA can recap from the partial state on next launch
```

### Clio docs (Tier 2)

| Doc title | Project | Metadata | Updated by |
|---|---|---|---|
| **`pa-workspace-memory`** | `cfcf-memory-pa` | `{role:"pa", artifact_type:"workspace-memory", workspace_id:"<id>", session_id:"<latest>", session_count:N}` | PA, on each session end (or recovery sync) |
| **`pa-global-memory`** | `cfcf-memory-global` (shared with HA) | `{role:"pa", artifact_type:"global-memory"}` | PA, when cross-cutting preferences emerge |

Document titles are **standardised** by cfcf — PA always reads/writes to these exact titles. The launcher injects the resolved Clio doc IDs into PA's system prompt at launch (after lookup) so PA can ingest with `--document-id` for guaranteed update-not-create semantics.

### Doc structure (Markdown — both disk + Clio)

`workspace-summary.md` / `pa-workspace-memory`:

```markdown
# PA workspace memory: <workspace name>

**Workspace ID**: <id>
**Repo**: <path>
**Last updated**: <ISO timestamp>
**Session count**: <N>

## Current state (always-current snapshot)

<one-paragraph current state of the project from PA's perspective —
what's specced, what's open, what's blocking, where we are in the SDLC>

## Open questions

- <question 1>
- <question 2>

## Sessions (chronological, newest first)

### Session: 2026-04-28T11:03:22Z (`pa-2026-04-28T11-03-22-abc123`)
**Duration**: 25 min  
**Outcome**: Drafted problem.md + success.md; user wants to refine constraints next session.

**Decisions this session**:
- success.md will use property tests via fast-check — preferred over example-based for the parser
- TDD throughout — user wants test-first

**Rejections this session**:
- Considered hexagonal architecture, deferred — too much ceremony for v1

### Session: 2026-04-25T...
...
```

`pa-global-memory` (Clio only):

```markdown
# PA global memory (cross-workspace)

**Last updated**: <ISO timestamp>

## User preferences

- TDD always (captured: 2026-04-28, source: my-project)
- vitest > jest (captured: 2026-04-28, source: my-project)
- TypeScript by default (captured: 2026-04-25, source: another-project)

## Cross-cutting decisions

- <decision> (captured: <date>, source: <workspace name>)
```

### When PA writes — the prompting trick

The system prompt instructs PA explicitly:

```
# Memory protocol

Throughout the session, write OBSERVATIONS to .cfcf-pa/session-<id>.md
as they happen — that's your live scratchpad. Don't worry about
batching; disk writes are cheap.

When a MAJOR DECISION, REJECTION, or USER PREFERENCE emerges:
  - If workspace-specific: ALSO update .cfcf-pa/workspace-summary.md
    (add a bullet under the current session's "Decisions" /
    "Rejections" section)
  - If cross-cutting (TDD, language, tooling preferences spanning
    projects): ALSO update Clio's pa-global-memory directly via
    `cfcf clio docs ingest --update-if-exists --document-id <id>`

Before the user exits the session, ASK PROACTIVELY:
"Want me to save this session's work before you go?"
Don't wait for them to remember to ask.

If they say yes:
  1. Write a closing summary to session-<id>.md
  2. Update workspace-summary.md with this session's outcome
  3. Push workspace-summary.md to Clio via `cfcf clio docs ingest
     --update-if-exists --document-id <pa-workspace-memory-doc-id>`
  4. Update .cfcf-pa/meta.json with the new sync timestamp

If you sense a natural endpoint mid-session ("ok, let's stop for
today" / "I think we're done with success.md"): same — ask before
you lose state.
```

The instruction layer is what makes this work — Clio writes don't happen automatically; PA decides when and what.

### Read-only access to other roles' memory

PA reads (but never writes to) other roles' Clio Projects for context:

- `cfcf-memory-reflection` (filtered by `workspace_id`) — what reflection observed across iterations
- `cfcf-memory-architect` (filtered by `workspace_id`) — what Solution Architect noted in past reviews
- `cfcf-memory-ha` (filtered by `workspace_id`) — what HA captured in support sessions for this workspace

cfcf injects a summary of these (recent docs, top-N by recency) into PA's system prompt at launch. PA does not write to these — that would muddy the role boundary.

---

## Pre-injection at launch (cfcf's responsibility)

cfcf, at PA launch time, computes the following and injects into the system prompt. Most are cheap (file reads, pid file checks). The Clio reads are bounded.

| Item | Source | Cost |
|---|---|---|
| Repo path (absolute) | `--repo` or `cwd` | nil |
| Git status: is `.git/` present? Latest commit? | `git rev-parse --git-dir` + `git log -1 --oneline` | a fork |
| Workspace registration: registered? `workspace_id`? `name`? `clio_project`? | `getWorkspaces()` + match by `repoPath` | one fs read |
| cfcf server status: running? PID? port? | pid file + `kill -0 <pid>` | one syscall |
| Iteration history (if any) | read `cfcf-docs/iteration-history.md` if present | one fs read |
| Problem Pack file states | read `<repo>/problem-pack/*.md` (size + first 500 chars) | up to 7 fs reads |
| `.cfcf-pa/` state | check for existing `session-*.md`, `workspace-summary.md`, `meta.json` | a few fs reads |
| `pa-workspace-memory` content | Clio search by title + metadata | one DB query + content read |
| `pa-global-memory` content | Clio search by title + metadata | one DB query + content read |
| Read-only inventory of other-role memory | Clio metadata search per role, filtered by `workspace_id` | one DB query per role |
| `session_id` | UUID generation at launch | nil |

Total: well under 100 ms typical. Acceptable for an interactive launch.

---

## Behavior at session start

The system prompt instructs PA's session-start protocol:

1. **Greet briefly** (one sentence). Identify the role: "I'm the Product Architect."
2. **Summarise the state assessment** (what cfcf detected + injected). One short paragraph: "Here's what I see: [git status] [workspace registration] [problem-pack state] [server status] [last session if any]."
3. **Branch on git initialisation**:
   - **Not a git repo** → INSIST: "cfcf needs git. Want me to run `git init` for you?" (Wait for confirmation, run, continue.)
4. **Branch on workspace registration**:
   - **Not registered** → INSIST: "Before we do anything else, this folder needs to be registered as a cfcf workspace. That gives us a stable workspace ID and connects this folder to the rest of cfcf. What name do you want for this workspace? I'll then run `cfcf workspace init --repo <path> --name <name>` for you."
   - (Wait for name. Show the command. Confirm. Run.)
   - **Registered** → recap from `workspace-summary.md`: "Last session ([date]) we [outcome]. Want to continue from there, or focus on something else?"
5. **Offer setup help proactively** when relevant:
   - Server not running? "cfcf server isn't running. I can start it with `cfcf server start` if/when we need it."
6. **Open the conversation** based on the user's likely intent:
   - Fresh project (no problem-pack files yet) → "Tell me what you want to build."
   - Existing project, mid-flight → "Where do you want to focus?"

---

## Behavior throughout the session

### Primary scope (focused; where most tokens go)

PA's bread and butter. Don't push back; just help.

- **Repo setup**: `git init`, basic `.gitignore` suggestions
- **Workspace registration**: `cfcf workspace init` (collect name in conversation; offer Clio Project too)
- **Problem Pack authoring**:
  - On a fresh project: PA brainstorms with the user, asks clarifying questions, drafts each of `problem.md`, `success.md`, `constraints.md` (and optionally `hints.md`, `style-guide.md`), iterates with the user
  - On an existing project: PA reviews what's there, suggests improvements, helps refine
- **Problem Pack review**:
  - Before the user runs `cfcf review`: PA reads the four files, gives an honest critique, suggests refinements
  - After a loop has run: PA can re-review based on what the loop discovered (via `cfcf-memory-reflection`)
  - Iterating across loops: PA helps refine specs based on iteration outcomes
- **Spec brainstorming**: PA acts as a thoughtful product architect — proposes ideas, surfaces edge cases, challenges assumptions, asks "what does success look like for this?"
- **Memory hygiene**: writing observations + decisions to disk + Clio per the memory protocol

### Secondary scope (allowed; user-driven control encouraged)

PA can do these. Each comes with a "you might prefer to drive this yourself for control + visibility" nudge. **Cost is mentioned as a dimension, NOT the primary concern** — control + understanding is the bigger reason to drive things from the user's terminal / web UI.

- **Server start** (`cfcf server start`)
- **Loop start** (`cfcf run`) — strong control nudge: "You'll get better control + visibility running this from another terminal or the web UI. I'll be here when you want to refine specs after."
- **Status checks** (`cfcf workspace show`, `cfcf clio search`, `cfcf doctor`, etc.) — these are cheap; PA runs them freely
- **Reading logs** to understand prior iterations
- **Answering questions** about cfcf (PA has the full docs in its prompt)

### Out of scope (hard refuse + redirect)

PA refuses to play these roles. The system prompt encodes hard refusals.

- **Dev role** (writing code, implementing features, fixing bugs)
  - Redirect: "That's the dev role's job inside the iteration loop. Once the Problem Pack is solid, run `cfcf run`."
- **Judge role** (verdict on iteration quality)
  - Redirect: "That's the judge role inside the loop."
- **Solution Architect role** (writing `plan.md`, architectural review)
  - Redirect: "That's the Solution Architect's job. Run `cfcf review` once the Problem Pack is ready."
- **Reflection role** (cross-iteration strategic analysis)
  - Redirect: "Run `cfcf reflect` for that."
- **Documenter role** (final user-facing docs)
  - Redirect: "Run `cfcf document` (or let it run automatically on SUCCESS)."

The user CAN override after PA explains the redirect. PA isn't a stubborn gatekeeper — it's an honest collaborator who knows its lane.

---

## Cost + control framing

PA does not over-emphasise token cost. The PRIMARY reason to nudge the user toward driving things themselves is **control + visibility + understanding** — they should run the loop, watch their terminal, follow what's happening. Token cost is a secondary dimension when relevant.

System prompt wording:

```
# Cost + control awareness

When you're about to run an action where the user could plausibly drive
it themselves (`cfcf run`, watching a long-running process, monitoring
iterations):
  - Mention that the user gets better control + visibility doing it
    themselves
  - Briefly note that having you do it costs more tokens (one mention,
    not a refrain)
  - Offer to do it anyway if the user prefers

You do NOT warn about token cost on every operation. Reading docs,
running quick CLI status commands, helping the user think through a
problem — these are your job, not something to flag as expensive.
```

---

## CLI surface

```bash
cfcf spec [task...]              # interactive PA session on cwd
cfcf spec --repo <path>          # explicit repo path
cfcf spec --agent <name>         # override config.productArchitectAgent
cfcf spec --print-prompt         # debug: emit assembled system prompt + exit
cfcf spec "Tighten the success.md auth criteria"   # opens with this task
```

No `--bootstrap` flag — PA always works on any folder. The "should we register the workspace?" decision is a session-start conversation, not a CLI flag.

---

## System prompt structure (Pattern A)

cfcf assembles the prompt at launch and passes it via Pattern A. Sections in order:

1. **Preamble**: PA identity (Product Architect / Owner), interactive role, full-docs awareness
2. **Scope**: primary / secondary / out-of-scope (with redirect text for each)
3. **Cost + control framing** (see above)
4. **State assessment**: pre-injected state from cfcf launch (git, workspace, server, history, Problem Pack files, `.cfcf-pa/` state)
5. **Memory inventory**: pa-workspace-memory + pa-global-memory + read-only summaries from other-role Clio Projects
6. **Memory protocol**: when + how to write to disk + Clio (the snippet above)
7. **Permission model**: per-command consent for mutations; reads run freely
8. **cfcf documentation bundle**: full embed (~160 KB; reuse HA's `docsSection()`)
9. **Session-start instructions**: greet briefly + summarise state + branch on git/workspace
10. **Session-end instructions**: ask before exit; save session; sync to Clio
11. **`session_id`**: tagged into every memory write

Approximate size: ~170–180 KB (PA-specific sections ~10 KB + docs ~160 KB + workspace state injection 0–30 KB). Well within modern context windows.

---

## Hand-off

When PA detects (or the user signals) that the Problem Pack is ready:
1. PA does a final review of the Problem Pack files
2. PA updates `workspace-summary.md` + pushes to Clio
3. PA tells the user: "I think we're ready. Next steps are `cfcf review` (Solution Architect will read the Problem Pack and emit a plan + readiness verdict) or `cfcf run` directly. You can come back to me anytime to refine specs after a loop runs."
4. PA exits cleanly (the user Ctrl-Ds when ready)

---

## Implementation delta — v1 → v2

The v1 commit (`0f154a9` on `iteration-5/product-architect-spec`) had several mistakes. The v2 refactor:

1. **Drop the cfcf-docs/ pre-flight gate**. Launcher always launches; PA assesses + drives setup.
2. **Switch from Pattern B to Pattern A** for system-prompt injection. Same as HA. No briefing files in the user's repo.
3. **Switch Problem Pack file location from `<repo>/cfcf-docs/{problem,success,...}.md` to `<repo>/problem-pack/{problem,success,...}.md`** — match cfcf's actual convention.
4. **Add `<repo>/.cfcf-pa/` directory** for memory cache (NEW). Launcher creates if missing. Files: `session-<id>.md`, `workspace-summary.md`, `meta.json`.
5. **Embed the full help bundle in PA's system prompt** (reuse HA's `docsSection()`).
6. **Reframe role description**: Product Architect/Owner; primary = setup + specs; secondary = oversight (with control nudges); refuses to play other SDLC roles or write `plan.md`.
7. **Add proactive offers**: git init, `cfcf workspace init` (with name elicitation), `cfcf server start`, `cfcf run` (with control nudge).
8. **Add cost + control framing** (control primary; cost secondary; one mention not a refrain).
9. **Pre-inject richer state at launch**: git status, workspace registration lookup, server status, iteration history, problem-pack file states, `.cfcf-pa/` state, memory inventory (PA-scoped + global + read-only other-role).
10. **New Clio memory protocol** — disk + Clio hybrid; per-workspace doc with structured Markdown internally; cross-workspace global doc; sync model with timestamp reconciliation.
11. **Compute `session_id`** at launch + inject into prompt + tag every memory write.
12. **Remove the doctor warning** about missing `cfcf-docs/`.
13. **Workspace registration as PA's first priority** on unregistered repos (after git init).
14. **Update `packages/core/src/product-architect/`** module accordingly:
    - `prompt-assembler.ts` — full docs embed; new role framing; memory protocol section; state-assessment section
    - `workspace-state.ts` — read `<repo>/problem-pack/*.md` + `<repo>/.cfcf-pa/*` + git/workspace/server state
    - `memory.ts` — sync logic for disk ↔ Clio (or move sync logic into the agent's prompt, with cfcf only injecting current state)
    - `briefing-files.ts` — DELETE (Pattern B no longer used)
    - `launcher.ts` — Pattern A argv builder; spawn with `--cd <repo>`; mkdir `.cfcf-pa/` if missing
15. **Update `packages/cli/src/commands/spec.ts`** for the new pre-flight (none) + state-assembly flow
16. **Update tests**: drop briefing-file tests; update workspace-state tests for new directory model; update launcher tests for Pattern A; update prompt-assembler tests for new structure
17. **Update CHANGELOG**.

### What stays the same as v1

- Branch (`iteration-5/product-architect-spec`); v2 amends/replaces v1's commit
- Top-level CLI verb `cfcf spec [task...]`
- Field name `productArchitectAgent`
- Module location `packages/core/src/product-architect/`
- Interactive runtime (TUI takeover, inherit stdio)
- claude-code defaults to sonnet (vs HA's haiku)
- Codex stays account-tied (no `--model` forced)

---

## Open questions for v2 dogfood

- **Cross-workspace memory expansion**: should PA surface "you defined this term in another project — want to reuse?" Cross-workspace pattern matching adds value but complexity. Defer to v3.
- **PA monitoring loops actively**: PA could read live signal files / reflection updates while a loop runs and offer real-time spec feedback. Heavy + tokens-expensive. Defer.
- **Web UI surface for PA**: `cfcf spec` is CLI-only in v1. See plan item 5.15.
- **PA + autoReviewSpecs**: when `autoReviewSpecs=true`, the loop runs Solution Architect before iteration 1. PA could be invoked beforehand for spec quality. Workflow: `cfcf spec` → `cfcf run` (with autoReviewSpecs) → done. No changes needed; just document the pattern.
- **Session-file rotation**: do we keep all `session-*.md` files forever in `.cfcf-pa/`? After N sessions or X megabytes, do we archive older ones to Clio + delete from disk? Defer until dogfood shows the disk pressure.

---

## Glossary

- **Problem Pack** — the user-owned spec files in `<repo>/problem-pack/`: `problem.md`, `success.md`, `constraints.md`, optionally `hints.md` / `style-guide.md` / `context/*`. The user (or PA on their behalf) writes these; cf² agents read them every iteration.
- **Solution Architect** — the existing cf² role (`cfcf review`) that reviews the Problem Pack + workspace state and emits a readiness verdict + plan outline. PA writes the Problem Pack; Solution Architect reviews it. Different jobs, sequential roles.
- **Pattern A** — system-prompt injection via ephemeral CLI flag (`--append-system-prompt` for claude-code) or tempfile (`model_instructions_file` for codex). Used by HA + PA v2.
- **Pattern B** — system-prompt injection via durable file in the agent CLI's auto-load location (`CLAUDE.md` / `AGENTS.md`). Used by PA v1; abandoned in v2 due to redundancy with disk-based memory model.
- **`<repo>/.cfcf-pa/`** — PA's working memory cache directory. NEW in v2. Contains `session-<id>.md`, `workspace-summary.md`, `meta.json`.
- **`pa-workspace-memory` / `pa-global-memory`** — the two standardised Clio doc titles PA reads/writes. Per-workspace + cross-workspace respectively.
- **`session_id`** — UUID-style identifier generated at PA launch (e.g. `pa-2026-04-28T11-03-22-abc123`). Tagged into all memory writes; surfaced in webapp history + log files.
