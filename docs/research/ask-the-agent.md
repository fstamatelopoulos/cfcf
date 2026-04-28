# Ask the Agent — design doc

**Status**: Design only (plan item 5.8 PR4). Implementation deferred to **iteration 6**.
**Date**: 2026-04-27
**Branch**: `iteration-5/user-manual` (this design ships alongside the user-manual + help-tab work; no code changes).

## 1. Why

cfcf ships with a user manual, focused guides, troubleshooting, and a Clio knowledge base — already a lot of surface area for someone to read. Most users will skim, then try things. When a user gets stuck:

- They don't know which guide has the answer.
- The answer might not exist (edge case, framework interaction, version-specific bug).
- They have an AI agent CLI sitting right there (`claude-code`, `codex`) that could read the docs + their workspace state and answer in seconds.

**The pitch**: cfcf already detects + manages the user's dev agent (it spawns one every iteration). When the user has a question, cfcf can:

1. Compose a system prompt containing the manual + relevant troubleshooting + workspace state
2. Launch the dev agent in a fresh terminal with that prompt + the user's question
3. The agent answers; the user reads, follows up, exits when done

No new agent integration. No bespoke chat UI. Just a thin glue between "a user has a question" and "the agent that already knows how to read context can answer it".

## 2. What it is — and isn't

### Is

- A **terminal launcher**. `cfcf ask "<question>"` (or a web UI button) opens a new terminal window running the configured dev agent with a curated system prompt + the user's question.
- A **best-effort context assembler**. cfcf knows what manual sections + troubleshooting entries + workspace history are relevant; it includes them as context so the agent doesn't have to fetch.
- A **convenience layer**, not a runtime dependency. `cfcf ask` exiting (or never being called) doesn't affect anything else — `cfcf` works fine without it.

### Isn't

- **Not a chat UI inside cfcf.** We don't build a streaming-response panel in the web UI. The agent has its own UI (Claude Code's TUI, Codex's TUI); we hand off to it.
- **Not an agent run.** The agent invoked via `cfcf ask` doesn't iterate, doesn't commit, doesn't touch the workspace. It's read-only Q&A.
- **Not a paid SaaS dependency.** The agent that answers is the user's own (already configured during `cfcf init` and used for every iteration). cfcf doesn't add an Anthropic / OpenAI dep beyond what's already there.
- **Not a "cfcf agent".** No new role. We reuse the dev agent's CLI binary; the system prompt makes clear it's in Q&A mode for cfcf usage questions.

## 3. UX

### CLI

```bash
cfcf ask "Why is my iteration stuck on phase=judging?"
```

Concrete behaviour:
1. cfcf detects which dev agent is configured (`config.devAgent` — `claude-code` or `codex`)
2. Composes a system prompt (see §4) with the manual, troubleshooting, recent workspace state
3. Launches a new terminal window running:
   ```bash
   claude-code --append-system-prompt "<system prompt>" "<user question>"
   ```
   (or the codex equivalent)
4. Returns control to the user immediately; the agent owns the new terminal until exit

**Flag matrix** (all optional):

```
cfcf ask <question> \
    [--workspace <name>]          # include this workspace's recent state in the prompt
    [--topic <slug>]              # restrict the manual context to one help topic
    [--agent claude-code|codex]   # override config.devAgent
    [--print-prompt]              # print the assembled prompt + exit; don't launch
```

`--workspace` is the most useful flag in practice — most "why is X happening?" questions are about a specific workspace's state.

`--print-prompt` is the debug / power-user escape hatch. Lets users see what would be sent + tweak it before running.

### Web UI

A small **Ask the Agent** button on each page (top bar? floating action button on the bottom-right?). Click → opens a textarea modal. The user types their question. cfcf POSTs to `/api/ask` which composes the prompt + spawns the terminal. The web UI is stateless; the agent answers in the new terminal, not in the browser.

The web UI's contribution is **context implicitly attached**: if the user clicks Ask while on `WorkspaceDetail`, the workspace ID is captured automatically. Same on `Help` page → topic captured.

### Terminal launcher

We need a way to spawn the agent in a new terminal window from the CLI. Options:

- **macOS**: `open -a Terminal "<command>"` or `osascript` for fancier control. iTerm has its own URL scheme.
- **Linux**: `gnome-terminal -- <command>` / `xterm -e <command>` / `konsole --hold -e <command>` — varies wildly by environment.
- **Both**: `tmux` if the user has it (`tmux new-window -d <command>`).

**Heuristic**: detect the terminal emulator from `$TERM_PROGRAM` (macOS) or `$XDG_CURRENT_DESKTOP` (Linux) and pick the right launcher. Fall back to printing the assembled command and asking the user to run it.

## 4. The system prompt

The agent receives:

```
You are answering a question about cfcf (Cerefox Code Factory, "cf squared"),
a deterministic harness that runs AI coding agents in iterative loops.
You are NOT the agent that runs cfcf's iterations -- you're answering a
user's usage question. Read-only Q&A; do not modify any files unless the
user explicitly asks.

The user's question is at the bottom of this prompt.

==== cfcf user manual ====
<contents of manual.md>

==== topic context ====
<contents of the topic the user is most likely asking about, picked
from cli/clio/troubleshooting/installing/api/workflow>

==== current workspace state (if --workspace was provided) ====
- workspace name: <name>
- repo path: <path>
- iteration count: <N>
- current phase: <phase>
- last 3 iteration summaries: <text>
- recent decision-log entries (last 5): <text>

==== user question ====
<user input>
```

The "topic context" is picked using a tiny heuristic: keyword match on the user's question against each topic's title + first paragraph. Top 1-2 topics get included; everything else is referenced by slug only.

**Why include the manual at all?** The agent's training cutoff doesn't include cfcf-specific concepts. Without the manual, the agent guesses at "what cfcf is" and often hallucinates verbs. With the manual, it has authoritative grounding.

**Token cost**: manual.md is ~12 KB, troubleshooting.md is ~13 KB. Well within any modern model's context window. Even at $5/M tokens, a single Ask costs < $0.10.

## 5. Implementation sketch

This is **NOT** a commitment to ship in iter 6 — it's a sketch so the design has resolution.

### Files

- `packages/core/src/ask/prompt-assembler.ts` — pure function: `assembleAskPrompt({ question, workspaceState?, topicSlugs[] }) → string`. Reads from the existing help-content bundle (`packages/core/src/help.ts`). Pulls workspace state via the existing `getWorkspaceHistory` / `getProcessSnapshot` helpers.
- `packages/core/src/ask/terminal-launcher.ts` — pure function (best-effort): `launchInTerminal({ command, args[] }) → { launched: boolean; method: string }`. Tries the platform-appropriate launcher; falls back to printing the command for the user to run.
- `packages/cli/src/commands/ask.ts` — the `cfcf ask` CLI command. Action: call assembler → call launcher.
- `packages/server/src/routes/ask.ts` — `POST /api/ask` for the web UI to call. Returns either `{ launched: true, terminal: "iterm2" }` or `{ launched: false, command: "..." }` so the UI can offer copy-paste fallback.
- `packages/web/src/components/AskButton.tsx` — top-bar button + modal. Captures workspace context from `useRoute`.

Total: ~400 LOC + tests.

### Risks / open questions

1. **Terminal launching is OS-fragile.** On Linux, the user might be in a non-X11 session (Wayland, or a remote SSH session with no DISPLAY). Detection + fallback matters.
2. **What if the agent CLI hangs?** The launched terminal is decoupled from cfcf; if `claude-code` hits a network issue and waits forever, that's the agent's terminal, not cfcf's. Acceptable.
3. **Privacy.** The system prompt includes recent workspace state. If a user runs `cfcf ask` against a workspace with secrets in its history, those secrets get sent to the agent's API. **Mitigation**: workspace state is only included when `--workspace` is explicitly passed; never in the default prompt. Document loudly.
4. **Authentication.** The dev agent CLI is already authenticated via the user's `claude-code` / `codex` setup. cfcf doesn't add a new auth surface.
5. **Cost.** Each `cfcf ask` call costs the user real API tokens. Should we cap (one Ask per minute? prompt confirmation if context is huge?). Probably not — defer to the user to manage their own usage. cfcf already runs the agent for iterations; another Q&A call is rounding error.
6. **Multi-turn?** The first version is one-shot: cfcf launches the agent with the question, agent answers, user reads, exits. If the user wants follow-up, they re-run `cfcf ask`. Multi-turn would require tracking conversation state — out of scope for v1.

### What v1 explicitly skips

- Streaming responses to a cfcf-rendered UI (we hand off to the agent's TUI; no browser-side UI)
- Context manipulation (user can't add/remove sections from the prompt — they take what cfcf assembles or use `--print-prompt` to see + reformulate)
- Persistent conversation history (each Ask is fresh)
- Custom agent prompts beyond cfcf's curation (advanced users edit `packages/core/src/ask/prompt-assembler.ts` and rebuild — not a config knob)

These are real capabilities to add once v1 ships and we know what users actually want.

## 6. Why deferred to iter 6

Three reasons.

1. **Validate v1 first.** The user manual + help bundle just shipped. Watch how users (us, dogfood, then external) actually use the docs. If `cfcf help` + the web UI Help tab are sufficient for 80% of questions, Ask-the-Agent is a small remaining slice. If the docs themselves are wrong, fix those before building a fancier delivery.

2. **Terminal-launching surface is bigger than it looks.** OS detection + fallback chains across macOS Terminal / iTerm2 / Linux gnome-terminal / konsole / tmux / SSH-no-display is its own project. Better to scope it intentionally than pile it onto the manual PR.

3. **Iter 6 is the right home anyway.** Iter 6 is when we audit the rest of the cfcf CLI surface (workspace, run, review, etc.) for verb normalisation. Adding `cfcf ask` lands naturally in the same lens — it's a top-level verb, single-noun, follows the three-clause rule from `cli-verb-normalisation.md`.

## 7. Open questions for review

(For the user, before we promote this to an iter-6 plan item.)

1. **CLI verb name**: `cfcf ask`? `cfcf chat`? `cfcf q`? `cfcf help --ask`? My preference: `cfcf ask` — short, distinct from `cfcf help` (which prints docs), conveys intent.
2. **Default scope**: should `cfcf ask` (no flags) include the current workspace's state by default? My lean: **no** — defaults stay minimal; `--workspace` is opt-in to keep secrets out of the default prompt.
3. **Web UI button placement**: top bar (always visible)? Per-page floating action? Help tab only?
4. **Token budget guard**: warn the user if the assembled prompt exceeds N tokens? At what N?
5. **Ship in 6.0 vs 6.x**: high-priority for iter 6 or a back-pocket item if the user manual lands users in a good place?

## 8. Decision

**Defer to iter 6.** Promote to a tracked plan item under iteration 6 (likely 6.25 or similar) once the user-manual PR is merged + dogfooded for a week. This document stands as the design baseline; the iter-6 implementation should re-read it and update where assumptions changed.
