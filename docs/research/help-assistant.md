# Help Assistant — design

**Status**: Locked. Implementation in progress on `iteration-5/help-assistant`.
**Plan item**: 5.8 PR4 (renamed from "Ask the Agent"; the original v1 design was superseded 2026-04-27).
**Supersedes**: [`docs/research/ask-the-agent.md`](ask-the-agent.md) (kept as historical record of the discarded one-shot design).

---

## TL;DR

`cfcf help assistant` launches the user's configured dev agent (claude-code / codex) **as a new cf² role**: the **Help Assistant (HA)**. The agent runs interactively in the current shell, with a system prompt that:

- Sets the agent's role as a cf²-expert support assistant
- Provides the full embedded user manual + focused guides
- Grants read access to the local cf² environment (config, workspaces, Clio)
- Allows mutations only through the agent's per-command permission prompt (no silent state changes)
- Reads from + writes to a Clio "memory" namespace so cf² adapts to the user's preferences over time

The HA is the **first** of two roles using this architecture. The **Product Architect (PA)** in iter-6 reuses the same machine with a narrower scope (problem-pack creation + iteration on specs/test-cases/success-criteria). Designing for both at once means iter-5's HA already establishes the patterns iter-6 inherits.

## Why this design

The user flagged an architectural shift from the prior "Ask the Agent" v1:

| | Old v1 design (superseded) | New HA design |
|---|---|---|
| Verb | `cfcf ask "<question>"` | `cfcf help assistant` |
| Mode | One-shot: launch agent → answer → exit | Interactive: launch agent → converse → exit when done |
| Terminal | New terminal window (OS-fragile) | Current shell (agent's TUI takes over) |
| Permissions | Read-only Q&A | Read by default; per-command prompts for mutations |
| Persistence | None | Clio memory survives sessions |
| Scope | Just answer questions | Answer + explain + (with permission) configure + run cf² |
| Adapter | Custom spawn code | Reuse the agent's interactive mode |

The shift wins on three axes. **Architectural reuse** — the HA is a sixth role alongside dev / judge / architect / reflection / documenter, configured the same way. **No new fragile surface** — the agent CLIs already have interactive TUIs and permission prompts; we don't write our own. **Future PA reuses everything** — same launcher, same memory schema, different system prompt + scope.

## UX

### CLI

```bash
cfcf help assistant
```

That's it. `cfcf help assistant` with no arguments launches the agent in interactive mode. The agent's TUI takes over the current shell; the user converses; on exit, control returns.

Optional flags (v1):

```
cfcf help assistant \
    [--workspace <name>]     # include this workspace's recent state in the system prompt
    [--agent claude-code|codex]   # override config.helpAssistantAgent
    [--print-prompt]         # print the assembled system prompt + exit; don't launch
```

`--workspace` enriches the system prompt with the workspace's recent iteration history + plan + decision-log — useful for "why is iteration N stuck?" questions. Off by default to keep workspace state out of the prompt unless explicitly requested.

`--print-prompt` is the debug escape hatch.

### Web UI (deferred to iter-6)

A **Help Assistant** button on each web UI page. Clicking it prints the appropriate `cfcf help assistant [--workspace <name>]` command in a modal so the user can run it in their own terminal. We don't try to embed an interactive agent TUI in the browser — that's a much bigger problem.

### Inside the agent's session

Once launched, the HA is the user's dev agent (claude-code / codex) in interactive mode, with a curated system prompt. The user types questions or instructions; the agent answers + offers to run cf² commands when relevant. Every command runs through the agent's existing permission prompt, so mutations need explicit user approval each time.

Example flows v1 should handle:

- **Q&A**: "Why does `cfcf clio search` return nothing?" — agent reads `cfcf clio stats`, sees `documentCount: 0`, explains.
- **Diagnose**: "My iteration is stuck" — agent runs `cfcf doctor`, reads the output, suggests fixes.
- **Configure**: "I want to switch the dev agent to codex" — agent shows the current config, asks permission to run `cfcf config edit`, walks the user through.
- **Recall preferences** (Clio memory): on session start, agent reads `cfcf clio search --project cfcf-memory-global …` for the user's stored preferences and incorporates them into responses.
- **Persist preferences** (with permission): user says "remember I always want pytest"; agent asks permission to run `cfcf clio docs ingest --project cfcf-memory-global …` with the new preference doc.

## Architecture

### HA as a cf² role

Like dev / judge / architect / reflection / documenter, the HA gets its own slot in `CfcfGlobalConfig`:

```ts
interface CfcfGlobalConfig {
  // ... existing roles ...
  helpAssistantAgent: AgentRoleConfig;   // default: same as devAgent
}
```

`cfcf init` doesn't currently prompt for the HA agent (defaults are fine for v1); it's editable via `cfcf config edit` and the web UI Server Info page.

The agent role config has the same shape as every other role: `{ adapter: "claude-code" | "codex", model: string }`. Resolved through the same `resolveAgentRole()` helper that other roles use.

### Launching the agent

`cfcf help assistant` does:

1. Resolve `config.helpAssistantAgent` (or `--agent` override)
2. Read the embedded help bundle (the same one that powers `cfcf help <topic>`) into a string
3. Read role-relevant Clio memory (`cfcf-memory-ha` Project + `cfcf-memory-global` Project, top-N hits matched against any seed query — for v1, just dump everything in those two projects up to a token cap)
4. Optionally read workspace state if `--workspace` is set
5. Compose the system prompt (see §4)
6. Write the prompt to a tempfile (it's ~200KB; CLI flag length limits don't permit inline)
7. Spawn the agent CLI with appropriate flags + the tempfile path, inheriting stdio
8. Wait for exit; clean up the tempfile

The system prompt is large but well within modern context windows. claude-code with Sonnet 4.5 has a 200K-token context (~800 KB of plain text); the prompt fits comfortably.

### Agent CLI flags

For each supported agent, we use the flags that:
- Inject our system prompt
- Enable per-command permission prompting (read-only by default)
- Run interactively in the current shell

**claude-code** (per its CLI):
```bash
claude-code \
    --append-system-prompt "$(cat /tmp/cfcf-ha-prompt-XXXX)" \
    --permission-mode default
```
`default` permission mode prompts for any tool invocation; that's our v1 read-only-with-mutations-approved-per-command behaviour.

**codex** (per its CLI):
```bash
codex \
    --system "$(cat /tmp/cfcf-ha-prompt-XXXX)" \
    --approval-mode auto-edit-with-confirm   # or whatever codex's equivalent is
```
We'll verify the exact flag at implementation time; the principle is the same.

If the agent CLI's flags change, the launcher knows about it via the agent's adapter (existing pattern in `packages/core/src/adapters/`).

### Local environment access

The HA's system prompt declares what the agent can read:

- `~/.cfcf/config.json` — global config (read-only; mutations need user approval to edit)
- `~/.cfcf/clio.db` — accessed via `cfcf clio …` CLI commands
- `~/.cfcf/workspaces/<id>/` — per-workspace metadata
- The current `pwd` — usually a workspace's repo, but not always
- `cfcf-docs/` if running inside a workspace's repo
- Embedded help bundle (already in the system prompt)

The agent reads via its existing tool surface (claude-code's bash, codex's shell). No new cfcf integration; the agent CLI already knows how to read files and run commands.

## Clio memory schema

User-confirmed convention (2026-04-27): use Clio Projects as memory namespaces. No additional metadata required beyond what we already use.

### Projects

| Project name | Scope | Who reads | Who writes |
|---|---|---|---|
| `cfcf-memory-global` | Cross-role: things every role should know about this user (e.g. "always TypeScript", "Pacific time zone") | All cf²-managed agent roles | All cf²-managed agent roles |
| `cfcf-memory-ha` | HA-specific: lessons / preferences only relevant to help-assistant operation | HA | HA |
| `cfcf-memory-pa` (iter-6) | PA-specific: spec-iteration history, problem-decomposition patterns | PA | PA |
| `cfcf-memory-architect` (future) | Architect-role-specific | Architect | Architect |
| `cfcf-memory-dev` (future) | Dev-role-specific | Dev | Dev |
| `cfcf-memory-judge` (future) | Judge-role-specific | Judge | Judge |
| `cfcf-memory-documenter` (future) | Documenter-role-specific | Documenter | Documenter |
| `cfcf-memory-reflection` (future) | Reflection-role-specific | Reflection | Reflection |

The `cfcf-memory-` prefix groups them when the user runs `cfcf clio projects` and visually distinguishes them from user-defined Clio Projects (which typically have domain names like `backend-services`, `cf-ecosystem`, etc.).

### Read scope per role

A role on session start reads two Clio Projects: its own (`cfcf-memory-<role>`) plus the global (`cfcf-memory-global`). Reading is via `cfcf clio search` — the agent decides what to query based on the user's question.

For v1 (HA only), the system prompt instructs:
- On session start: run `cfcf clio docs list --project cfcf-memory-ha` and `cfcf clio docs list --project cfcf-memory-global` to get an inventory; pull specific docs as relevant via `cfcf clio docs get <id>`.
- During the session: run `cfcf clio search "<query>" --project cfcf-memory-ha,cfcf-memory-global` (multi-project search — TODO: confirm whether the current Clio search supports comma-separated projects; if not, two queries).

### Write scope (v1: read-only by user-approval default)

The HA can propose to write to memory but every write requires user approval via the agent's permission prompt. No silent writes.

Writing is via `cfcf clio docs ingest --project <memory-project> --title "..." --metadata '{...}' < content`. The agent decides which project (HA-specific vs global) based on:

- "Does this preference apply across cf²?" → `cfcf-memory-global`
- "Is this lesson only relevant when answering help questions?" → `cfcf-memory-ha`
- When in doubt → ask the user

The system prompt includes a decision tree for this. The user can always override.

### Bootstrapping

On first `cfcf help assistant` invocation, the memory projects don't exist. The agent creates them on first write (`cfcf clio projects create cfcf-memory-global --description "..."`). v1 doesn't pre-create them.

## System prompt

The full template is generated at HA-launch time with substitutions for the user's current state. Approximate shape (~200 lines + the embedded help bundle):

```
You are the cf² Help Assistant -- a specialised role within the cf²
(Cerefox Code Factory) project. Your job is to answer the user's
questions about cf² and help them configure + run it.

You are NOT here to write code or implement features. You are here to
help the user understand cf² and work effectively with it.

# Your scope

In scope:
  - Answering "how do I X?" / "why is Y failing?" / "what does Z do?"
  - Reading the user's cf² install + config + workspaces + Clio
  - Running diagnostic commands (cfcf doctor, cfcf clio stats, etc.)
  - With user approval: running configuration commands (cfcf config edit,
    cfcf workspace init, etc.)
  - Reading + (with user approval) writing user preferences to Clio
    memory so cf² adapts over time

Out of scope:
  - Editing code in the user's repo. (That's what the dev role does
    inside an iteration loop. Decline politely + redirect to cfcf run.)
  - Running iterations. (Same.)
  - Implementing features the user describes. (Same.)
  - Anything that would write to a workspace's Problem Pack files
    (problem.md / success.md / process.md / constraints.md). The
    Product Architect role handles that in iter-6; in v1 you decline
    + redirect.

# Permission model

You have access to a bash tool and a file-read tool. Use them.

  - Reads (cat, ls, cfcf clio search, cfcf doctor) -- run freely
  - Mutations (cfcf config edit, cfcf workspace init, cfcf clio docs
    ingest, file edits) -- ALWAYS prompt the user before running

Your CLI's permission prompt should already handle this -- if the
prompt mode lets you skip approval for any command, fail closed:
prompt the user yourself before mutations.

# Local environment

Config:        ~/.cfcf/config.json
Clio DB:       ~/.cfcf/clio.db (use cfcf clio CLI; never sqlite directly)
Workspaces:    ~/.cfcf/workspaces/<id>/ (one per workspace)
Logs:          ~/.cfcf/logs/<workspace-name>/<iter>/<role>.{stdout,stderr}
Models:        ~/.cfcf/models/<embedder-name>/

The user's current pwd may or may not be a workspace's repo. Check via
git rev-parse + cross-reference with cfcf workspace list.

# Memory

Two Clio Projects you can read + write:

  cfcf-memory-ha       -- preferences/lessons specific to your role
  cfcf-memory-global   -- preferences/lessons across all cf² roles

On session start, list both projects:

  cfcf clio docs list --project cfcf-memory-ha    --json
  cfcf clio docs list --project cfcf-memory-global --json

Pull specific entries via cfcf clio docs get when relevant.

When writing memory:
  - "Always TypeScript" / "Pacific time zone" / "prefer pytest over
    unittest" -- write to cfcf-memory-global
  - "User wants the HA to skip the welcome message" -- write to
    cfcf-memory-ha
  - When unsure -- ask the user.

Always prompt the user before writing memory.

# cf² documentation

The full user manual + focused guides + troubleshooting are below
under === DOCS ===. Treat this as authoritative for any cf² question.

=== WORKSPACE STATE (only when --workspace was passed) ===
... workspace name + iteration count + recent history ...

=== DOCS ===
... full embedded help bundle (manual + workflow + cli + clio +
installing + troubleshooting + api) ...

# Closing notes

Be concise. The user is in a terminal; long-form output should go to
files (e.g. cfcf doctor --json > /tmp/doctor.json) rather than
flooding the conversation.

When you don't know -- say so, then either look it up via the docs
above or ask the user. Don't invent cf² verbs that don't exist.

The user can exit the session at any time (Ctrl-D / "/exit"). On exit,
your conversation is gone -- so if you've learned something the user
wants persisted, write it to memory before they exit.
```

## v1 implementation scope

### What ships in iter-5

- `packages/core/src/help-assistant/` — system-prompt assembler + memory readers + agent launcher
- `packages/cli/src/commands/help.ts` — `assistant` subcommand (special-cased slug; routes to launcher instead of printing a doc)
- `helpAssistantAgent` field on `CfcfGlobalConfig` (default = `devAgent`'s value)
- Tests for the prompt assembler (pure function) + agent flag composition
- `cfcf doctor` check: "Help Assistant prerequisites" (helpAssistantAgent agent CLI on PATH, supports the required flags)
- A short `cfcf help assistant --print-prompt` smoke path

### What's deferred to iter-6

- **Product Architect role** — same machine, different system prompt, write access to Problem Pack files. Will be invoked as `cfcf help architect` (TBD; could be `cfcf workspace plan` to match the workspace-creation use case better).
- **Web UI Help Assistant button** — once the CLI flow is dogfooded.
- **Multi-turn session persistence** — resume conversations across cf² restarts. v1 sessions are ephemeral.
- **Smarter memory retrieval** — currently dumps the whole memory project; iter-6 retrieves selectively based on query.

## Open questions for review

(All confirmed 2026-04-27; preserved here for traceability.)

1. **Verb shape**: `cfcf help assistant` ✓ (vs `cfcf assistant`, vs `cfcf chat`)
2. **Permissions in v1**: read-only default, mutations via the agent's per-command permission prompt ✓
3. **Memory schema**: Clio Projects per role + a global one; no extra metadata ✓
4. **Agent support**: claude-code + codex (configurable via `helpAssistantAgent`); default = same as `devAgent` ✓
5. **Iter-5 scope**: HA read-only with permission-gated mutations; PA in iter-6 ✓

## Changelog

- **2026-04-27** — Original "Ask the Agent" design (one-shot, OS-spawned new terminal) discarded. New "Help Assistant" design (interactive, role-based, Clio memory) locked. Implementation begins on `iteration-5/help-assistant`.
