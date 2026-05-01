# Installer design — plan item 5.5

> **⚠️ Historical / superseded.** This document captures the original 5.5 design. The shipped installer (v0.16.4, plan item 5.5b) **switched from `bun install -g` to `npm install -g --prefix ~/.bun`** to dodge bun's transitive-postinstall blocking ([oven-sh/bun#4959](https://github.com/oven-sh/bun/issues/4959)) without forcing a `bun pm trust` UX on first-time users. Final design + the four-option decision journey are in [`docs/decisions-log.md`](../decisions-log.md) (2026-05-01 entry); user-facing install instructions are in [`docs/guides/installing.md`](../guides/installing.md). Read this doc for context on **why npm-format distribution** + the platform-native split — the install **mechanism** described below (`bun install -g <tarball>`) is now only one of two supported paths (the bun-only alternative).

**Status:** design, implementation-ready. Feeds plan item 5.5.
**Author:** rewritten 2026-04-26 after the failed `bun --compile` attempt — see `docs/decisions-log.md` for the path that led here.
**Cross-refs:** [`docs/plan.md`](../plan.md) row 5.5, [`docs/design/clio-memory-layer.md`](../design/clio-memory-layer.md) §4 (Clio SQLite stack), plan items 6.15 (sqlite-vec HNSW), 6.20 (web-UI new-version notification), 6.21 (cfcf init defaults from existing config).

This doc captures the cfcf distribution model: how we build, package, publish, and install cfcf on user machines. It replaces an earlier 1600-line draft that targeted a self-contained Bun-compiled binary; that approach hit unworkable limits with our heavy native deps (`onnxruntime-node`, `sharp`). See decisions log for the detailed history.

---

## 1. The model in one paragraph

cfcf is a Node-ecosystem CLI distributed as a standard npm-format tarball. The tarball contains pre-bundled JavaScript source (one file via `bun build`, no `--compile`) + a `package.json` declaring the runtime dependencies. Users install with `bun install -g <tarball>` (or `npm install -g <tarball>`); their own Bun runtime executes the CLI; runtime deps download via the standard npm resolver to the user's global `node_modules/`. **cfcf requires Bun ≥ 1.3 at runtime.** A small `install.sh` wrapper provides a curl-bash UX that installs Bun if the user doesn't have it, then runs the install.

Phasing:

- **Now (cfcf private)**: distribute the tarball via GitHub Releases on a `cfcf-releases` repo. User installs via `bun install -g <release-asset-URL>` or via our wrapper.
- **Later (cfcf goes OSS)**: publish to npmjs.com under `@cerefox/codefactory`. User installs via `bun install -g @cerefox/codefactory`. Tarball-via-Releases stays as a fallback for offline / pinned-version installs.

Same package shape works for both phases — only the install URL changes.

---

## 2. Why this shape (decisions captured)

Detailed rationale lives in `docs/decisions-log.md` 2026-04-26 entries. The decisions:

- **No `bun --compile`.** Bun's compile-mode runtime resolver searches only the embedded `/$bunfs/root/` filesystem; it doesn't walk to disk for `--external` modules. With our heavy native deps (`onnxruntime-node`, `sharp`, `@huggingface/transformers`) this is a hard wall — those deps can't be bundled (native `.node` addons + dynamic `require()` patterns) and Bun won't load them from a colocated `node_modules/` either.
- **Bun is a runtime requirement.** cfcf uses `bun:sqlite`, `Bun.spawn`, `Bun.file`, `Bun.serve` throughout. Refactoring to Node-compat would replace each one (`better-sqlite3`, `child_process.spawn`, `fs/promises`, `http.createServer`) — non-trivial, and would lose the perf benefits we built around `bun:sqlite`. Embracing Bun is the honest choice.
- **npm-format tarball, not native binary.** Same shape every Node-ecosystem CLI uses (`vercel`, `yarn`, `openclaw`, etc.). User's runtime resolves transitive deps normally via standard npm-style resolution. transformers + ORT-node work without contortions.
- **Phase from private GitHub Releases → public npmjs.com**. Avoids requiring an npmjs.com account for v0.10.0; the same package format scales when cfcf opens up.

---

## 3. Build pipeline

### 3.1 What "build" produces

```
dist/
├── cfcf-X.Y.Z.tgz              # npm-format tarball
└── cfcf-X.Y.Z.tgz.sha256       # checksum
```

The tarball contents (rooted at `package/` per npm convention):

```
package/
├── package.json                 # bin, dependencies, optionalDependencies (per-platform native), engines.bun, etc.
├── bin/
│   └── cfcf.js                  # tiny shebanged entry: `#!/usr/bin/env bun` + `import "../dist/cfcf.js"`
├── dist/
│   └── cfcf.js                  # bundled JS (single file via bun build)
└── README.md                    # short pointer to docs
```

Tarball size: small (~5–10 MB depending on bundle compression). The big native deps live as the user's transitive deps after install, fetched from npmjs.com.

### 3.2 Per-platform native packages

The pinned SQLite + sqlite-vec story stays. They become **per-platform optional npm packages** declared in cfcf's `package.json`:

```jsonc
{
  "optionalDependencies": {
    "@cerefox/codefactory-native-darwin-arm64": "X.Y.Z",
    "@cerefox/codefactory-native-darwin-x64":   "X.Y.Z",
    "@cerefox/codefactory-native-linux-x64":    "X.Y.Z"
  }
}
```

Each `@cerefox/codefactory-native-<platform>` package contains:

- `libsqlite3.<dylib|so|dll>` — built from the SQLite amalgamation with `SQLITE_ENABLE_LOAD_EXTENSION=1`
- `sqlite-vec.<dylib|so|dll>` — vendored from the upstream sqlite-vec GH release

`os` + `cpu` fields in each package's `package.json` make npm install only the right one for the user's platform. Pattern is identical to what Claude Code, sharp, swc, and esbuild use.

`applyCustomSqlite()` in `packages/core/src/clio/db.ts` looks up the platform package via `require.resolve('@cerefox/codefactory-native-<platform>/...')` and points `Database.setCustomSQLite()` at the right path. No `~/.cfcf/native/` directory; everything lives in the standard `node_modules/` tree.

### 3.3 Build scripts

| Script | Role |
|---|---|
| `scripts/build-sqlite.sh` | Compiles libsqlite3 from the pinned amalgamation (still needed) |
| `scripts/fetch-sqlite-vec.sh` | Downloads the pinned sqlite-vec release asset (still needed) |
| `scripts/build-native-package.sh` | NEW: Wraps the two above, copies the libs into `packages/native-<platform>/`, runs `bun pm pack` to produce `@cerefox/codefactory-native-<platform>-X.Y.Z.tgz` |
| `scripts/build-cli.sh` | NEW: Runs `bun build` (no `--compile`) to bundle `packages/cli/src/index.ts` → `dist/cfcf.js`, copies `package.json`/`bin/`/etc., runs `bun pm pack` → produces `cfcf-X.Y.Z.tgz` |
| `scripts/install.sh` | Slimmed: ~30 lines. Detects Bun; installs via `https://bun.sh/install` if missing; then `bun install -g <tarball>` |
| `scripts/uninstall.sh` | `bun uninstall -g cfcf` (one line) |
| `scripts/serve-dist.ts` | Phase-0 dev helper for testing install.sh against `file://` or local HTTP — kept |
| `scripts/smoke-tarball.sh` | Adapted: untars, runs `bun install -g`, `cfcf doctor`, smoke-tests CLI surface |
| ~~`scripts/build-release-tarball.sh`~~ | Deleted |
| ~~`scripts/stage-runtime-deps.sh`~~ | Deleted |
| ~~`scripts/resolve-runtime-deps.js`~~ | Deleted |
| ~~`scripts/write-manifest.sh`~~ | Deleted (MANIFEST.txt becomes the per-release notes; package.json holds version) |

---

## 4. install.sh wrapper

~30 lines. Provides the curl-bash one-liner UX. Bootstraps Bun if missing.

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${CFCF_VERSION:=latest}"
: "${CFCF_BASE_URL:=https://github.com/fstamatelopoulos/cfcf-releases/releases/${CFCF_VERSION/latest/latest}/download}"

# 1. Ensure Bun is on PATH; install if missing.
if ! command -v bun >/dev/null 2>&1; then
  echo "[cfcf] Bun not found. Installing via Bun's official installer..."
  curl -fsSL https://bun.sh/install | bash
  # Update PATH for this shell so the next line finds bun
  export PATH="$HOME/.bun/bin:$PATH"
fi

# 2. Resolve the tarball URL. CFCF_BASE_URL can point at HTTP, HTTPS, or
#    file:// (Phase-0 dev). For the latest-release URL pattern, we follow
#    GitHub's redirect.
tarball_url="$CFCF_BASE_URL/cfcf-$CFCF_VERSION.tgz"

echo "[cfcf] Installing cfcf $CFCF_VERSION from $tarball_url"
bun install -g "$tarball_url"

# 3. Hand off to cfcf init unless skipped.
if [[ -z "${CFCF_SKIP_INIT:-}" ]] && [[ -t 0 ]]; then
  echo "[cfcf] Press Enter to run 'cfcf init' now, or Ctrl-C to exit."
  read -r _ </dev/tty 2>/dev/null || true
  exec cfcf init
fi
```

That's it. No tarball staging, no native-binary handling, no Gatekeeper xattr (Bun handles its own binary; cfcf is JS).

For users who prefer an explicit install: `bun install -g <tarball-url>` works directly without the wrapper.

---

## 5. Release CI

`.github/workflows/release.yml` (workflow_dispatch only, decision from 2026-04-26). Inputs: `tag` + optional `prerelease`.

Phases:

1. **verify**: tag exists + reachable from main.
2. **build-native**: per-platform matrix (darwin-arm64, darwin-x64, linux-x64). Each leg runs `scripts/build-native-package.sh` → produces `@cerefox/codefactory-native-<platform>-X.Y.Z.tgz`.
3. **build-cli**: single job. Runs `scripts/build-cli.sh` → produces `cfcf-X.Y.Z.tgz`.
4. **release**: assembles `SHA256SUMS`, uploads all 4 tarballs (1 cli + 3 native) + `install.sh` + `SHA256SUMS` as GitHub Release assets via `gh release create`.

Skipped phases vs the old design: no smoke-tarball-end-to-end (the build itself is the smoke; a typecheck + `bun test` + `bun pm pack` validates it). We can add a smoke if it becomes a problem.

---

## 6. Distribution phases

| Phase | Trigger | User's install command |
|---|---|---|
| 0 (dev) | Local | `CFCF_BASE_URL=file://$(pwd)/dist bash install.sh` or `bun install -g ./dist/cfcf-X.Y.Z.tgz` |
| 1 (cfcf private) | After 5.5 ships | `curl -fsSL https://github.com/fstamatelopoulos/cfcf-releases/releases/latest/download/install.sh \| bash` or `bun install -g <tarball-URL>` |
| 2 (cfcf public) | After cfcf-the-repo is open-sourced + `bun publish` runs | `bun install -g @cerefox/codefactory` |

The `install.sh` wrapper is the **same shell script** in phases 1 and 2 — only `CFCF_BASE_URL` defaults change. Or we deprecate `install.sh` entirely in phase 2 since `bun install -g @cerefox/codefactory` is already a one-liner.

---

## 7. Source-side changes

`packages/cli/src/index.ts`: shebang `#!/usr/bin/env bun`. Top of file detects mismatched runtime (e.g., user invoked under Node not Bun) and exits with a clear message.

`packages/core/src/clio/db.ts`: `applyCustomSqlite()` resolves the platform-specific native package via `require.resolve`. Falls back to system SQLite (= no-op) if not present (dev mode).

`packages/cli/src/commands/self-update.ts`: reads installed cfcf version via `bun pm ls -g`, compares to latest tag from `<base>/MANIFEST.txt`, runs `bun install -g <new-tarball>` to upgrade.

`packages/cli/src/commands/doctor.ts`: simplified — checks Bun version, presence of the platform native package, runtime sanity. No more "is colocated node_modules wired" check.

---

## 8. Trade-offs accepted

- **Users need Bun.** Either pre-installed or installed by our wrapper. Acceptable for our developer-tooling audience.
- **First install does network**: npm fetches transformers + ORT-node + sharp from npmjs.com (~150 MB). Fine over normal connections; offline installs need the bundled-deps tarball form (future, if needed).
- **No "self-contained binary".** Users see "cfcf is installed in `~/.bun/install/global/`," not "cfcf-binary is at `/usr/local/bin/cfcf`." Mental model is "global npm tool" — same as every other CLI from the JS ecosystem.

---

## 9. Open questions / future work

- **Going public**: when cfcf opens up, register `@cerefox` org on npmjs.com, run `bun publish`. Update `install.sh` default `CFCF_BASE_URL` to point at npmjs.com via `bun install -g @cerefox/codefactory`. (Plan item 5.5b — minor follow-up.)
- **Offline installs**: if a user can't reach npmjs.com, the current model breaks (transformers + ORT have to be fetched). Workaround: a "fat tarball" build that includes `bundleDependencies`. Track as future plan item if requested.
- **Windows**: same as before — v1 is Mac + Linux. Windows users use WSL or wait for a Phase 4 PowerShell installer.
- **Auto-update polling**: web-UI banner that surfaces "new version available" — plan item 6.20.
- **`cfcf init` defaults from existing config**: when re-running init on a configured machine, the prompts should default to the existing values, not the hardcoded defaults — plan item 6.21.

---

## 10. Build checklist (rolling, kept here)

- [x] Decision: drop `bun --compile`; commit to npm-format distribution (2026-04-26)
- [x] Decision: Bun is a runtime requirement; install.sh installs it for users (2026-04-26)
- [x] Decision: distribute via GitHub Releases tarball now → npmjs.com when cfcf goes public (2026-04-26)
- [ ] Refactor `packages/cli/src/index.ts` shebang + drop `bun build --compile` from build scripts
- [ ] `scripts/build-cli.sh` — new build script that produces `cfcf-X.Y.Z.tgz`
- [ ] `scripts/build-native-package.sh` — produces per-platform `@cerefox/codefactory-native-<platform>-X.Y.Z.tgz`
- [ ] `packages/core/src/clio/db.ts` — `applyCustomSqlite()` via `require.resolve` of the platform package
- [ ] Replace `scripts/install.sh` with the slim ~30-line wrapper
- [ ] Replace `scripts/uninstall.sh` with `bun uninstall -g cfcf` (one-liner)
- [ ] Delete `scripts/build-release-tarball.sh`, `scripts/stage-runtime-deps.sh`, `scripts/resolve-runtime-deps.js`, `scripts/write-manifest.sh`
- [ ] Update `scripts/smoke-tarball.sh` to install + cfcf doctor + smoke commands
- [ ] Rewrite `.github/workflows/release.yml` for the new build/release shape
- [ ] Update `docs/guides/installing.md` with the new install one-liner + manual `bun install -g` path
- [ ] Update `README.md` prereqs (Bun ≥ 1.3 required for end users; same for devs)
- [ ] Phase-0 dogfood install on Intel Mac
- [ ] Mark plan item 5.5 ✅ + link this doc
