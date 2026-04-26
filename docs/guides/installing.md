# Installing cfcf

cf² ships a standalone binary per platform plus colocated runtime deps + native libs (custom SQLite + sqlite-vec). The installer downloads + verifies + drops everything under `~/.cfcf/`.

**Prerequisites** — that's it: `git`. Everything else (Bun runtime, Node, npm) is bundled in the tarball; you don't need them on your machine.

## Quick install

```bash
curl -fsSL https://<host>/install.sh | bash
```

Replace `<host>` with the hosting URL the project announces — see [Where the install URL points](#where-the-install-url-points) below for the current shape. The default URL in the script targets a public `cfcf-releases` repo when one is set up; until then, use the `CFCF_BASE_URL` override (see [Local install](#local-install)).

The script:

1. Detects your platform (darwin-arm64, darwin-x64, linux-x64).
2. Downloads `cfcf-<platform>-<version>.tar.gz` + `SHA256SUMS`.
3. Verifies the checksum.
4. Unpacks into `~/.cfcf/` (binary at `~/.cfcf/bin/cfcf`, runtime deps at `~/.cfcf/bin/node_modules/`, custom SQLite + sqlite-vec at `~/.cfcf/native/`).
5. Symlinks `~/.cfcf/bin/cfcf` → `/usr/local/bin/cfcf` (or prints a PATH hint if that location isn't writable).
6. On macOS, strips the `com.apple.quarantine` xattr so Gatekeeper doesn't block the unsigned binary.
7. Prompts you to press Enter to run `cfcf init`, then hands off interactively. Set `CFCF_SKIP_INIT=1` to skip the handoff.

## Local install (no GitHub, no public URL)

The install script is hosting-agnostic — it works against any HTTP server or even a local `file://` URL. Useful when you've been handed a tarball out-of-band (e.g. via Dropbox, a shared drive, or another machine).

```bash
# 1. Drop the tarball + sha + install.sh into a directory.
ls dist/
# cfcf-darwin-arm64-v0.10.0.tar.gz
# SHA256SUMS
# install.sh

# 2a. Local server option (see below); from another shell:
CFCF_BASE_URL=http://localhost:8080 \
CFCF_VERSION=v0.10.0 \
  bash dist/install.sh

# 2b. file:// option — no server, just direct disk read.
CFCF_BASE_URL=file://$(pwd)/dist \
CFCF_VERSION=v0.10.0 \
  bash dist/install.sh
```

cfcf developers running Phase-0 tests can spin up the local server with the bundled helper:

```bash
bun run scripts/serve-dist.ts 8080
# serves dist/ over http://localhost:8080/
```

## Manual install

If you want to inspect the tarball or skip the script entirely:

```bash
# Download + verify
curl -fsSLO https://<host>/cfcf-darwin-arm64-v0.10.0.tar.gz
curl -fsSLO https://<host>/SHA256SUMS
sha256sum -c <(grep cfcf-darwin-arm64-v0.10.0.tar.gz SHA256SUMS)   # macOS: shasum -a 256

# Unpack
mkdir -p ~/.cfcf
tar xzf cfcf-darwin-arm64-v0.10.0.tar.gz -C ~/.cfcf --strip-components=1

# macOS only: bypass Gatekeeper for the unsigned binary
xattr -d com.apple.quarantine ~/.cfcf/bin/cfcf 2>/dev/null || true
find ~/.cfcf -name "*.node" -exec xattr -d com.apple.quarantine {} \; 2>/dev/null || true
find ~/.cfcf -name "*.dylib" -exec xattr -d com.apple.quarantine {} \; 2>/dev/null || true

# Add to PATH (or symlink)
ln -sf ~/.cfcf/bin/cfcf /usr/local/bin/cfcf

# Configure
cfcf init
```

## What gets installed

```
~/.cfcf/
├── bin/
│   ├── cfcf                       # Bun-compiled standalone binary
│   └── node_modules/              # colocated runtime deps (transformers + ORT-node + sharp)
├── native/
│   ├── libsqlite3.<dylib|so|dll>  # pinned SQLite with loadExtension enabled
│   └── sqlite-vec.<dylib|so|dll>  # vec0 extension for hybrid search
├── MANIFEST                       # version pins (cfcf, bun, sqlite, sqlite-vec, deps)
├── uninstall.sh                   # see below
└── (created on first use)
    ├── clio.db                    # Clio cross-workspace memory
    ├── models/                    # downloaded embedder models
    └── logs/                      # per-workspace agent logs
```

`cfcf --version` prints the full MANIFEST so you can verify exactly which versions are running.

## Where the install URL points

The default `CFCF_BASE_URL` in `install.sh` targets the future public `cfcf-releases` repo's GitHub Releases. Until that repo is set up, the install URL has to be overridden. For released tarballs hosted anywhere — GitHub Releases on the cfcf repo, Dropbox, S3, an internal mirror — the install script works the same way; only `CFCF_BASE_URL` changes.

Future plan: when `cfcf-releases` becomes a public GitHub repo, GitHub Pages on it can host a simple landing page with the install one-liner; search-indexed by Google for free.

## Upgrading

The simplest path is `cfcf self-update`:

```bash
cfcf self-update                        # check + interactive upgrade
cfcf self-update --check                # check only; print latest vs current
cfcf self-update --yes                  # non-interactive (CI / scripts)
cfcf self-update --version v0.11.0      # install a specific tag instead of latest
```

It reads `~/.cfcf/MANIFEST` for the current version, fetches the latest from the configured release URL, and re-runs the installer in upgrade mode if a newer version is available. Same-version → "already on latest" + exit.

If you'd rather invoke the installer directly:

```bash
curl -fsSL https://<host>/install.sh | CFCF_VERSION=v0.11.0 bash
```

Either way, the unpack overwrites `bin/` + `native/` + `MANIFEST` but **leaves your data alone** — `~/.cfcf/clio.db`, `~/.cfcf/models/`, and `~/.cfcf/logs/` survive upgrades intact. Schema migrations (Clio DB, workspace configs, global config) apply lazily on next read.

## Uninstalling

```bash
~/.cfcf/uninstall.sh                   # interactive
CFCF_FORCE=1 ~/.cfcf/uninstall.sh      # no-prompt
```

Removes the binary, native libs, embedder models cache, Clio DB, and logs. Does **not** remove the platform-specific config dir (`~/Library/Application Support/cfcf/` on macOS; `$XDG_CONFIG_HOME/cfcf/` on Linux). Run `cfcf config show --path` before uninstalling to find it; remove manually if desired.

## Troubleshooting

### macOS: "cfcf can't be opened because it is from an unidentified developer"

The install script strips the `com.apple.quarantine` xattr automatically. If you bypassed the script (manual install) you can do it yourself:

```bash
xattr -d com.apple.quarantine ~/.cfcf/bin/cfcf
```

Apple Developer signing ($99/yr) would remove this dialog entirely; deferred indefinitely (see [`docs/research/installer-design.md`](../research/installer-design.md) §15 "Signing macOS binary").

### "cfcf: command not found" after install

The symlink at `/usr/local/bin/cfcf` couldn't be created (path not writable). Add `~/.cfcf/bin` to your PATH:

```bash
echo 'export PATH="$HOME/.cfcf/bin:$PATH"' >> ~/.zshrc   # or ~/.bashrc
exec $SHELL
```

### `Cannot find module '@huggingface/transformers'`

The colocated `node_modules/` next to the binary is missing or moved. Re-run the installer to repopulate:

```bash
curl -fsSL https://<host>/install.sh | bash
```

If you're a dev running the in-tree binary directly (`./cfcf-binary`, not `~/.cfcf/bin/cfcf`), Bun's `--compile` resolver only walks from the binary's location — your in-tree `cfcf-binary` doesn't have a colocated `node_modules/`. Use `bun run dev:cli <args>` instead during development. See `docs/decisions-log.md` 2026-04-25 entry "Clio embedders" item 7 for full background.

### sqlite-vec / hybrid search doesn't work

`cfcf clio embedder list` should show the active embedder; `cfcf --version` should show non-empty `sqlite-vec` + `sqlite` lines. If `sqlite-vec` reports `unknown` in the MANIFEST, the install is partial — re-run the installer.

### Server is already running

The install script refuses to proceed if a `cfcf server` process is detected. Stop it first:

```bash
cfcf server stop
```

Then re-run install. (The server caches active embedder + config in memory at startup; reinstalling without restart leaves it stale.)

## Platform support

| Platform | Status |
|---|---|
| darwin-arm64 (Apple Silicon) | ✅ |
| darwin-x64 (Intel Mac) | ✅ — kept first-class via the transformers 3.8.1 + ORT-node 1.21.0 pin (see `docs/decisions-log.md`) |
| linux-x64 (glibc, Ubuntu 20.04+) | ✅ |
| linux-x64 (musl, Alpine) | ❌ — out of scope until requested |
| windows-x64 | 📅 follow-up phase. v1 ships only the Mac + Linux installer. Use WSL on Windows for now. |

## See also

- [`docs/research/installer-design.md`](../research/installer-design.md) — full design + decisions
- [`docs/decisions-log.md`](../decisions-log.md) — version-pin rationale, exit criteria for revisiting Intel Mac support
- [`docs/guides/clio-quickstart.md`](clio-quickstart.md) — Clio memory layer (the heavyweight feature the installer's complexity is in service of)
