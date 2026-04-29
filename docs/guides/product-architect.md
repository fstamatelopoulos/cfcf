# Product Architect (`cfcf spec`)

The **Product Architect (PA)** is cf²'s **interactive specs + setup assistant**. It runs the configured agent CLI in your shell, has the entire cfcf docs bundle in its system prompt, and helps you author + iterate the **Problem Pack** files (problem.md / success.md / process.md / constraints.md / hints.md / style-guide.md / context/) that drive the rest of the SDLC.

PA is a peer to dev / judge / Solution Architect / reflection / documenter — but unlike them, it's **interactive** (your shell) rather than fire-and-forget. It owns the **front of the cf² SDLC** — repo setup, workspace registration, spec authoring, spec iteration before/after loops.

## Quick start

```bash
cd /path/to/your/repo      # may be empty, or existing, or mid-flight
cfcf spec                  # PA introduces itself + assesses state + offers next steps
```

That's it. PA picks up from there, asking what you want to build, drafting spec files, running `git init` / `cfcf workspace init` if needed (with permission).

```bash
cfcf spec "Tighten the success.md auth criteria"   # opens with this task
cfcf spec --repo /elsewhere                        # explicit repo path
cfcf spec --safe                                   # opt back into per-command permission prompts
cfcf spec --print-prompt                           # debug: print assembled prompt + exit
```

## Where PA fits in the SDLC

```
git init && cd <repo>
cfcf workspace init   →   cfcf spec   →   cfcf review   →   cfcf run   →   cfcf reflect / cfcf document
                          ↑
                          PA: interactive Problem Pack authoring + iteration
```

`cfcf workspace init` and `cfcf review` are non-interactive. `cfcf spec` is the interactive front. PA can ALSO drive `cfcf workspace init` (non-interactively, with name elicited in conversation) if you launch on an unregistered repo.

## What PA can + can't do

### Primary scope (where PA spends most of its time)

- Repo setup (`git init` if missing — PA insists on this first)
- Workspace registration (`cfcf workspace init` — PA elicits the name in conversation, then runs the command non-interactively)
- Problem Pack authoring + iteration
- Problem Pack review (before `cfcf review` AND after loops, refining specs based on what reflection observed)
- Spec brainstorming — acting as a thoughtful product architect

### Secondary scope (allowed; PA encourages user-driven control)

- `cfcf server start`
- `cfcf run` — but PA strongly recommends you start the loop yourself in another terminal or the web UI for control + visibility
- Status checks (`cfcf workspace show`, `cfcf clio search`, `cfcf doctor`)
- Reading logs to understand prior iterations
- Answering general cf² questions (PA has the full docs in its prompt)

### Out of scope (PA hard-refuses + redirects)

- Writing code (→ "that's the dev role; run `cfcf run`")
- Designing architecture / writing `plan.md` (→ "that's the Solution Architect; run `cfcf review`")
- Reviewing iteration quality (→ "that's the judge inside the loop")
- Cross-iteration analysis (→ "run `cfcf reflect`")
- Writing final docs (→ "run `cfcf document`")

PA isn't a stubborn gatekeeper. The user CAN override after PA explains the redirect, but PA pushes back first.

## Permissions

By default PA runs with **full permissions** — same as the iteration-time agents. You accepted this trust contract at `cfcf init` (the `permissionsAcknowledged` flag); PA inherits it.

| Adapter | Default flags |
|---|---|
| claude-code | `--dangerously-skip-permissions` |
| codex | `-c approval_policy=never` + `-c sandbox_mode=danger-full-access` |

`sandbox_mode=danger-full-access` (codex) lifts the default loopback restriction so cfcf CLI commands that hit `localhost` (e.g. `cfcf workspace show`) work from inside the agent's bash tool.

Pass `--safe` to opt back into per-command prompts + the default sandbox for a single session. Useful for first-time users or risky changes.

## State assessment at launch

cfcf computes a snapshot of state BEFORE spawning the agent and injects it into the system prompt. The agent's first response is informed by this snapshot.

| Item | Source |
|---|---|
| Repo path | `--repo` or cwd |
| Git status | `<repo>/.git/` + `git log -1` |
| Workspace registration | `cfcf workspace list` matched by repoPath |
| cfcf server | pid file + liveness check |
| Iteration history | `cfcf-docs/iteration-history.md` if present |
| Problem Pack files | `<repo>/problem-pack/*.md` (size + first 4000 chars) |
| `.cfcf-pa/` cache | session files + workspace summary + meta.json |
| Memory inventory | Clio: per-workspace digest + per-session archives + global preferences + read-only other-role recent docs |
| `session_id` | UUID-style stamp generated at launch (e.g. `pa-2026-04-29T08-15-30-abc123`) |

PA's first response branches on this state:
- Not a git repo → INSIST on `git init` first
- Not a registered workspace → INSIST on `cfcf workspace init` first (collects name in conversation)
- Otherwise → recap from the memory digest + ask what to focus on this session

## Memory architecture

PA's memory model is a **three-tier** system. Understanding the tiers matters when interpreting what PA knows + where to look for detail.

| Tier | Where | Naming | Purpose | Compactable? |
|---|---|---|---|---|
| **A · Digest** | Clio | `pa-workspace-memory` (one per workspace, fixed title) | Rolling summary: current state + recent sessions verbatim + older sessions one-line + cumulative decisions/preferences. Injected into every PA prompt. | **YES** — gets shrunk in place when > 30 KB |
| **B · Archive** | Clio | `pa-session-<sessionId>` (one per session) | Full session transcript captured at save time. Listed in the prompt's Memory Inventory; full content fetched on demand. | **NEVER** — immutable canonical history |
| **C · Disk log** | `<repo>/.cfcf-pa/session-<sessionId>.md` | one per session | Live scratchpad written turn-by-turn during the session. Identical to Tier B but local + immediate. | **NEVER** — immutable canonical history |

Tiers B + C **together** give you redundant, durable, full history. Tier A is what gets compacted.

### Cross-machine + offline behaviour

- **Tier B (Clio)** travels with you across machines (cf²'s Clio DB syncs via export/import or a remote backend in the future).
- **Tier C (disk)** is local + immediate; useful when offline or for fast grep across past sessions.
- **Either alone is sufficient for full recovery.**

### The `pa-global-memory` doc (cross-workspace)

Separately from per-workspace memory, PA maintains a **single cross-workspace doc** in Clio:

| Doc | Project | Purpose |
|---|---|---|
| `pa-global-memory` | `cfcf-memory-global` (shared with HA) | User preferences spanning all workspaces (TDD, language preferences, "always vitest", etc.) |

Lives only in Clio (no local cache). PA reads it on every launch + updates it when a cross-cutting preference emerges in conversation.

### When does PA write?

- **After every user message**: append a brief turn entry to the disk session log (`<repo>/.cfcf-pa/session-<id>.md`). Non-negotiable. Disk writes are cheap; this gives you a complete transcript even if you Ctrl-D abruptly.
- **On a major decision / rejection / preference**: also update `<repo>/.cfcf-pa/workspace-summary.md` immediately.
- **At session end** (PA proactively asks "save before you go?"): ingest the disk session log to a Tier-B archive doc + update the digest + sync `meta.json`.
- **Cross-cutting preferences**: update `pa-global-memory` directly when they emerge.
- **Compaction** (digest > 30 KB at session start): PA offers; user approves. Digest gets shrunk in place; archives + disk are never touched.

### Where to find detail (when the digest isn't enough)

If the user asks PA about something the digest only summarises ("what did we decide about auth in iter 3?", "show me the full session from last Tuesday"), PA retrieves full detail from one of:

```bash
# Clio archive (multi-device durable):
cfcf clio docs get <pa-session-...id>          # the doc ID is in the prompt's Memory Inventory
cfcf clio search "<query>" --project cfcf-memory-pa

# Local disk (immediate, no network):
cat <repo>/.cfcf-pa/session-<sessionId>.md
ls <repo>/.cfcf-pa/session-*.md                # list all local sessions
grep -l "<phrase>" <repo>/.cfcf-pa/session-*.md
```

## PA in the workspace History tab (web UI)

Each PA session appears in your workspace's History tab as a `Product Architect` row, with status / agent / outcome columns. Click the expansion pill to open the **PA session detail panel**:

- Session bracket info (start/end/duration/exit code)
- Pre-state pills (git? workspace? problem-pack file count)
- Outcome summary (one-liner from `meta.json.lastSession.outcomeSummary`)
- Clio doc UUID (when synced)
- Tabbed body:
  - **Session log** — the disk session-`<id>`.md rendered as Markdown
  - **Workspace summary** — the local mirror of the digest
  - **meta.json** — the sync metadata

This works whether the session is currently running, completed, or failed (running sessions show "running" status until the agent exits).

## Session-end save protocol

When you signal you're wrapping up — either explicitly ("ok done", "let's stop") or implicitly (long pause; "thanks") — PA proactively asks:

> "Want me to save this session's work before you go?"

If yes, PA:

1. Finalises `<repo>/.cfcf-pa/session-<id>.md` with a closing summary
2. Updates `<repo>/.cfcf-pa/workspace-summary.md`
3. Ingests the session log to Clio as a `pa-session-<sessionId>` archive doc
4. Updates the `pa-workspace-memory` digest with this session's outcome
5. (If cross-cutting preferences emerged) updates `pa-global-memory`
6. Updates `<repo>/.cfcf-pa/meta.json` with the new sync timestamp + `lastSession` block

cfcf reads `meta.json.lastSession` after the agent exits to enrich the workspace-history entry with `outcomeSummary`, `decisionsCount`, and the Clio doc ID. That data shows up in the History tab + the detail panel.

## CLI flags

| Flag | Default | Effect |
|---|---|---|
| `--repo <path>` | `process.cwd()` | Repo path to operate on |
| `--agent <name>` | `config.productArchitectAgent.adapter` | Override the agent CLI for this session (claude-code, codex) |
| `--print-prompt` | off | Print the assembled system prompt (≈190 KB) + exit; don't launch |
| `--safe` | off (full perms) | Opt into per-command permission prompts + default sandbox |

## Configuration

`config.productArchitectAgent: AgentConfig` on the global config. Backfilled from `architectAgent` (broad-context profile) when missing. For claude-code, the model defaults to **Sonnet** (HA defaults to Haiku — PA's spec-iteration workload benefits from a stronger model). For codex, the model is account-tied; PA doesn't force one.

`cfcf init` will pick PA's agent during interactive setup (7th role). `cfcf config show` displays the row. Per-workspace overrides aren't supported in v1 — PA uses the global default for all workspaces.

## Integration with other roles

- **Solution Architect** (`cfcf review`): consumes the Problem Pack PA authored. Run `cfcf review` after PA + before `cfcf run` to get a readiness verdict + plan outline.
- **dev / judge / reflection**: consume the Problem Pack on every iteration. PA's job is to make their input clean.
- **HA** (`cfcf help assistant`): shares the `pa-global-memory` doc with PA. Cross-cutting preferences PA captures are visible to HA + vice versa.
- **Reflection**: PA reads `cfcf-memory-reflection` (read-only) when re-reviewing the Problem Pack post-loop. Knowledge of what reflection observed informs PA's spec refinements.

## Limitations + roadmap

- **CLI-only in v1.** Web UI button for "launch PA" is tracked as plan item 5.15 (research first).
- **Single-machine memory by default** — Clio is local SQLite. Multi-machine sync happens via the `cfcf clio` export/import surface (manual today; Cerefox-remote backend planned).
- **No PA fine-tuning or RAG.** PA gets its cf² expertise by having the full docs bundle in its system prompt at every launch (~190 KB). See [`docs/decisions-log.md`](../decisions-log.md) → "2026-04-29 — Embed the full cfcf docs into interactive role agents' system prompts".
- **No `--bootstrap` mode yet.** PA can drive `cfcf workspace init` mid-session today; a future flag may also handle `git init` + initial directory creation in one shot.

## Troubleshooting

See [`troubleshooting.md`](troubleshooting.md) for PA-specific issues. The most common ones:

- **PA reports "server is not running" but it IS running.** You're in `--safe` mode + codex's sandbox is blocking loopback. Either drop `--safe` (default mode lifts the sandbox) or trust the State Assessment in the prompt (it was computed from outside the sandbox).
- **PA's Memory Inventory says "no workspace memory" but I had a session yesterday.** Pre-v0.x.x, the agent's ingest may have auto-routed to the `default` Clio Project. Recent versions search project-agnostic by metadata, so this should resolve on next launch. If it persists, check `cfcf clio metadata search --filter '{"role":"pa","artifact_type":"workspace-memory"}'` for the doc.
- **Session ended without saving.** Disk session log at `<repo>/.cfcf-pa/session-<id>.md` is preserved (turn-by-turn writes). Next PA launch will detect the discrepancy + offer to push the unfinished session to Clio.

## Design baseline

- [`docs/research/product-architect-design.md`](../research/product-architect-design.md) — the canonical design doc (architecture, role framing, memory protocol, prompt structure)
- [`docs/research/help-assistant.md`](../research/help-assistant.md) — sibling design (HA established the role-based-agent pattern PA inherits)
- [`docs/decisions-log.md`](../decisions-log.md) — the "embed full cfcf docs" entry explains why this design works
- [`docs/plan.md`](../plan.md) → item 5.14 — the plan-tracker entry
