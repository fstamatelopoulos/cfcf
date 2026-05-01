# Installing cf²

cf² is published on npmjs.com as [`@cerefox/codefactory`](https://www.npmjs.com/package/@cerefox/codefactory). Single-tool design: **Bun ≥ 1.3** is both cfcf's runtime (uses `bun:sqlite`, `Bun.spawn`, etc. directly) and its install tool. The curl-bash installer handles a small Bun quirk transparently — see "Why a trust step?" below.

**Prerequisites** — `git`. Bun is bootstrapped by the installer if missing.

## Recommended: one-liner

```bash
curl -fsSL https://github.com/fstamatelopoulos/cfcf/releases/latest/download/install.sh | bash
```

The script (with verbose output at every step):

1. **Bootstraps Bun ≥ 1.3** if missing (via `curl -fsSL https://bun.sh/install | bash`)
2. **Installs cfcf** via `bun install -g @cerefox/codefactory`
3. **Grants trust + runs the 3 blocked postinstalls** (`bun pm -g trust @cerefox/codefactory onnxruntime-node protobufjs` — named packages, not `--all`)
4. **Runs `cfcf doctor`** for a quick health check
5. **Hands off to `cfcf init`** interactively (skip with `CFCF_SKIP_INIT=1`)

No sudo. The trust grant is scripted (you don't see a prompt) but auditable in the verbose output — see the "Why a trust step?" section below for what gets trusted and why.

## Direct install (if you already have Bun)

If your machine has Bun and you'd rather skip the wrapper:

```bash
# Install cfcf via bun
bun install -g @cerefox/codefactory             # latest
# or pin to a specific version:
bun install -g @cerefox/codefactory@0.16.4

# Run the postinstalls bun blocks by default
# (downloads platform-specific runtime binaries, sets up shell completion)
bun pm -g trust @cerefox/codefactory onnxruntime-node protobufjs

# Verify + first-run setup
cfcf doctor
cfcf init
```

## Why a trust step?

Bun blocks postinstall scripts of installed packages by default as a security measure (vs. npm which runs them automatically). cfcf's runtime correctness depends on three specific postinstalls running:

| Package | What its postinstall does | What breaks if blocked |
|---|---|---|
| `@cerefox/codefactory` | runs `cfcf completion install` | shell tab-completion + post-install banner missing |
| `onnxruntime-node` | downloads platform-specific `.node` runtime binaries | Clio embedder fails at runtime |
| `protobufjs` | code-generates serializer stubs onnxruntime depends on | onnxruntime broken (transformers chain) |

The **named, scoped** trust grant (`bun pm -g trust @cerefox/codefactory onnxruntime-node protobufjs`) approves exactly those three packages and runs their postinstalls. Never `--all`.

cfcf's published `package.json` declares `trustedDependencies: ["onnxruntime-node", "protobufjs"]`, but Bun's transitive-trust handling for global installs is incomplete ([oven-sh/bun#4959](https://github.com/oven-sh/bun/issues/4959)) — once that upstream issue is fixed, the explicit trust step becomes unnecessary; until then it's the canonical workaround.

## Tarball / offline / pinned-mirror install

When you can't reach npmjs.com (airgapped CI, internal pinned mirror, hand-delivered tarball), the same `install.sh` switches to **tarball mode** and pulls the per-platform CLI + native tarballs from a base URL you provide. Every cfcf release publishes the tarballs as GitHub Release assets in addition to npmjs.com, so the offline path always works.

Tarball mode auto-engages when `CFCF_BASE_URL` is set; you can also force it with `CFCF_INSTALL_SOURCE=tarball`.

```bash
# 1. Drop the cf² + native tarballs + install.sh into a directory.
ls dist/
# cfcf-0.16.2.tgz
# cerefox-codefactory-native-darwin-arm64-0.16.2.tgz
# install.sh

# 2a. Local HTTP server:
bun run scripts/serve-dist.ts 8080     # in another shell
CFCF_BASE_URL=http://localhost:8080 \
CFCF_VERSION=v0.16.2 \
  bash dist/install.sh

# 2b. file:// URL (no server needed):
CFCF_BASE_URL="file://$(pwd)/dist" \
CFCF_VERSION=v0.16.2 \
  bash dist/install.sh

# 2c. GitHub Releases mirror (the script's tarball-mode default URL):
CFCF_INSTALL_SOURCE=tarball \
CFCF_VERSION=v0.16.2 \
  bash install.sh

# 2d. Or hand the tarball directly to bun (skips install.sh entirely):
bun install -g ./dist/cfcf-0.16.2.tgz
```

Notes:

- `CFCF_VERSION=latest` resolves via GitHub's release-redirect when the base URL points at a `releases/latest/download` path; for `file://` URLs the version must be explicit.
- The recognised env vars are `CFCF_INSTALL_SOURCE` (`npm` | `tarball`), `CFCF_VERSION`, `CFCF_BASE_URL`, `CFCF_RELEASES_REPO` (defaults to `fstamatelopoulos/cfcf` — change if you fork), and `CFCF_SKIP_INIT`.

## What gets installed

`bun install -g` lays everything out under your Bun global prefix (default: `~/.bun/install/global/`). The tree:

```
$HOME/.bun/install/global/node_modules/
├── @cerefox/codefactory/                   # the CLI package
│   ├── package.json
│   ├── bin/cfcf.js                      # shebang stub
│   └── dist/cfcf.js                     # bundled JS (~1 MB)
├── @cerefox/codefactory-native-<platform>/     # only the matching one is installed
│   ├── libsqlite3.<dylib|so|dll>
│   └── sqlite-vec.<dylib|so|dll>
├── @huggingface/transformers/           # runtime deps, fetched from npmjs.com
├── onnxruntime-node/
└── sharp/
```

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
cfcf self-update --version v0.16.2            # install a specific tag

# Tarball mode for offline / pinned-mirror setups:
cfcf self-update --source tarball             # GitHub Releases (default mirror)
cfcf self-update --base-url file:///tmp/dist  # any HTTP / file:// mirror
```

Source resolution mirrors `install.sh`: `--source` flag wins; otherwise `--base-url` (or `CFCF_BASE_URL`) implies tarball; otherwise the default is **npm**. The same `CFCF_INSTALL_SOURCE` / `CFCF_VERSION` / `CFCF_BASE_URL` / `CFCF_RELEASES_REPO` env vars work for both.

Internally this runs `bun install -g @cerefox/codefactory@<version>` (npm) or `bun install -g <tarball-URL>` (tarball). Bun's package manager handles the swap atomically — if the install fails, the previous version stays intact.

User data (`~/.cfcf/clio.db`, `~/.cfcf/logs/`, `~/.cfcf/models/`) is **never touched** by the install/upgrade flow. Only the global node_modules entry changes.

## Uninstalling

```bash
bun remove -g @cerefox/codefactory         # one-liner

# Or via the wrapper (interactive, prints what gets preserved):
~/.cfcf/uninstall.sh                    # if you have it locally; otherwise just run the bun command
```

`bun remove -g` cleans up the cf² package + the platform-native package + the runtime deps. Your `~/.cfcf/` data dir is preserved on purpose; delete it manually with `rm -rf ~/.cfcf` if you want a clean wipe.

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
