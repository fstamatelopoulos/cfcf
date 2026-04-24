# Installer design — plan item 5.5

**Status:** design, not yet built. Feeds plan item 5.5.
**Author:** draft captured 2026-04-22 during a joint design pass.
**Cross-refs:** [`docs/plan.md`](../plan.md) row 5.5, [`docs/design/clio-memory-layer.md`](../design/clio-memory-layer.md) §4 (Clio SQLite stack), plan items 6.15 (sqlite-vec HNSW), 6.19 (Clio onboarding — embedder pre-warm).

## 1. What the installer has to deliver

End-user experience:

```
curl -fsSL https://<host>/install | bash
# installs cfcf on darwin-arm64 / darwin-x64 / linux-x64 / (eventually) windows-x64
cfcf init
```

Behind that one-liner, the installer must:

1. **Detect the target platform** (`uname -s` / `uname -m`, or PowerShell equivalents on Windows).
2. **Download a platform-specific archive** from GitHub Releases.
3. **Verify the archive's sha256** against a published checksum file.
4. **Unpack** into `~/.cfcf/` (with `bin/`, `runtime/`, `native/` sub-layout — see §7).
5. **Link or PATH-update** so `cfcf` resolves from a normal shell.
6. **Print next steps** — specifically, point the user at `cfcf init` for interactive first-run setup.

What the installer does **not** do:

- Download the embedder model (that stays lazy, per 5.7 design — a `--with-embedder` flag may pre-warm it; see §10).
- Install any agent CLIs (`claude-code`, `codex`) — those remain user-installed third-party tools.
- Install git — it's a documented prerequisite.

## 2. Answers to the four open questions (2026-04-22)

### Q1. CI automation

**Decision: yes, build release automation.**

A tag-triggered workflow (`.github/workflows/release.yml`) runs a platform matrix (initially `darwin-arm64`, `darwin-x64`, `linux-x64`; `windows-x64` added in a follow-up), produces one tarball per platform plus a `sha256.txt` manifest, and publishes them all as assets on the GitHub Release created by `gh release create`. The install script reads from the tag's release (or `/releases/latest/download/` for "just install the newest").

### Q2. Where the install URL lives

The one-liner needs a host. Three realistic shapes, ordered by cost:

| Option | URL | Cost | Prereqs |
|---|---|---|---|
| **A — local testing** | `file:///tmp/cfcf/install.sh` or `http://localhost:8080/install` | Free | None |
| **B — public "releases" repo on GitHub** | `https://raw.githubusercontent.com/<user>/cfcf-releases/main/install.sh` or `https://<user>.github.io/cfcf-releases/install.sh` (GitHub Pages) | Free | A public repo; works even while cfcf itself stays private |
| **C — `cerefox.org/install`** | `https://cerefox.org/install` | Paid domain + redirect config | Domain ownership + a redirect or static host |

**Preference** (2026-04-22): **B, with A for dev-mode testing while the release workflow stabilises.** User is unwilling to pay for a domain for the first cut and is comfortable either open-sourcing cfcf or standing up a dedicated public `cfcf-releases` repo that holds only the `install.sh` + GitHub Release assets. Option C becomes a cosmetic upgrade later — a domain-level HTTP redirect to the B URL costs nothing to flip once the domain exists.

**Plan for v1:** build against Option A first (serve the script + a tarball from `python3 -m http.server` on localhost during development), then move to Option B once the release workflow produces real artifacts.

### Q3. SQLite cross-platform — the installer must own it

User was right to push back on my "defer to 6.15" suggestion. The reality:

- `bun:sqlite` uses the **system SQLite** on each platform. On macOS that means Apple's SQLite, which is built with `SQLITE_OMIT_LOAD_EXTENSION` → `loadExtension()` silently disabled. On Linux it's often a distro's libsqlite3 which *does* support loadExtension but at an unpredictable version.
- Clio v1 didn't notice because it ships no extensions; FTS5 is built into every SQLite. But 6.15 (sqlite-vec HNSW) will need `loadExtension` on macOS, and leaving that until 6.15 means 6.15 has to ship its own SQLite story *after* users already have an installer that doesn't.
- A "proper cross-platform straightforward install" implies the installer guarantees a known SQLite regardless of what the system ships. **So yes — the installer takes ownership of SQLite.**

**How:**

1. The release workflow compiles a pinned SQLite (from the official amalgamation at a specific version, e.g. 3.45.x) **with extension loading enabled** (`-DSQLITE_ENABLE_LOAD_EXTENSION=1` + no `-DSQLITE_OMIT_LOAD_EXTENSION`). Produces `libsqlite3.dylib` (darwin) / `libsqlite3.so` (linux) / `sqlite3.dll` (windows). Few kB of C, builds in seconds.
2. The release workflow downloads the matching `sqlite-vec` prebuilt (they publish one per platform on their own GitHub Releases) and packages it alongside.
3. The installer drops both into `~/.cfcf/native/`.
4. The cfcf binary reads `CFCF_SQLITE_LIB` at startup and calls `Database.setCustomSQLite(path)` before opening `clio.db`. `CFCF_SQLITE_LIB` is set by the installer's generated wrapper / symlink / activation script (or we read it from `~/.cfcf/native/libsqlite3.<ext>` directly without requiring an env var — probably cleaner).

This means 6.15 inherits a working SQLite + sqlite-vec from day one; it only needs to add the schema + query side.

**Trade-off accepted:** the tarball is slightly bigger (~2 MB for SQLite + sqlite-vec), and the release CI does a C compile step. Both are cheap.

### Q4. Native deps, Bun-is-not-a-prereq, and the tarball question

**Correction** (2026-04-22, user-raised): Bun is **not** a user prerequisite. The README's "Bun v1.3+" note is a **developer** prerequisite (for `bun run build` etc.), not an install-time requirement. End users get a Bun-compiled standalone binary — Bun runtime is embedded by `bun --compile`. They should not need to install Bun or Node at all.

This kills **Option B (lazy `bun install`)** and **Option C (bootstrap `bun install` into `~/.cfcf/runtime-deps/`)** from the earlier sketch: both required Bun on the user's machine.

**Option A is the only option.** The installer ships a self-contained tarball with everything the binary needs to run. Size estimate per platform:

| Component | Size |
|---|---|
| `cfcf-binary` (Bun-compiled, includes Bun runtime) | ~65 MB |
| `node_modules/onnxruntime-node/` (platform-specific .node addon) | ~40 MB |
| `node_modules/@huggingface/transformers/` | ~30 MB |
| `node_modules/sharp/` (platform-specific .node addon) | ~10 MB |
| `native/libsqlite3.<ext>` | <1 MB |
| `native/sqlite-vec.<ext>` | <1 MB |
| **Total** | **~150 MB per platform** |

Not 300 MB. Still larger than a classic CLI install but acceptable for a tool whose job is running a local LLM-agent loop with embedding search. Users accept larger installs for LLM tooling generally (Ollama models are multi-GB).

**Resolution of the native deps in the binary.** Bun's `--compile` externalizes `@huggingface/transformers`, `onnxruntime-node`, `sharp` because they contain native addons (.node files) that can't be bundled. At runtime the embedded Bun still uses standard Node.js resolution — `node_modules/` sitting next to the binary, or `NODE_PATH` pointing at one. The installer places these deps at a fixed path and the binary looks there. Two concrete mechanisms:

- **(a) colocated:** put `node_modules/` in the same directory as the binary. Bun walks up from the executable's path during module resolution, so `~/.cfcf/bin/cfcf` + `~/.cfcf/bin/node_modules/` works out of the box. Cleanest.
- **(b) `NODE_PATH`:** installer generates a shim shell script at `/usr/local/bin/cfcf` that exports `NODE_PATH=~/.cfcf/runtime/node_modules` then execs `~/.cfcf/bin/cfcf`. Works when `/usr/local/bin/cfcf` needs to be a real binary (e.g., `which cfcf` should return the real path), but adds a wrapper script.

**Preference: (a).** The install target is `~/.cfcf/bin/cfcf` with `node_modules/` next to it; `/usr/local/bin/cfcf` is a symlink pointing at the real binary. Bun's module resolution handles the rest.

**Windows.** Bun's `--compile` supports Windows targets (`--target=bun-windows-x64`); the native deps also ship Windows binaries via npm (onnxruntime-node has prebuilds, sharp has prebuilds, sqlite-vec has a Windows DLL). The wrinkle is the install mechanism: `curl | bash` doesn't exist on Windows. Three options:

- **W1 — PowerShell installer:** `irm https://<host>/install.ps1 | iex`. Same logic as the Bash script, just translated. Installs to `%LOCALAPPDATA%\cfcf\` and updates PATH via registry.
- **W2 — WSL only:** document that Windows users run inside WSL; the Linux installer works unchanged.
- **W3 — Manual zip download:** user grabs a `.zip` from Releases and unpacks manually; no installer.

**Recommendation:** v1 ships Mac + Linux via bash installer (W2 as a documented fallback for Windows users in WSL); W1 PowerShell installer in a follow-up once the release + Mac/Linux installers are proven. W3 works immediately as a safety net because the release tarballs exist anyway.

## 3. Revised architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│  Release workflow (tag-triggered)                                      │
│  .github/workflows/release.yml                                         │
│                                                                         │
│  matrix: [darwin-arm64, darwin-x64, linux-x64]                         │
│    1. bun run build --target=bun-<platform>       → cfcf-binary        │
│    2. bun install --production  (runtime deps)    → node_modules/      │
│    3. gcc -DSQLITE_ENABLE_LOAD_EXTENSION=1 sqlite3.c -o libsqlite3.<ext> │
│    4. curl sqlite-vec release asset               → sqlite-vec.<ext>   │
│    5. tar czf cfcf-<platform>.tar.gz  (layout per §7)                  │
│    6. sha256sum cfcf-*.tar.gz                     > sha256.txt         │
│    7. gh release create <tag> cfcf-*.tar.gz sha256.txt install.sh      │
└───────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌───────────────────────────────────────────────────────────────────────┐
│  Install-time fetch                                                    │
│  curl -fsSL https://<host>/install | bash                              │
│                                                                         │
│  1. detect platform                                                    │
│  2. download cfcf-<platform>.tar.gz + sha256.txt from GH Release       │
│  3. verify sha256                                                      │
│  4. tar xzf into ~/.cfcf/                                              │
│  5. symlink ~/.cfcf/bin/cfcf → /usr/local/bin/cfcf                     │
│     (fallback: print "add ~/.cfcf/bin to PATH" if /usr/local/bin not   │
│      writable)                                                         │
│  6. run `cfcf --version` as a smoke test                               │
│  7. print "Run cfcf init to get started"                               │
└───────────────────────────────────────────────────────────────────────┘
```

## 4. Tarball layout

```
cfcf-darwin-arm64/
├── bin/
│   ├── cfcf                          # Bun-compiled standalone binary
│   └── node_modules/                 # colocated runtime deps (see Q4)
│       ├── @huggingface/
│       │   └── transformers/…
│       ├── onnxruntime-node/…        # contains .node addon for this platform
│       └── sharp/…                   # contains .node addon for this platform
├── native/
│   ├── libsqlite3.dylib              # pinned SQLite with loadExtension=on
│   └── sqlite-vec.dylib              # from sqlite-vec GH Releases
├── MANIFEST                          # versions: cfcf, bun, sqlite, sqlite-vec, transformers, onnxruntime-node, sharp
└── LICENSE                           # cfcf + bundled-deps licences concatenated
```

`~/.cfcf/` layout after install:

```
~/.cfcf/
├── bin/           # from tarball
├── native/        # from tarball
├── models/        # lazy-populated on first embedder install
├── clio.db        # created on first cfcf clio call
├── logs/          # per-workspace agent logs
└── MANIFEST       # copy of the one in the tarball; used for upgrades
```

## 5. The binary's side

Two touch points in the cfcf source:

1. **Module resolution.** Nothing to change — colocating `node_modules/` next to the binary works out of the box with Bun.
2. **SQLite wiring.** `packages/core/src/clio/db.ts` currently opens `new Database(path)`. Change to:

```ts
import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { join } from "path";

const libDir = process.env.CFCF_NATIVE_DIR ?? join(homedir(), ".cfcf", "native");
const ext = process.platform === "darwin" ? ".dylib"
          : process.platform === "win32"  ? ".dll"
          : ".so";
const customLib = join(libDir, `libsqlite3${ext}`);
if (existsSync(customLib)) {
  Database.setCustomSQLite(customLib);
}
```

Runs once at process start before any DB is opened. Gracefully no-ops when the file isn't there (e.g., dev mode or a system install without the pinned lib) — Clio v1 still works in that case, just without sqlite-vec. 6.15's sqlite-vec code does `db.loadExtension(join(libDir, "sqlite-vec"))` and errors cleanly if the custom lib isn't active.

## 6. Release workflow sketch

```yaml
# .github/workflows/release.yml (sketch)
on:
  push:
    tags: ["v*"]
jobs:
  build:
    strategy:
      matrix:
        include:
          - os: macos-latest
            target: bun-darwin-arm64
            name: darwin-arm64
          - os: macos-13          # x86 runner
            target: bun-darwin-x64
            name: darwin-x64
          - os: ubuntu-latest
            target: bun-linux-x64
            name: linux-x64
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun run build --target=${{ matrix.target }} --outfile cfcf-binary
      - run: scripts/stage-runtime-deps.sh        # bun install --production into a staging dir
      - run: scripts/build-sqlite.sh ${{ matrix.name }}
      - run: scripts/fetch-sqlite-vec.sh ${{ matrix.name }}
      - run: scripts/package-tarball.sh ${{ matrix.name }}
      - run: sha256sum cfcf-${{ matrix.name }}.tar.gz > cfcf-${{ matrix.name }}.tar.gz.sha256
      - uses: actions/upload-artifact@v4
        with:
          name: cfcf-${{ matrix.name }}
          path: |
            cfcf-${{ matrix.name }}.tar.gz
            cfcf-${{ matrix.name }}.tar.gz.sha256
  release:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
      - run: gh release create "$GITHUB_REF_NAME" --generate-notes cfcf-*/*.tar.gz cfcf-*/*.sha256 scripts/install.sh
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## 7. Install script sketch

```bash
#!/usr/bin/env bash
set -euo pipefail

# Defaults (overridable via env)
: "${CFCF_VERSION:=latest}"
: "${CFCF_INSTALL_DIR:=$HOME/.cfcf}"
: "${CFCF_SYMLINK_DIR:=/usr/local/bin}"
: "${CFCF_REPO:=fstamatelopoulos/cfcf-releases}"    # tentative — see §Q2

# Detect platform
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$os-$arch" in
  darwin-arm64)  platform=darwin-arm64 ;;
  darwin-x86_64) platform=darwin-x64 ;;
  linux-x86_64)  platform=linux-x64 ;;
  *) echo "Unsupported platform: $os-$arch" >&2; exit 1 ;;
esac

# Resolve release URL
if [[ "$CFCF_VERSION" == "latest" ]]; then
  base="https://github.com/${CFCF_REPO}/releases/latest/download"
else
  base="https://github.com/${CFCF_REPO}/releases/download/${CFCF_VERSION}"
fi

tarball="cfcf-${platform}.tar.gz"
sha="${tarball}.sha256"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "[cfcf] downloading $tarball..."
curl -fsSL "$base/$tarball" -o "$tmp/$tarball"
curl -fsSL "$base/$sha"     -o "$tmp/$sha"

echo "[cfcf] verifying checksum..."
(cd "$tmp" && sha256sum -c "$sha")

echo "[cfcf] installing to $CFCF_INSTALL_DIR..."
mkdir -p "$CFCF_INSTALL_DIR"
tar xzf "$tmp/$tarball" -C "$CFCF_INSTALL_DIR" --strip-components=1

# Symlink (or print PATH instructions on failure)
if [[ -w "$CFCF_SYMLINK_DIR" ]]; then
  ln -sf "$CFCF_INSTALL_DIR/bin/cfcf" "$CFCF_SYMLINK_DIR/cfcf"
else
  echo "[cfcf] $CFCF_SYMLINK_DIR not writable."
  echo "[cfcf] Add this to your shell rc to use cfcf:"
  echo "         export PATH=\"$CFCF_INSTALL_DIR/bin:\$PATH\""
fi

echo "[cfcf] smoke test..."
"$CFCF_INSTALL_DIR/bin/cfcf" --version

echo
echo "cfcf installed. Next: run 'cfcf init' to configure."
```

## 8. Rollout phases

1. **Phase 0 — local-filesystem testing.** Serve `install.sh` + a manually-built tarball from `python3 -m http.server` on localhost. Validate the script end-to-end without touching GitHub. Unblocks script development while the release workflow is still stubbed. **No dependency on anything external.**
2. **Phase 1 — release workflow on the existing private repo.** Tag-triggered, uploads assets to the repo's GitHub Releases. Releases from a private repo require a PAT for download; fine for internal testing. Installer URL points at the raw `scripts/install.sh` in the repo (also private — also needs a token).
3. **Phase 2 — dedicated public `cfcf-releases` repo.** Releases + `install.sh` move to a public repo. Install URL becomes `https://raw.githubusercontent.com/fstamatelopoulos/cfcf-releases/main/install.sh` — works with `curl | bash` anonymously. Option B in Q2.
4. **Phase 3 (optional) — `cerefox.org/install` redirect.** Domain owner adds an HTTP redirect to the phase-2 URL. No other changes.
5. **Phase 4 — Windows.** PowerShell installer + Windows matrix entry in the release workflow.

## 9. What 5.5 explicitly owns vs. what's downstream

**In 5.5:**
- Release workflow for mac + linux.
- Install script (Option A hosting for v1).
- Pinned SQLite + sqlite-vec packaging (infrastructure for 6.15).
- `Database.setCustomSQLite(...)` wiring in the binary.
- User-facing docs (`docs/guides/installing.md`).
- **Updates to [5.8](../plan.md) user manual** so the quick-start points at the installer instead of a repo clone (plan already notes this cross-dep).

**Downstream (not 5.5):**
- 6.15 sqlite-vec HNSW integration (schema, query, reindex migration) — consumes the SQLite infrastructure 5.5 ships.
- 6.19 installer embedder pre-warm — a `--with-embedder <name>` flag on `install.sh` that runs `cfcf clio embedder install <name>` after the main install. Small addition once 5.5 is live.
- Windows PowerShell installer.

## 10. Open questions / deferrals

- **Exact SQLite version to pin.** Current thought: 3.45.x (stable, widely tested with sqlite-vec). Decide at build time; lock via the `scripts/build-sqlite.sh` URL.
- **Signed releases.** macOS Gatekeeper will flag unsigned binaries with "can't be opened because it is from an unidentified developer." Options: (a) `xattr -d com.apple.quarantine ~/.cfcf/bin/cfcf` in the install script (works, gross), (b) Apple Developer signing ($99/yr, real fix), (c) detailed Gatekeeper-bypass instructions in the error path. v1 ships (a) + docs; (b) is a later call.
- **Linux distro coverage.** The generic `linux-x64` tarball should work on modern glibc-based distros. Musl (Alpine) is separate — probably out of scope until someone asks.
- **Auto-update.** `cfcf self-update` could re-run the install script for the same `~/.cfcf/` location. Nice-to-have; not in 5.5.
- **Uninstall.** `rm -rf ~/.cfcf` + remove `/usr/local/bin/cfcf` — should be a `scripts/uninstall.sh` in the tarball, document it.
- **Node prerequisite wording.** Bun-compiled binary is standalone, but we should proactively update the README's "prerequisites" section to remove the Bun v1.3+ line for *users* (it stays for *developers*).
- **Domain hosting (Q2).** Pick between open-sourcing `cfcf` itself vs. a dedicated public `cfcf-releases` repo. Decide before Phase 2.

## 11. Pick-up checklist for whoever builds this

When 5.5 gets scheduled, here's the order of operations:

1. Decide Q2 hosting (open-source cfcf *or* create public `cfcf-releases`). Everything else runs fine on phase-0 local testing first.
2. Write `scripts/build-sqlite.sh` (shell, gcc, amalgamation URL).
3. Write `scripts/fetch-sqlite-vec.sh` (curl from sqlite-vec GH Releases).
4. Write `scripts/stage-runtime-deps.sh` (`bun install --production` into a staging dir, strip dev files).
5. Write `scripts/package-tarball.sh` (tar czf with the §4 layout).
6. Write `scripts/install.sh` (per §7).
7. Wire `Database.setCustomSQLite(...)` in `packages/core/src/clio/db.ts` (per §5).
8. Write `.github/workflows/release.yml` (per §6).
9. Write `docs/guides/installing.md` covering install + uninstall + troubleshooting.
10. Tag a pre-release (e.g. `v0.9.0-rc.1`) to trigger the workflow; smoke-test the install from a fresh VM per platform.
11. Update README.md user prereqs (remove Bun-v1.3+ line for end users; keep it for dev setup).
12. Flip plan.md 5.5 to ✅ and link back to this doc.

This doc captures enough for any future session to pick up without re-deriving the decisions above.
