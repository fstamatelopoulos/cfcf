# cf² User Manual

**cf²** (pronounced "cf square", also written **cfcf** — Cerefox Code Factory — in source code, CLI commands, and package names) is a deterministic orchestration harness that runs AI coding agents in iterative loops. It is **not** an AI agent itself — it's the plumbing that manages agent lifecycles, context assembly, evaluation, and iteration control.

This page is the entry point. It explains the concepts in 3 minutes, points you at the focused guide for whatever you're trying to do, and covers the two topics that don't fit any other guide: **shell completion** and **troubleshooting**.

> **Looking for the version on disk?** After install, `cfcf help` prints this same content. `cfcf help <topic>` opens a focused guide (e.g. `cfcf help workflow`). The CLI command stays `cfcf` everywhere — `cf²` is the human-readable form, `cfcf` is the keystroke-friendly form.

---

## In one minute

```bash
# 1. Install (macOS / Linux). Bootstraps Bun + npm if missing.
curl -fsSL https://github.com/fstamatelopoulos/cfcf/releases/latest/download/install.sh | bash

# 2. Configure (interactive — picks dev/judge/architect agents + embedder)
cfcf init

# 3. Start the server (the API + web UI live here)
cfcf server start

# 4. Register your first workspace
cfcf workspace init --repo /path/to/your/repo --name my-project

# 5. Define the problem -- two paths:
#    a. Interactive (recommended): the Product Architect drafts + iterates with you
cd /path/to/your/repo
cfcf spec
#    b. Manual: edit the four files yourself
$EDITOR problem-pack/problem.md problem-pack/success.md problem-pack/constraints.md

# 6. (Optional) Solution Architect review before the loop
cfcf review --workspace my-project

# 7. Run the loop
cfcf run --workspace my-project
```

The full walkthrough — concepts, what each agent does, how the Problem Pack works, when to intervene — is in [`workflow.md`](workflow.md).

---

## What problem cf² solves

You want to put an AI coding agent on a long-running task and walk away. Today, that's hard:

- A single agent run drifts off track over many hours.
- You can't tell whether iteration N improved or regressed without reading every commit.
- Debugging a stuck loop means scrolling through thousands of lines of agent output.
- You can't compose multiple agents (one writes, one reviews) without bespoke glue.

cf² is the harness. It commits work in deterministic three-step iterations (dev → judge → reflect-when-needed), enforces a Problem Pack the agents must satisfy, runs a Solution Architect review on demand, and gives you a web UI to watch the loop without reading raw transcripts.

**You are NOT in the loop. You are ON the loop.** cf² only pings you at fixed intervals or when reflection flags `recommend_stop`.

---

## Concepts

### Workspace

A cfcf-managed project. Each workspace points at one git repo and has its own iteration counter, history, agents, and config. List them: `cfcf workspace list`. Show one: `cfcf workspace show <name>`.

### Problem Pack

Markdown files in `<repo>/problem-pack/` that define what you want the agents to build. The four canonical files are `problem.md`, `success.md`, `process.md`, `constraints.md`; plus optional `hints.md`, `style-guide.md`, `context/*.md`. The dev / judge / Solution Architect / reflection / documenter agents treat these as **read-only inputs**. You own them — author manually OR via `cfcf spec` (the interactive [Product Architect](product-architect.md)). cfcf-generated artifacts live separately under `<repo>/cfcf-docs/` (iteration logs, plan, decision log, etc.) — those cfcf manages on your behalf.

### Iteration

One round of dev-agent work + judge-agent assessment. Three commits per iteration when reflection runs:

1. `cfcf iteration N dev (...)` — the dev agent's code change
2. `cfcf iteration N judge (...)` — the judge agent's verdict
3. `cfcf iteration N reflect (<health>): <observation>` — the reflection agent's strategic note (only when triggered)

### Seven agent roles (five non-interactive + two interactive)

The five non-interactive roles run inside the iteration loop or on `cfcf <verb>` invocations — fire-and-forget, signal-file workflow:

| Role | When | What it does |
|---|---|---|
| **dev** | Every iteration | Reads the Problem Pack + recent history, produces one phase of the implementation, commits |
| **judge** | Every iteration | Assesses the dev's work against success criteria; emits a verdict + signal file |
| **architect** (Solution Architect) | On demand (`cfcf review`) | Reviews the Problem Pack + workspace state; either flags it READY for the loop or lists gaps |
| **reflection** | Triggered (`cfcf reflect` or auto on judge stalls) | Cross-iteration strategic review; can recommend stopping or refining the plan |
| **documenter** | Post-success (`cfcf document`) | Writes the final user-facing docs once SUCCESS is signalled |

The two interactive roles take over your shell — TUI on, agent CLI handles input until you exit:

| Role | When | What it does |
|---|---|---|
| **Product Architect** | `cfcf spec` | Interactive Problem Pack authoring + iteration; drives `git init` / `cfcf workspace init` if needed; helps refine specs before/after loops. See [`product-architect.md`](product-architect.md). |
| **Help Assistant** | `cfcf help assistant` | Interactive cf² support — answers "how does X work?", reads your Clio memory, runs diagnostics. Read-only by default unless you ask. |

Each role is independently configurable (adapter + model). The defaults are set in `cfcf init`. PA's prompt embeds the full cfcf docs (~190 KB) so it's a domain expert on cf² out of the box; HA does the same. See [`docs/decisions-log.md`](../decisions-log.md) → "2026-04-29 — Embed the full cfcf docs into interactive role agents' system prompts" for the rationale.

### Clio Project

A grouping of workspaces that share knowledge. Clio is cfcf's persistent memory layer (`~/.cfcf/clio.db`); search across workspaces with `cfcf clio search "<query>"`. New users typically have one Clio Project; advanced users group workspaces by domain (`backend-services`, `data-platform`, etc.). See [Clio quickstart](clio-quickstart.md).

### Server / web UI

`cfcf server start` boots a local Hono server (default port `7233`) that hosts the HTTP API and a React web UI. Most cfcf CLI commands hit this server. The web UI is the easiest way to watch the loop in real time — `http://127.0.0.1:7233` after start.

### Pause actions

When the loop pauses, you can resume with one of five structured actions (`continue` / `finish_loop` / `stop_loop_now` / `refine_plan` / `consult_reflection`) instead of a bare "Resume." Each action routes the harness — and any free-text feedback you provide — to a different destination. See [Workflow → User actions at pause points](workflow.md#user-actions-at-pause-points) for the full table and CLI examples.

---

## Where to go next

| If you want to… | Read |
|---|---|
| **Install or upgrade cf²** | [`installing.md`](installing.md) |
| **Run your first loop end-to-end** | [`workflow.md`](workflow.md) — the canonical user guide |
| **Author or refine your Problem Pack interactively** | [`product-architect.md`](product-architect.md) — the `cfcf spec` reference |
| **Look up a specific CLI command** | [`cli-usage.md`](cli-usage.md) — verb-by-verb reference |
| **Get started with Clio (cross-workspace memory)** | [`clio-quickstart.md`](clio-quickstart.md) |
| **Wire cf² into your own automation** | [`../api/server-api.md`](../api/server-api.md) — HTTP API |
| **Diagnose something that's not working** | [Troubleshooting](#troubleshooting) (below) or [`troubleshooting.md`](troubleshooting.md) |
| **Set up shell tab-completion** | [Shell completion](#shell-completion) (below) — auto-installed in v0.13+ |
| **Understand cf²'s architecture** | [`../design/technical-design.md`](../design/technical-design.md) |
| **See what's planned next** | [`../plan.md`](../plan.md) — living roadmap |

---

## Shell completion

`cfcf` ships with bash + zsh tab-completion. **It's auto-installed on every `cfcf` install/upgrade** — there's no manual step. You only need to:

1. Open a new terminal (or `exec zsh` / `exec bash` in the current one) after install
2. Restart `cfcf server` if it was running (the new server picks up any verb tree changes)

Both reminders appear in the post-install banner so you don't miss them.

### What auto-installed means

The installer (or `cfcf self-update`, or the `bun install -g` postinstall hook) runs `cfcf completion install` for you. That command:

1. Writes the completion script to a canonical path:
   - **bash**: `~/.cfcf-completion.bash`
   - **zsh**: `~/.zsh/completions/_cfcf`
2. Appends a sentinel-marked block to your `~/.zshrc` or `~/.bashrc`:

```zsh
# >>> cfcf shell completion (managed by `cfcf completion install`) >>>
fpath=(~/.zsh/completions $fpath)
autoload -U compinit && compinit
# <<< cfcf shell completion <<<
```

**cf² only modifies content between the `>>>` and `<<<` markers.** The rest of your rc file is byte-for-byte preserved. Delete the block to opt out.

If you already have your own `fpath=(~/.zsh/completions ...)` line outside our sentinels, cf² detects it and **leaves your rc alone** (action: `skipped-manual`). cf² doesn't fight users who wired completion up themselves.

### Trying it

```bash
cfcf <TAB>            # → top-level commands
cfcf clio <TAB>       # → docs metadata projects embedder search audit reindex stats
cfcf clio docs <TAB>  # → list ingest get edit delete restore versions
cfcf clio doc<TAB>    # → completes to "docs"
```

### If tab doesn't fire after install

That's the most common issue. See [troubleshooting.md → "Tab completion doesn't work"](troubleshooting.md#tab-completion-doesnt-work). 90% of the time the fix is `rm ~/.zcompdump*; exec zsh`.

### Opting out

```bash
cfcf completion uninstall   # removes the rc block AND the completion script
```

Or delete the sentinel-marked block from your rc file by hand. Symmetric.

### Supported shells + platforms

| | bash | zsh | fish | PowerShell |
|---|---|---|---|---|
| **macOS** | ✓ | ✓ | not supported | n/a |
| **Linux** | ✓ | ✓ | not supported | n/a |
| **Windows native** | not supported — cf² doesn't ship for native Windows. Use WSL | | | |

Fish completion is tracked as a future addition. PowerShell isn't planned (cfcf's runtime requirement is Bun, which has limited Windows support and no PowerShell-completion convention we can target).

For full CLI details on the `cfcf completion` subcommands, see [cli-usage.md → Shell completion](cli-usage.md#shell-completion).

---

## Troubleshooting

The full troubleshooting page is [`troubleshooting.md`](troubleshooting.md). Quick links to the most-asked questions:

- [Tab completion doesn't work after install](troubleshooting.md#tab-completion-doesnt-work)
- [`cfcf server start` fails or hangs](troubleshooting.md#cfcf-server-wont-start)
- [`cfcf init` can't download the embedder](troubleshooting.md#cfcf-init-fails-to-download-the-embedder)
- [Iteration is stuck / agent timed out](troubleshooting.md#iteration-stuck-or-agent-timeout)
- [Clio search returns nothing](troubleshooting.md#clio-search-returns-nothing)
- [`bun install -g` warns about duplicate keys](troubleshooting.md#bun-install--g-warns-about-duplicate-keys)
- [oh-my-zsh / prezto / starship breaks completion](troubleshooting.md#oh-my-zsh--prezto--starship)

When in doubt, run `cfcf doctor` first. It checks your install across 13+ dimensions (Bun runtime, native libs, agent CLIs, Clio DB, shell completion wiring, …) and emits actionable hints for anything that's off.

---

## Glossary

- **Adapter** — the cfcf-side wrapper that knows how to launch a specific agent (e.g. `claude-code`, `codex`). Adapters live in `packages/core/src/adapters/`. New ones can be added without touching the core loop.
- **`<repo>/problem-pack/`** — directory inside your repo holding the user-owned Problem Pack files (`problem.md` / `success.md` / `constraints.md`, optional `hints.md` / `style-guide.md` / `context/*.md`). You author these manually or via `cfcf spec` (the [Product Architect](product-architect.md)).
- **`<repo>/cfcf-docs/`** — directory inside your repo where cfcf writes its own per-iteration artifacts (`iteration-logs/`, `iteration-handoffs/`, `iteration-reviews/`, `reflection-reviews/`, `plan.md`, `decision-log.md`, `iteration-history.md`, `clio-relevant.md`, `clio-guide.md`). cfcf manages these; you don't edit them.
- **`<repo>/.cfcf-pa/`** — Product Architect's working cache (per session log + workspace summary + meta.json). PA writes here turn-by-turn during sessions. Gitignore-friendly.
- **Clio** — cf²'s persistent memory layer at `~/.cfcf/clio.db`. SQLite-backed, FTS5 + ONNX embedder hybrid search, scoped by named Clio Project. Independent of any specific workspace.
- **Dark factory loop** — the unattended mode where `cfcf run` cycles iterations until SUCCESS, FAILURE, or `recommend_stop`. Distinguished from "manual mode" where the user advances one iteration at a time.
- **Iteration history** — `cfcf-docs/iteration-history.md`. Rebuilt from per-iteration log files on every iteration so it survives server restarts.
- **Problem Pack** — the user-owned Markdown files in `<repo>/problem-pack/` (`problem.md` / `success.md` / `constraints.md`, plus optional `hints.md` / `style-guide.md` / `context/*.md`) that define the work the dev agent does. Read by every agent on every iteration. Author manually OR via `cfcf spec`.
- **Product Architect (PA)** — the interactive `cfcf spec` role: an LLM agent that helps you author + iterate the Problem Pack. Has the full cf² docs in its prompt, runs in your shell, owns the front of the SDLC. Peer to dev/judge/SA/reflection/documenter; runs interactively rather than fire-and-forget. See [`product-architect.md`](product-architect.md).
- **Help Assistant (HA)** — the interactive `cfcf help assistant` role: a cf²-expert support agent. Same architecture as PA but scoped to "help me operate cf²" rather than "help me define a project". See `cfcf help assistant` after install.
- **Readiness gate** — an optional step before `cfcf run` enters the loop, where the Solution Architect must say READY. Gated by the `readinessGate` config flag.
- **Sentinel block** — a `>>> ... <<<` (or `<!-- begin --> ... <!-- end -->`) marked region in a user-owned file (`CLAUDE.md`, `~/.zshrc`, etc.) that cf² manages. cf² writes only between the sentinels; everything else is preserved.
- **Workspace** — a cf²-registered project (one git repo per workspace). Per-workspace state lives at `<cfcf-config-dir>/workspaces/<id>/`.

---

## Getting help

1. `cfcf doctor` — first stop for "something's off"
2. [`troubleshooting.md`](troubleshooting.md) — common issues + fixes
3. [`../plan.md`](../plan.md) — what's planned next; check here before filing an issue (the work might already be tracked)
4. [GitHub issues](https://github.com/fstamatelopoulos/cfcf/issues) — file a new one if you've ruled out the above

---

## Versioning

cf² follows [SemVer](https://semver.org/). The current line is `0.x.y`:

- `0.<minor>` bumps for new features (every plan-item ship)
- `0.<minor>.<patch>` for fixes
- `1.0.0` will be the first stable release; until then, breaking changes can land in any minor bump

`cfcf --version` and `cfcf server status` report the installed version. `cfcf self-update` upgrades in place.
