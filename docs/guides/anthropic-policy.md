# Anthropic third-party-harness policy and cf² adapter strategy

This guide covers two related topics that together drive cf²'s adapter recommendations:

1. **Anthropic's policy on Claude Code in third-party harnesses** — why direct `claude-code` (talking to Anthropic's API/subscription) is restricted to interactive roles only, and why `claude-code-ollama` (local ollama models) is policy-clean and OK anywhere.
2. **Log visibility during unattended runs** — `claude -p` (used by both `claude-code` AND `claude-code-ollama`) buffers stdout for the entire run. This is a UX concern, not a correctness one, but it changes which adapter is best for unattended roles where you want to watch progress.

> **TL;DR — recommended setup.**
> - **Interactive roles** (Product Architect via `cfcf spec`, Help Assistant via `cfcf help assistant`): **`claude-code` is the recommended choice.** TUI takes over your shell (`stdio: "inherit"`); no policy issue, no log-visibility issue.
> - **Unattended roles** (dev / judge / reflection / documenter / Solution Architect — including manual `cfcf review`, since the architect is always spawned headlessly with `-p` regardless of how it's invoked; item 6.30 correction):
>     - **First choice**: `codex` — streams progress live to the log file, policy-clean, fast setup.
>     - **Alternatives**: `opencode-ollama` / `opencode` — also stream live, also policy-clean.
>     - **Works but silent during run**: `claude-code-ollama` — uses local ollama models with Claude's UX. Same `-p` stdout buffering as direct claude-code: log file stays empty until the agent exits, then dumps the final response. Pick this if you prefer Claude's tool-call format / instruction-file conventions and don't need live monitoring.
>     - **Avoid**: `claude-code` (direct) — violates Anthropic's third-party-harness policy on top of the buffering.
>
> cf² surfaces warnings at `cfcf init` / `cfcf config edit` and in the web UI when `claude-code` is picked for an unattended role (yellow callout, policy-grade), an info note when `claude-code-ollama` is picked (blue callout, API-parse-error caveat for non-coder models — item 6.30), and a second info note about log-visibility (also blue, applies to claude-code-ollama universally). None of them block the choice — you can still proceed.

---

## What Anthropic said

Across the **January 2026** OAuth-token block, the **February 2026** written clarification, and the **April 2026** Boris Cherny X post, Anthropic landed on a single rule:

> _"Using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any other product, tool, or service — including the Agent SDK — is not permitted and constitutes a violation of the Consumer Terms of Service."_ — Anthropic, February 2026 clarification

The underlying Consumer Terms §3.7 already prohibits accessing the Services "through automated or non-human means" except via an Anthropic API key (or where Anthropic explicitly permits it). The 2026 clarification connects that abstract rule to a concrete pattern: **subscription OAuth token in a non-Anthropic-managed harness** is the prohibited combination.

The rule targets **the credential**, not the headless-vs-interactive pattern itself. But in practice the most common violation pattern is "headless `claude -p` running under a subscription OAuth token from inside a third-party tool" — which is exactly what cfcf does for its unattended dev / judge / reflection / documenter / architect roles.

### What stays allowed

- Interactive `claude` CLI use under a Pro/Max subscription (you typing into the TUI, hitting Enter on prompts).
- Anthropic's first-party Routines feature (cron / API / GitHub triggers running on Anthropic-managed infrastructure — subscription-billed by Anthropic itself).
- CI on **your own** repository using `CLAUDE_CODE_OAUTH_TOKEN` (community guides + Claude Code GitHub Actions docs).
- The Anthropic Agent SDK with proper API-key authorisation.
- **Claude Code under `ANTHROPIC_API_KEY` auth** (paid API access, billed per-token rather than per-month). This is the canonical "automation under your own credentials" pattern; see the next section.

### What's prohibited

- Any third-party harness (cfcf included) consuming a **subscription OAuth token** in unattended / scripted execution.

### Why subscriptions weren't built for this (Anthropic's own framing)

Cherny's stated technical rationale: "Our subscriptions weren't built for the usage patterns of these third-party tools." Third-party harnesses bypass Claude Code's prompt-cache optimisations and exhibit token-consumption profiles the subscription pricing model wasn't designed around. The policy is the business response to that technical mismatch.

---

## Compliant `claude-code` adapter use via the API key

The cfcf `claude-code` adapter is **not categorically prohibited** — it's the *credential* that determines compliance, not the adapter. Two auth paths to claude-code:

| Auth path | How to set it up | Policy |
|---|---|---|
| **Subscription OAuth** (default after `claude /login`) | Pro/Max sub + `claude` opens a browser → you log in → an OAuth token gets stored under `~/.claude/`. | ⚠️ Prohibited in unattended cfcf roles. |
| **API key** | Set `ANTHROPIC_API_KEY=<your-key>` in the env that `cfcf server start` runs in. claude-code auto-routes to the API path when this var is present. | ✅ Compliant. Same pattern as the Agent SDK. |

**To use claude-code on unattended cfcf roles compliantly**:

```bash
# In your shell config (~/.zshrc, ~/.bashrc) or a per-project .envrc:
export ANTHROPIC_API_KEY="sk-ant-..."

# Start the cfcf server in this shell so the var is inherited:
cfcf server start

# Now any role configured with the `claude-code` adapter will use the
# API key — every spawned `claude -p` inherits ANTHROPIC_API_KEY from
# cfcf's process env.
```

The cfcf inline warning + CLI banner DO appear when you pick `claude-code` for an unattended role (cfcf can't tell at config-save time which credential the env will carry at run time). The warning's wording explicitly says the API-key path is exempt — so you can dismiss the warning if you've set the env var.

**Pricing trade-off**: API-key auth is per-token billing (no flat-rate cap). For an iteration loop running multiple iterations a day, costs can add up faster than a Pro/Max subscription. If you want flat-rate predictability without the policy issue, the alternative-adapter route (`codex`, `claude-code-ollama`, etc.) is usually cheaper at scale.

---

## OpenAI / Codex is materially different

OpenAI's Codex policy doesn't have an equivalent prohibition. The Codex pricing page **explicitly endorses the API-key path as "great for automation in shared environments like CI"**, and the CLI is documented as scriptable for non-interactive pipelines. Two-track auth: ChatGPT-sign-in for personal interactive use, API-key sign-in for automation. No published rule against third-party harnesses authenticating via API key.

cfcf's existing `codex` adapter therefore remains a fully compliant unattended path.

---

## Mapping to cf² roles

cfcf has seven roles. **Two are truly interactive** (the agent's TUI takes over your shell via `Bun.spawn(... { stdio: "inherit" })`, you drive); **five are unattended** (cfcf spawns the agent headlessly with `claude -p` / `codex exec` / `opencode run` and parses its output through a log file). The mapping to Anthropic's allowed scope follows from there.

| Role | Mode | Allowed on Claude Code? | Why |
|---|---|---|---|
| **Product Architect** (`cfcf spec`) | Interactive | ✅ Yes | TUI takes over the shell; you drive the conversation. cfcf is acting as a launcher with a curated system prompt — same pattern as a config preset or slash command. |
| **Help Assistant** (`cfcf help assistant`) | Interactive | ✅ Yes | Same as PA — the TUI takes over your shell. |
| **Solution Architect** (any invocation path: pre-loop, mid-loop refine_plan, manual `cfcf review`) | Unattended | ⚠️ No | All three architect spawns are headless `claude -p`. Even `cfcf review`, despite its user-invoked framing, is a polling client to a server-side background spawn — no TUI takeover. Item 6.30 correction (was previously misclassified as interactive). |
| **Developer** | Unattended | ⚠️ No | Spawned per iteration in `-p` mode; you don't drive it. |
| **Iteration Judge** | Unattended | ⚠️ No | Same. |
| **Reflection Agent** | Unattended | ⚠️ No | Same. |
| **Documenter** | Unattended | ⚠️ No | Auto-runs after a successful loop; same harness pattern. |

cf² will display an **inline warning** at `cfcf init` and `cfcf config edit` time when you pick `claude-code` for any of the five ⚠️ rows. It does NOT block the choice — running Claude Code for limited testing on small tasks is fine and the policy is something the user owns. The warning exists so you don't pick it accidentally.

---

## Recommended adapters per role (default config)

| Role | Recommended adapter | Live log? | Why |
|---|---|---|---|
| **Product Architect** | `claude-code` | n/a (interactive — TUI in your shell) | Interactive, allowed scope. Opus-class model is worth the spend on spec authoring. |
| **Help Assistant** | `claude-code` | n/a (interactive) | Interactive, allowed scope. A smaller Sonnet/Haiku model is fine here. |
| **Solution Architect** (any invocation: pre-loop, mid-loop refine_plan, manual `cfcf review`) | `codex` (or `claude-code-ollama`) | ✅ codex / ❌ claude-code-ollama | All architect spawns are headless `claude -p` / `codex exec` regardless of invocation path — the `cfcf review` CLI just polls a status endpoint while the server runs the agent in the background, no TUI takeover. Same trade-offs as dev. |
| **Developer** | `codex` (or `claude-code-ollama` if you prefer Claude's UX) | ✅ codex / ❌ claude-code-ollama | Compliant unattended path. codex streams live; claude-code-ollama buffers (silent log during run, dumps at exit). |
| **Iteration Judge** | `codex` | ✅ live | "Different agent than dev" is the historical recommendation; codex's `exec` mode also streams live. |
| **Reflection Agent** | `codex` (or `claude-code-ollama`) | ✅ codex / ❌ claude-code-ollama | Strongest reasoning available on the unattended path. |
| **Documenter** | `codex` (or `claude-code-ollama` with a coder-tuned model, OR `opencode-ollama` for any model) | ✅ codex / ❌ claude-code-ollama | Same trade-off as dev. **Important** (item 6.30, May 2026): `claude-code-ollama` uses Anthropic's strict Messages API parser. Some non-coder-tuned local models — confirmed: `gemma4:31b` — produce tool-use / tool-result content blocks the parser rejects with `API Error: Content block not found`, and the run exits with nothing written. **Two workable paths**: (1) keep `claude-code-ollama` and pick a coder-tuned model (`qwen3-coder`, `deepseek-coder-v2`) — verified working end-to-end; (2) keep the same model and switch to `opencode-ollama` — its OpenAI-compatible endpoint is more tolerant of variance in tool-call output, and `gemma4:31b + opencode-ollama` was confirmed to write all four documenter files cleanly. Pick (1) if you prefer Claude's tool-call format; pick (2) if you've already invested in a non-coder model. |

You can mix and match freely — these are recommendations for first-run defaults, not enforced by cfcf.

**Why `codex` is the unattended default**: it's the only path today that combines (a) policy-clean (OpenAI's API-key flow explicitly endorses CLI automation), (b) live progress streaming in the log file (codex's `exec` mode is verbose-by-default), and (c) well-tested across cf²'s iteration roles. Use `claude-code-ollama` when you specifically prefer Claude's instruction-file / tool-call conventions and accept the silent-log trade-off.

### A note on `opencode-ollama` stability (2026-05-08 dogfood)

`opencode-ollama` works in principle but has known stability issues in cf²'s harness pattern that we haven't fully resolved yet. Specifically:

- **Hardcoded permission denies.** Even with `--dangerously-skip-permissions`, opencode's session config denies `question` / `plan_enter` / `plan_exit` permissions internally (matches [github/anomalyco/opencode#13851](https://github.com/anomalyco/opencode/issues/13851)). When the model tries to use one of those, opencode silently waits on a stdin permission prompt that never arrives — the agent appears to hang.
- **Silent error swallowing.** When ollama returns a 5xx (e.g. because of a busy/serializing model runner), opencode logs the failure to its INTERNAL log file (`~/.local/share/opencode/log/<timestamp>.log`) but doesn't propagate the error to stdout or exit non-zero. cf²'s harness sees a hung process with no diagnostic.
- **Stdout buffering** like claude-code-ollama — the cf² log file shows only opencode's session-header banner during the run.

**Recommendation until iter-6 stability work lands** (item 6.32 in the plan): for unattended roles, prefer `claude-code-ollama` (which is the better-tested ollama path in cf²'s harness — verified end-to-end with qwen3-coder on the calc workspace) or `codex` (which streams live + has no comparable hang issues). Use `opencode-ollama` only if you've validated it works against your specific model + workload combination. The adapter is shipped for users who specifically want opencode's UX, but it's not the recommended unattended default today.

If you do hit an opencode hang during a loop run, the recovery is:
```bash
# Find + kill the stuck opencode + ollama-launch wrappers (cfcf 6.31 will
# automate this on `cfcf server stop`; until then, kill them manually):
pgrep -f "ollama launch opencode|/.opencode/bin/opencode" | xargs kill
# Optional: also kill the loaded ollama runner so it cold-starts fresh:
pgrep -f "ollama runner" | xargs kill
# Then resume / retry the loop from the cf² web UI or `cfcf resume`.
```

---

## Log visibility during unattended runs

This is independent of (but stacks with) the policy concern.

`claude -p "<prompt>"` — used by both `claude-code` AND `claude-code-ollama` adapters — **buffers stdout to the end of the run.** Even with `--verbose`, the log file stays empty (or near-empty) for the entire iteration; the buffered output dumps when the agent exits. There is no live progress indicator in the log file; the iteration appears "stuck" until the final dump arrives.

This is a property of how Claude Code's print mode works (single-completion contract — one final response after the agent finishes its work), not a cfcf bug. Documented at the binary level in `claude --help` and confirmed during dogfooding (decisions-log 2026-05-08).

**Why we don't enable streaming.** Claude Code does support `--output-format stream-json` for live JSONL events, but the JSONL output is structurally noisy — unreadable in the web UI's log viewer panel and hard to scan with `tail -f`. The cf² adapters keep plain `-p` until a JSONL→text formatter lands in the web log viewer.

**Affected adapters** in cf²:
- `claude-code` (direct, with Anthropic API/subscription) — silent log + policy violation. Use for interactive only.
- `claude-code-ollama` (Claude Code wrapped via `ollama launch`) — silent log, but policy-clean. OK for unattended if you don't need live monitoring.

**Unaffected adapters** (live progress in the log file):
- `codex` — `codex exec` streams natively
- `opencode` / `opencode-ollama` — `opencode run` streams (verified during cf² 6.28 dogfood for opencode-ollama; opencode standalone untested but expected based on opencode's CLI docs)

**Workarounds when using `claude-code-ollama` for unattended roles:**
- Watch ollama's server log (`~/.ollama/logs/server.log`) for live `/v1/messages?beta=true` POSTs — gives you a turn count while the agent runs, even though the cfcf log file is silent.
- Watch file-system mutations: `ls -la <repo>/cfcf-docs/` updates as the agent writes intermediate artefacts (the iteration handoff, signal files).
- Web UI history panel shows the iteration's status badge (running / completed / failed) which updates regardless of stdout.
- Final log dump arrives when the agent exits — you'll see the full transcript at that point.

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

Pick `claude-code-ollama` (or one of the alternatives) for dev / judge / reflection / documenter / architect. Pick `claude-code` for Product Architect / Help Assistant — those are the only two roles where the agent's TUI actually takes over your shell (`stdio: "inherit"`).

### 5. Verify

```bash
cfcf doctor
cfcf config show
```

`cfcf doctor` reports the detected adapters + ollama state. `cfcf config show` prints the current per-role assignment.

---

## ⚠ Gotcha: `ollama launch claude` writes to `~/.claude/settings.json`

`ollama launch claude --model <X>` has an undocumented side-effect: it persists `<X>` as the default model in `~/.claude/settings.json`'s `model` field. From that point on, **any direct `claude` invocation** — whether from cfcf's `claude-code` adapter, your terminal, or any other tool — uses `<X>` as the model.

If `<X>` is an ollama-flavoured name (e.g. `gemma4:31b`, `qwen3-coder:latest`), direct `claude` invocations break because Anthropic's API rejects unknown model names with "There's an issue with the selected model (X). It may not exist or you may not have access to it."

This bites when you mix `claude-code` and `claude-code-ollama` in the same setup — for example, Product Architect on `claude-code` (per the recommended interactive-role mapping above) but dev/judge on `claude-code-ollama`. The first time you run an unattended role through `ollama launch claude`, your settings.json gets the ollama model name, and the next interactive PA run fails because `claude` (without the ollama wrapper) can't use it.

### Detection

`cfcf doctor` checks for this and warns:

```
⚠ Claude Code's ~/.claude/settings.json model field  -- ~/.claude/settings.json
   has model="gemma4:31b" — looks like an ollama model name. `ollama launch claude
   --model X` writes X to that file as a side-effect, which then breaks direct
   `claude` invocations …
```

Heuristic: any model name containing `:` (the ollama tag separator) is flagged. Anthropic aliases (`opus` / `sonnet` / `haiku`) and full names (`claude-sonnet-4-7`) don't contain `:`, so the check has no false positives on intentional Claude Code model overrides.

### Fix

Two options:

```bash
# Option 1 — clear the model field, claude reverts to its built-in default
jq 'del(.model)' ~/.claude/settings.json > /tmp/claude-settings.json && mv /tmp/claude-settings.json ~/.claude/settings.json

# Option 2 — set a valid Anthropic alias explicitly
jq '.model = "sonnet"' ~/.claude/settings.json > /tmp/claude-settings.json && mv /tmp/claude-settings.json ~/.claude/settings.json
```

After the fix, direct `claude` invocations use either Anthropic's built-in default (option 1) or the alias you picked (option 2). `ollama launch claude --model <X>` runs continue to use `<X>` regardless — the launch wrapper still routes them to ollama via `ANTHROPIC_BASE_URL` and bypasses the `model` field in settings.json.

### Why this matters more than it looks

If `cfcf doctor` doesn't surface this, the failure mode is hard to diagnose. cfcf's architect-runner spawns `claude` with no `--model` flag (since the workspace's architectAgent has no model override), so the error manifests as "the model `gemma4:31b` doesn't exist" — which looks like a bug in cfcf even though the actual misconfiguration is in `~/.claude/settings.json` written by ollama. Surfaced 2026-05-08 during iter-6 dogfooding.

---

## What cfcf does NOT do

- **cfcf does not install or manage ollama.** That stays your responsibility — install via brew/script, pull models, keep the daemon running. cfcf consumes whatever's on PATH.
- **cfcf does not auto-flip your config.** When you re-run `cfcf init --force` after this release, your existing per-role choices are preserved. The warning fires; the choice is yours.
- **cfcf does not block Claude Code use for unattended roles.** The warning is informational. If you're running a one-off test on a small problem and accept the policy implication, nothing stops you. The warning is for the case where you've forgotten the policy exists.

---

## Background

For the framing of why cf² took this approach (vs. a Claude-Code-API-key path or a config-flag-on-the-existing-adapter approach), see `docs/decisions-log.md` 2026-05-07 — *Anthropic's third-party-harness policy → adapter expansion via `ollama launch` (item 6.28)*.
