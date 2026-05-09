# Installing cf²

cf² is published on npmjs.com as [`@cerefox/codefactory`](https://www.npmjs.com/package/@cerefox/codefactory). The recommended install uses a curl-bash one-liner that handles the whole toolchain bootstrap automatically.

> **Building cfcf from a clone (for contributors)?** This guide is end-user-only. The dev-tree setup (`bun install` at the repo root, then `./scripts/local-install.sh` to dogfood the install pipeline) lives in the [README's developer section](../../README.md#for-developers-building-from-source). Don't run `npm install` against the cfcf workspace tree — npm doesn't understand Bun's `workspace:*` protocol and will error out.

> **A note on Claude Code use in cf²** (item 6.28). Two related concerns drive cf²'s adapter recommendations:
>
> 1. **Anthropic's third-party-harness policy.** Direct `claude-code` (talking to Anthropic's API/subscription) is restricted to interactive use — only safe for **Product Architect** (`cfcf spec`), **Help Assistant** (`cfcf help assistant`), and **manually-invoked Solution Architect** (`cfcf review`). The unattended dev / judge / reflection / documenter loop is the harness pattern Anthropic's Jan–Apr 2026 clarification targets.
> 2. **`claude -p` log buffering.** Both `claude-code` AND `claude-code-ollama` (Claude Code wrapped via `ollama launch`) inherit `claude -p`'s stdout-buffering behaviour — log files stay silent during the entire run and dump the final response only when the agent exits. `claude-code-ollama` is **policy-clean** (no Anthropic credential), but if you want live progress monitoring during long iterations, prefer `codex` or the opencode adapters for unattended roles.
>
> **Recommended setup** (defaults at fresh `cfcf init`): interactive roles on `claude-code`; unattended roles on `codex` (live progress, policy-clean). `claude-code-ollama` / `opencode` / `opencode-ollama` are also supported for unattended roles. Read [`anthropic-policy.md`](anthropic-policy.md) (also `cfcf help anthropic-policy` after install) before `cfcf init` so you can pick adapters with both concerns in mind. cf² surfaces a warning when `claude-code` is picked for an unattended role (yellow callout, policy-grade) and a softer info note when `claude-code-ollama` is picked (blue callout, log-visibility). Neither blocks the choice.

**Architecture**: cfcf's **runtime is Bun ≥ 1.3** (uses `bun:sqlite`, `Bun.spawn`, etc. directly). The **install tool is npm** (chosen over `bun install` because Bun blocks postinstall scripts by default — see [oven-sh/bun#4959](https://github.com/oven-sh/bun/issues/4959) — which would break cfcf's native deps). cfcf installs to `~/.bun/bin/cfcf` (via `npm install -g --prefix ~/.bun`). Since `~/.bun/bin` is on your PATH after Bun is installed, cfcf is reachable immediately — no separate PATH setup needed.

**Prerequisites** — `git`. Bun + npm are bootstrapped by the installer if missing.

## Installing the AI agent CLIs cf² drives

cf² needs **at least one** AI coding agent on PATH; `cfcf init` only offers adapters whose underlying CLI it can detect. Per the policy + log-visibility note above, **`claude-code` alone is not a complete setup** if you plan to run unattended loops — those need a non-Anthropic-OAuth path. **Recommended minimum** for typical use:

- **`claude-code`** (Anthropic) — for the interactive roles (PA / HA). Optional if you don't use those.
- **One of**: `codex` / `opencode` / `ollama` — for the unattended roles (dev / judge / reflection / documenter / architect — note: architect is always unattended in cf², including via manual `cfcf review`, since the architect spawn pipeline is headless `claude -p` regardless of how it's invoked).

Mix as you like; cf² surfaces a warning at `cfcf init` if your unattended-role adapter choices conflict with the policy. The full role-to-adapter mapping table lives in [`anthropic-policy.md`](anthropic-policy.md).

### Claude Code (Anthropic)

```bash
npm install -g @anthropic-ai/claude-code
claude --version    # confirm install
claude              # first run prompts for Anthropic OAuth login (browser)
```

Recommended for: **Product Architect (`cfcf spec`)** and **Help Assistant (`cfcf help assistant`)** — the two roles where Claude Code's TUI literally takes over your shell (via `stdio: "inherit"`). Anthropic's third-party-harness policy restricts subscription OAuth to interactive use, so cf²'s headless `claude -p` paths — dev, judge, reflection, documenter, and Solution Architect (yes, even via `cfcf review`, which polls a status endpoint while the server runs the architect in the background) — should NOT use direct `claude-code` (use `claude-code-ollama` or another adapter instead — see below).

### Codex CLI (OpenAI)

```bash
npm install -g @openai/codex
codex --version     # confirm install
codex auth login    # ChatGPT account OR API key — pick whichever fits your billing
```

Recommended for: **unattended roles default**. Codex's `exec` mode streams progress live to log files (you watch the agent work). OpenAI's policy explicitly endorses the API-key path for "automation in shared environments like CI", so this is the cleanest unattended-role choice today.

### Opencode (sst.dev)

```bash
npm install -g opencode-ai
opencode --version
opencode auth login   # interactive picker for Anthropic API / OpenAI / OpenRouter / etc.
```

Recommended for: **alternative to Codex for unattended roles**. Opencode is provider-agnostic — you authenticate with any provider it supports (Anthropic API, OpenAI, OpenRouter, ollama). Policy-clean by construction: no Anthropic OAuth subscription token involved, just direct API-key auth against whichever provider you picked. Streams progress live to log files.

### Ollama (local model server)

```bash
brew install ollama                                 # macOS
curl -fsSL https://ollama.com/install.sh | sh       # Linux
ollama --version

# Pull at least one coder-tuned model that works well as an iteration driver:
ollama pull qwen2.5-coder:32b      # ~19 GB, mid-size — works for dev / reflection
ollama pull qwen2.5-coder:14b      # ~9 GB, faster — works for judge / documenter
ollama pull deepseek-coder-v2:16b  # ~9 GB, alternative

ollama list   # confirm what's pulled
```

Optional, but enables two additional adapters: `claude-code-ollama` (drives Claude Code against a local model via `ollama launch claude`) and `opencode-ollama` (same for opencode). Policy-clean — local model means no Anthropic / OpenAI credential in the loop.

> ⚠ Two caveats specific to ollama-routed paths (full discussion in [`anthropic-policy.md`](anthropic-policy.md)):
> - **`claude-code-ollama` still buffers stdout.** Same `claude -p` behaviour as direct `claude-code` — the log file stays silent during the run and dumps at exit. If you want live progress, use `codex` / `opencode-ollama` instead.
> - **`ollama launch claude` writes to `~/.claude/settings.json`.** Specifically the `model` field gets set to the ollama model name. After that, direct `claude` invocations (interactive PA / HA) fail because Anthropic's API doesn't recognise the ollama-shaped name. Fix: `jq 'del(.model)' ~/.claude/settings.json | sponge ~/.claude/settings.json`. `cfcf doctor` checks for this and warns.

### Verifying after install

```bash
cfcf doctor   # confirms which adapter CLIs are reachable + ollama state + per-role policy compliance
cfcf init     # interactive setup; only offers adapters whose CLI is on PATH
```

`cfcf init` also surfaces the role-to-adapter recommendation matrix and a warning if you've picked `claude-code` for an unattended role.

## Recommended: one-liner

```bash
curl -fsSL https://github.com/fstamatelopoulos/cfcf/releases/latest/download/install.sh | bash
```

The script (with verbose output at every step):

1. **Bootstraps Bun** ≥ 1.3 if missing (via `curl -fsSL https://bun.sh/install | bash`)
2. **Bootstraps npm** if missing (via `bun install -g npm`)
3. **Installs cfcf** via `npm install -g --prefix ~/.bun @cerefox/codefactory`
4. **Prints a "next steps" banner** with the commands to run (`cfcf init`, `cfcf doctor`, etc.)

No sudo. No EACCES (~/.bun is always user-writable). No new PATH entries beyond what Bun's installer adds. No shell-rc edits from cfcf itself.

The only friction case: **first-time Bun users**. If install.sh installs Bun for you (you didn't have it before), Bun's installer adds `~/.bun/bin` to your `~/.zshrc` / `~/.bashrc` — but your CURRENT shell hasn't sourced the rc yet. The banner detects this and tells you to either open a new terminal or run `source ~/.zshrc` once. This is the same one-time step `curl bun.sh/install | bash` requires, regardless of cfcf.

After the installer prints the next-steps banner, you run:

```bash
cfcf init       # interactive first-run setup
```

## Direct install (if you already have Bun)

If you have Bun installed already and want to skip the wrapper:

```bash
# npm comes with Node.js (or `bun install -g npm`)
npm --version || bun install -g npm

# Install cfcf into ~/.bun (so it lands at ~/.bun/bin/cfcf, on PATH)
npm install -g --prefix ~/.bun @cerefox/codefactory             # latest
# or pin to a specific version:
npm install -g --prefix ~/.bun @cerefox/codefactory@0.17.0

# Verify + first-run setup
cfcf doctor
cfcf init
```

The `--prefix ~/.bun` flag tells npm to install into your Bun directory (which is on PATH) instead of npm's default global prefix (often root-owned, requires sudo or a separate `npm config set prefix ~/.npm-global` setup).

## Bun-only alternative (advanced)

If you'd rather not have npm on your machine and want to install via `bun install -g` directly, you can — but Bun blocks the postinstall scripts of `onnxruntime-node` and `protobufjs` by default, which would break Clio's embedder. To make it work:

```bash
bun install -g @cerefox/codefactory
bun pm -g trust @cerefox/codefactory onnxruntime-node protobufjs
cfcf doctor
```

This grants explicit, named trust to **just those three packages** (no `--all`). cfcf's published `package.json` declares `trustedDependencies: ["onnxruntime-node", "protobufjs"]` so the manual `bun pm trust` step will become unnecessary once [oven-sh/bun#4959](https://github.com/oven-sh/bun/issues/4959) lands upstream.

We recommend the curl-bash installer or the `npm install -g --prefix ~/.bun` path over this; npm runs postinstalls by default and the experience is friction-free.

## Tarball / offline / pinned-mirror install

When you can't reach npmjs.com (airgapped CI, internal pinned mirror, hand-delivered tarball), the same `install.sh` switches to **tarball mode** and pulls the per-platform CLI + native tarballs from a base URL you provide. Every cfcf release publishes the tarballs as GitHub Release assets in addition to npmjs.com, so the offline path always works.

Tarball mode auto-engages when `CFCF_BASE_URL` is set; you can also force it with `CFCF_INSTALL_SOURCE=tarball`.

```bash
# 1. Drop the cf² + native tarballs + install.sh into a directory.
ls dist/
# cfcf-0.17.0.tgz
# cerefox-codefactory-native-darwin-arm64-0.17.0.tgz
# install.sh

# 2a. Local HTTP server:
bun run scripts/serve-dist.ts 8080     # in another shell
CFCF_BASE_URL=http://localhost:8080 \
CFCF_VERSION=v0.17.0 \
  bash dist/install.sh

# 2b. file:// URL (no server needed):
CFCF_BASE_URL="file://$(pwd)/dist" \
CFCF_VERSION=v0.17.0 \
  bash dist/install.sh

# 2c. GitHub Releases mirror (the script's tarball-mode default URL):
CFCF_INSTALL_SOURCE=tarball \
CFCF_VERSION=v0.17.0 \
  bash install.sh

# 2d. Or hand the tarball directly to bun (skips install.sh entirely):
bun install -g ./dist/cfcf-0.17.0.tgz
```

Notes:

- `CFCF_VERSION=latest` resolves via GitHub's release-redirect when the base URL points at a `releases/latest/download` path; for `file://` URLs the version must be explicit.
- The recognised env vars are `CFCF_INSTALL_SOURCE` (`npm` | `tarball`), `CFCF_VERSION`, `CFCF_BASE_URL`, `CFCF_RELEASES_REPO` (defaults to `fstamatelopoulos/cfcf` — change if you fork), and `CFCF_SKIP_INIT`.

## What gets installed

`npm install -g --prefix ~/.bun` lays everything out under `~/.bun/lib/node_modules/`, with the `cfcf` binary symlinked into `~/.bun/bin/`. The tree:

```
$HOME/.bun/
├── bin/cfcf                              # symlink → ../lib/node_modules/@cerefox/codefactory/bin/cfcf.js
└── lib/node_modules/
    ├── @cerefox/codefactory/             # the CLI package
    │   ├── package.json
    │   ├── bin/cfcf.js                   # shebang stub
    │   └── dist/cfcf.js                  # bundled JS (~1 MB)
    ├── @cerefox/codefactory-native-<platform>/   # only the matching one is installed
    │   ├── libsqlite3.<dylib|so|dll>
    │   └── sqlite-vec.<dylib|so|dll>
    ├── @huggingface/transformers/        # runtime deps, fetched from npmjs.com
    ├── onnxruntime-node/
    └── sharp/
```

(If you used the Bun-only alternative below, the layout is slightly different: packages live under `~/.bun/install/global/node_modules/` instead. Functionally equivalent.)

User data lives separately under `~/.cfcf/`:

```
~/.cfcf/
├── clio.db                   # cross-workspace memory (Clio)
├── logs/                     # per-workspace agent stdout/stderr
└── models/                   # downloaded embedder models (lazy on first use)
```

Run `cfcf doctor` after install to verify all health checks pass (the count grows over time as we add new diagnostics — currently 13+).

## Upgrading

The simplest path is `cfcf self-update`:

```bash
cfcf self-update                              # check + interactive upgrade (npm)
cfcf self-update --check                      # check only; print latest vs current
cfcf self-update --yes                        # non-interactive
cfcf self-update --version v0.17.0            # install a specific tag

# Tarball mode for offline / pinned-mirror setups:
cfcf self-update --source tarball             # GitHub Releases (default mirror)
cfcf self-update --base-url file:///tmp/dist  # any HTTP / file:// mirror
```

Source resolution mirrors `install.sh`: `--source` flag wins; otherwise `--base-url` (or `CFCF_BASE_URL`) implies tarball; otherwise the default is **npm**. The same `CFCF_INSTALL_SOURCE` / `CFCF_VERSION` / `CFCF_BASE_URL` / `CFCF_RELEASES_REPO` env vars work for both.

Internally this runs `npm install -g --prefix ~/.bun @cerefox/codefactory@<version>` (npm) or `npm install -g --prefix ~/.bun <tarball-URL>` (tarball). npm handles the swap atomically — if the install fails, the previous version stays intact.

User data (`~/.cfcf/clio.db`, `~/.cfcf/logs/`, `~/.cfcf/models/`) is **never touched** by the install/upgrade flow. Only the global node_modules entry changes.

## Uninstalling

```bash
# Standard uninstall (matches the recommended install path):
npm remove -g --prefix ~/.bun @cerefox/codefactory @cerefox/codefactory-native-darwin-arm64
# Adjust the -native- suffix to match your platform (darwin-arm64 / darwin-x64 / linux-x64).

# Or via the wrapper (interactive, detects ALL historical install locations
# — ~/.bun/lib/node_modules, ~/.npm-global, npm system prefix, ~/.bun/install/global —
# and uses the right tool for each):
curl -fsSL https://github.com/fstamatelopoulos/cfcf/releases/latest/download/uninstall.sh | bash

# If you used the Bun-only alternative install:
bun remove -g @cerefox/codefactory @cerefox/codefactory-native-darwin-arm64
```

The uninstall removes the cf² package + the platform-native package. Runtime deps (`@huggingface/transformers`, `onnxruntime-node`, `sharp`) are removed automatically as orphaned dependencies. Your `~/.cfcf/` data dir is preserved on purpose; delete it manually with `rm -rf ~/.cfcf` if you want a clean wipe.

The platform-specific config dir (`~/Library/Application Support/cfcf/` on macOS; `$XDG_CONFIG_HOME/cfcf/` on Linux) is also preserved. Find it with `cfcf config show --path` *before* uninstalling.

## Troubleshooting

The full troubleshooting page is [`troubleshooting.md`](troubleshooting.md). The most-asked install-time issues:

### "cfcf: command not found" after install

Bun's global bin (`~/.bun/bin/`) isn't on PATH. Add it:

```bash
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.zshrc   # or ~/.bashrc
exec $SHELL
```

### Tab completion doesn't fire after install

90% of the time the fix is `rm ~/.zcompdump*; exec zsh` (force a clean compinit reload). See [troubleshooting.md → Tab completion doesn't work](troubleshooting.md#tab-completion-doesnt-work) for the full diagnosis.

### `cfcf doctor` reports "@cerefox/codefactory-native-<platform>: not installed"

`bun install -g` skipped the platform package because the npm registry didn't have it (private-distribution path during the cfcf-private phase: only the GitHub Release artefact has it). Install it manually:

```bash
bun install -g <tarball-URL>/cerefox-codefactory-native-<platform>-<version>.tgz
```

Or re-run `install.sh` against the Release URL — it pulls the right one for your platform.

### `Cannot find module '@huggingface/transformers'`

A network blip during install. Reinstall:

```bash
bun install -g @cerefox/codefactory       # or the tarball URL
```

### sqlite-vec / hybrid search doesn't work

`cfcf doctor` will flag the issue. The most common cause is a missing `@cerefox/codefactory-native-<platform>` package — see two items up.

### Bun warns about duplicate keys

Known Bun bug; cfcf's installer auto-dedups. See [troubleshooting.md → bun install warnings](troubleshooting.md#bun-install--g-warns-about-duplicate-keys).

## Platform support

| Platform | Status |
|---|---|
| darwin-arm64 (Apple Silicon) | ✅ |
| darwin-x64 (Intel Mac) | ✅ — kept first-class via the transformers 3.8.1 + ORT-node 1.21.0 pin |
| linux-x64 (glibc, Ubuntu 20.04+) | ✅ |
| linux-x64 (musl, Alpine) | ❌ — out of scope until requested |
| windows-x64 | 📅 follow-up phase. v1 ships Mac + Linux only. Use WSL on Windows. |

## See also

- [`manual.md`](manual.md) — the user-manual hub (3-minute getting started + concepts + everything else)
- [`troubleshooting.md`](troubleshooting.md) — common issues + fixes
- [`docs/research/installer-design.md`](../research/installer-design.md) — full design + decisions
- [`docs/decisions-log.md`](../decisions-log.md) — Bun-runtime requirement rationale + 2026-04-26 pivot to npm-format distribution
- [`docs/guides/clio-quickstart.md`](clio-quickstart.md) — the Clio memory layer
