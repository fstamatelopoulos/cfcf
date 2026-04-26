# Installing cfcf

cfcf ships as a standard npm-format package: `@cerefox/cfcf-cli`. The runtime is **Bun ≥ 1.3** — `bun install -g` resolves the heavy native deps (transformers, ORT, sharp) the same way every JS-ecosystem CLI does, and a per-platform `@cerefox/cfcf-native-<platform>` package supplies the pinned libsqlite3 + sqlite-vec libs.

**Prerequisites** — `git` + `bun` ≥ 1.3 (the curl-bash installer below installs Bun for you if it's missing).

## Quick install

```bash
curl -fsSL https://<host>/install.sh | bash
```

Replace `<host>` with the hosting URL the project announces. Today (cfcf private), this is the `cfcf-releases` GitHub repo's [Release page]; once cfcf goes public, it becomes `bun install -g @cerefox/cfcf-cli` (no curl-bash needed).

The script:

1. Detects whether Bun is on PATH; runs `curl -fsSL https://bun.sh/install | bash` if not.
2. Resolves the requested version (`CFCF_VERSION=latest` follows GitHub's release-redirect; an explicit tag is honoured verbatim).
3. Runs `bun install -g <tarball-URL>`. Bun fetches the cfcf tarball + the platform-specific `@cerefox/cfcf-native-<platform>` package + the runtime deps (transformers, ORT-node, sharp).
4. Hands off to `cfcf init` interactively. Set `CFCF_SKIP_INIT=1` to skip.

## Direct install (no wrapper)

If Bun is already on your machine, you can skip `install.sh` entirely and let Bun do the work:

```bash
bun install -g <tarball-URL>           # e.g. https://github.com/.../cfcf-0.10.0.tgz
# or, once cfcf is on npmjs.com:
bun install -g @cerefox/cfcf-cli
```

This is identical to what `install.sh` does after the Bun bootstrap.

## Local install (no GitHub, no public URL)

The install script accepts any HTTP server or `file://` URL via `CFCF_BASE_URL`. Useful when you've been handed a tarball out-of-band.

```bash
# 1. Drop the cfcf + native tarballs + install.sh into a directory.
ls dist/
# cfcf-0.10.0.tgz
# cerefox-cfcf-native-darwin-arm64-0.10.0.tgz
# install.sh

# 2a. Local server option:
bun run scripts/serve-dist.ts 8080     # in another shell
CFCF_BASE_URL=http://localhost:8080 \
CFCF_VERSION=v0.10.0 \
  bash dist/install.sh

# 2b. Or hand the tarball directly to bun (skips install.sh entirely):
bun install -g ./dist/cfcf-0.10.0.tgz
```

For the file:// path, `CFCF_VERSION` must be set explicitly (no "latest" symlink convention exists for file URLs).

## What gets installed

`bun install -g` lays everything out under your Bun global prefix (default: `~/.bun/install/global/`). The tree:

```
$HOME/.bun/install/global/node_modules/
├── @cerefox/cfcf-cli/                   # the CLI package
│   ├── package.json
│   ├── bin/cfcf.js                      # shebang stub
│   └── dist/cfcf.js                     # bundled JS (~1 MB)
├── @cerefox/cfcf-native-<platform>/     # only the matching one is installed
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

Run `cfcf doctor` after install to verify all 11 health checks pass.

## Upgrading

The simplest path is `cfcf self-update`:

```bash
cfcf self-update                        # check + interactive upgrade
cfcf self-update --check                # check only; print latest vs current
cfcf self-update --yes                  # non-interactive
cfcf self-update --version v0.11.0      # install a specific tag
```

Internally this runs `bun install -g <new-tarball-URL>`. Bun's package manager handles the swap atomically — if the install fails, the previous version stays intact.

User data (`~/.cfcf/clio.db`, `~/.cfcf/logs/`, `~/.cfcf/models/`) is **never touched** by the install/upgrade flow. Only the npm package contents change.

## Uninstalling

```bash
bun remove -g @cerefox/cfcf-cli         # one-liner

# Or via the wrapper (interactive, prints what gets preserved):
~/.cfcf/uninstall.sh                    # if you have it locally; otherwise just run the bun command
```

`bun remove -g` cleans up the cfcf package + the platform-native package + the runtime deps. Your `~/.cfcf/` data dir is preserved on purpose; delete it manually with `rm -rf ~/.cfcf` if you want a clean wipe.

The platform-specific config dir (`~/Library/Application Support/cfcf/` on macOS; `$XDG_CONFIG_HOME/cfcf/` on Linux) is also preserved. Find it with `cfcf config show --path` *before* uninstalling.

## Troubleshooting

### "cfcf: command not found" after install

Bun's global bin (`~/.bun/bin/`) isn't on PATH. Add it:

```bash
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.zshrc   # or ~/.bashrc
exec $SHELL
```

### `cfcf doctor` reports "@cerefox/cfcf-native-<platform>: not installed"

`bun install -g` skipped the platform package because the npm registry didn't have it (private-distribution path during the cfcf-private phase: only the GitHub Release artefact has it). Install it manually:

```bash
bun install -g <tarball-URL>/cerefox-cfcf-native-<platform>-<version>.tgz
```

Or re-run `install.sh` against the Release URL — it pulls the right one for your platform.

### `Cannot find module '@huggingface/transformers'`

A network blip during install. Reinstall:

```bash
bun install -g @cerefox/cfcf-cli       # or the tarball URL
```

### sqlite-vec / hybrid search doesn't work

`cfcf doctor` will flag the issue. The most common cause is a missing `@cerefox/cfcf-native-<platform>` package — see two items up.

## Platform support

| Platform | Status |
|---|---|
| darwin-arm64 (Apple Silicon) | ✅ |
| darwin-x64 (Intel Mac) | ✅ — kept first-class via the transformers 3.8.1 + ORT-node 1.21.0 pin |
| linux-x64 (glibc, Ubuntu 20.04+) | ✅ |
| linux-x64 (musl, Alpine) | ❌ — out of scope until requested |
| windows-x64 | 📅 follow-up phase. v1 ships Mac + Linux only. Use WSL on Windows. |

## See also

- [`docs/research/installer-design.md`](../research/installer-design.md) — full design + decisions
- [`docs/decisions-log.md`](../decisions-log.md) — Bun-runtime requirement rationale + 2026-04-26 pivot to npm-format distribution
- [`docs/guides/clio-quickstart.md`](clio-quickstart.md) — the Clio memory layer
