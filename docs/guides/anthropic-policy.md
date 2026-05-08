# Anthropic third-party-harness policy and cf² adapter strategy

This guide explains:

1. What Anthropic's January–April 2026 policy clarification said about subscription OAuth tokens and third-party tools.
2. Why cfcf's unattended iteration loop is the violation pattern the rule targets.
3. Why the interactive **Product Architect** + **Help Assistant** roles are within Anthropic's allowed scope.
4. Which adapter to pick for which role to stay on the safe side of the policy.
5. How to set up the local-ollama compliant path end-to-end.

> **TL;DR.** Use `claude-code` only for **interactive roles** (Product Architect, Help Assistant, manually-invoked Solution Architect). For the unattended iteration loop (dev / judge / reflection / documenter — plus architect when `autoReviewSpecs=true`), use one of: `codex`, `claude-code-ollama`, `opencode-ollama`, or `opencode` (direct, with your own provider auth). cfcf surfaces a warning at `cfcf init` time when this rule is violated; this guide explains why.

---

## What Anthropic said

Across the **January 2026** OAuth-token block, the **February 2026** written clarification, and the **April 2026** Boris Cherny X post, Anthropic landed on a single rule:

> _"Using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any other product, tool, or service — including the Agent SDK — is not permitted and constitutes a violation of the Consumer Terms of Service."_ — Anthropic, February 2026 clarification

The underlying Consumer Terms §3.7 already prohibits accessing the Services "through automated or non-human means" except via an Anthropic API key (or where Anthropic explicitly permits it). The 2026 clarification connects that abstract rule to a concrete pattern: **subscription OAuth token in a non-Anthropic-managed harness** is the prohibited combination.

The rule targets **the credential**, not the headless-vs-interactive pattern itself. But in practice the most common violation pattern is "headless `claude -p` running under a subscription OAuth token from inside a third-party tool" — which is exactly what cfcf does for its unattended dev / judge / reflection / documenter roles.

### What stays allowed

- Interactive `claude` CLI use under a Pro/Max subscription (you typing into the TUI, hitting Enter on prompts).
- Anthropic's first-party Routines feature (cron / API / GitHub triggers running on Anthropic-managed infrastructure — subscription-billed by Anthropic itself).
- CI on **your own** repository using `CLAUDE_CODE_OAUTH_TOKEN` (community guides + Claude Code GitHub Actions docs).
- The Anthropic Agent SDK with proper API-key authorisation.

### What's prohibited

- Any third-party harness (cfcf included) consuming a subscription OAuth token in unattended / scripted execution.

### Why subscriptions weren't built for this (Anthropic's own framing)

Cherny's stated technical rationale: "Our subscriptions weren't built for the usage patterns of these third-party tools." Third-party harnesses bypass Claude Code's prompt-cache optimisations and exhibit token-consumption profiles the subscription pricing model wasn't designed around. The policy is the business response to that technical mismatch.

---

## OpenAI / Codex is materially different

OpenAI's Codex policy doesn't have an equivalent prohibition. The Codex pricing page **explicitly endorses the API-key path as "great for automation in shared environments like CI"**, and the CLI is documented as scriptable for non-interactive pipelines. Two-track auth: ChatGPT-sign-in for personal interactive use, API-key sign-in for automation. No published rule against third-party harnesses authenticating via API key.

cfcf's existing `codex` adapter therefore remains a fully compliant unattended path.

---

## Mapping to cf² roles

cfcf has seven roles. Three are **interactive** (the agent's TUI takes over your shell, you drive); four are **unattended** (cfcf spawns the agent in `-p` / `exec` / `run` mode and parses its output, no human in the loop). The mapping to Anthropic's allowed scope follows from there.

| Role | Mode | Allowed on Claude Code? | Why |
|---|---|---|---|
| **Product Architect** (`cfcf spec`) | Interactive | ✅ Yes | TUI takes over the shell; you drive the conversation. cfcf is acting as a launcher with a curated system prompt — same pattern as a config preset or slash command. |
| **Help Assistant** (`cfcf help assistant`) | Interactive | ✅ Yes | Same as PA — the TUI takes over your shell. |
| **Solution Architect** (`cfcf review`, manual) | Interactive | ✅ Yes | When invoked manually via `cfcf review`. |
| **Solution Architect** (when `autoReviewSpecs=true`) | Unattended | ⚠️ No | The architect runs at the start of `cfcf run` without you driving its TUI — same harness pattern as dev. Switch to a non-Claude-Code adapter or set `autoReviewSpecs=false`. |
| **Dev agent** | Unattended | ⚠️ No | Spawned per iteration in `-p` mode; you don't drive it. |
| **Judge agent** | Unattended | ⚠️ No | Same. |
| **Reflection agent** | Unattended | ⚠️ No | Same. |
| **Documenter agent** | Unattended | ⚠️ No | Auto-runs after a successful loop; same harness pattern. |

cf² will display an **inline warning** at `cfcf init` and `cfcf config edit` time when you pick `claude-code` for any of the four ⚠️ rows. It does NOT block the choice — running Claude Code for limited testing on small tasks is fine and the policy is something the user owns. The warning exists so you don't pick it accidentally.

---

## Recommended adapters per role (default config)

| Role | Recommended adapter | Why |
|---|---|---|
| **Product Architect** | `claude-code` | Interactive, allowed scope. Opus-class model is worth the spend on spec authoring. |
| **Help Assistant** | `claude-code` | Interactive, allowed scope. A smaller Sonnet/Haiku model is fine here — most queries are quick. |
| **Solution Architect** (manual) | `claude-code` | Manually invoked, you drive. |
| **Dev agent** | `claude-code-ollama` (or `codex`) | Compliant unattended path. Opencode-ollama works equally well if you prefer opencode's UX. `codex` is the OpenAI-API path. |
| **Judge agent** | `codex` (or `claude-code-ollama` if dev is `codex`) | "Different agent than dev" is the historical recommendation; either compliant path is fine. |
| **Reflection agent** | `claude-code-ollama` (or `codex`) | Strongest reasoning available on the unattended path. |
| **Documenter agent** | `claude-code-ollama` (or `codex`) | Compliant unattended path. |

You can mix and match freely — these are recommendations for first-run defaults, not enforced by cfcf.

---

## Setting up the local-ollama path

This is the recommended setup for a fully self-hosted unattended pipeline.

### 1. Install ollama

```bash
# macOS (with Homebrew)
brew install ollama

# Linux
curl -fsSL https://ollama.com/install.sh | sh

# Verify
ollama --version
```

### 2. Pull a model (or several)

Coding-grade models that work well as iteration drivers:

```bash
# Smaller / faster (good for judge, documenter)
ollama pull qwen2.5-coder:14b

# Mid-size (good for dev, reflection)
ollama pull qwen2.5-coder:32b
ollama pull deepseek-coder-v2:16b

# Larger (best quality, needs ~64+ GB RAM or a serious GPU)
ollama pull llama3.3:70b
ollama pull qwen2.5-coder:72b
```

`ollama list` confirms what's pulled; cfcf surfaces this list as the model picker for `*-ollama` adapters.

### 3. Confirm `ollama launch` works

`ollama launch` is the subcommand that routes a coding agent CLI through ollama:

```bash
# Test the wrapping (interactive)
ollama launch claude --model qwen2.5-coder:32b

# Test the unattended pattern cfcf uses
ollama launch claude --model qwen2.5-coder:32b --yes -- -p "say hello"
```

The `--` separator is mandatory: arguments before it are parsed by ollama, arguments after are passed through to the wrapped agent CLI unchanged. The `--yes` flag skips ollama's interactive selectors — required for unattended runs.

### 4. Configure cfcf

Run `cfcf init` (first-run) or `cfcf config edit` (already configured). The agent picker will now include:

- `claude-code-ollama` — Claude Code via ollama
- `opencode-ollama` — Opencode via ollama
- `opencode` — Opencode standalone (you must `opencode auth login` separately for this to work)

Pick `claude-code-ollama` (or one of the alternatives) for dev / judge / reflection / documenter. Pick `claude-code` for Product Architect / Help Assistant.

### 5. Verify

```bash
cfcf doctor
cfcf config show
```

`cfcf doctor` reports the detected adapters + ollama state. `cfcf config show` prints the current per-role assignment.

---

## What cfcf does NOT do

- **cfcf does not install or manage ollama.** That stays your responsibility — install via brew/script, pull models, keep the daemon running. cfcf consumes whatever's on PATH.
- **cfcf does not auto-flip your config.** When you re-run `cfcf init --force` after this release, your existing per-role choices are preserved. The warning fires; the choice is yours.
- **cfcf does not block Claude Code use for unattended roles.** The warning is informational. If you're running a one-off test on a small problem and accept the policy implication, nothing stops you. The warning is for the case where you've forgotten the policy exists.

---

## Background

For the framing of why cf² took this approach (vs. a Claude-Code-API-key path or a config-flag-on-the-existing-adapter approach), see `docs/decisions-log.md` 2026-05-07 — *Anthropic's third-party-harness policy → adapter expansion via `ollama launch` (item 6.28)*.
