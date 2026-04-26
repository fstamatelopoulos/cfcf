# Installer design — plan item 5.5

**Status:** design, implementation-ready. Feeds plan item 5.5.
**Author:** drafted 2026-04-22, expanded 2026-04-22 after follow-up review.
**Cross-refs:** [`docs/plan.md`](../plan.md) row 5.5, [`docs/design/clio-memory-layer.md`](../design/clio-memory-layer.md) §4 (Clio SQLite stack), plan items 6.15 (sqlite-vec HNSW), 6.19 (onboarding — embedder pre-warm).

This doc is the single source of truth for the installer. It should have enough detail that a fresh session can pick up and build without re-deriving decisions. Where bash snippets appear, they are copy-ready with the caveat that version pins + URLs should be re-verified at build time.

---

## Table of contents

1. Scope + end-user experience
2. Decisions (the four follow-up questions, answered)
3. Full architecture + call-chains
4. The SQLite story (6.15 infra)
5. Phase 0 dev loop (how to test before CI works)
6. Release CI details (GitHub Actions spec)
7. Tarball layout + manifest
8. Build scripts (ready-to-copy bash)
9. Install script (full spec)
10. Uninstall + self-update
11. Binary-side source changes
12. Docs + README updates
13. Testing strategy
14. Rollout phases
15. Open questions
16. Pick-up checklist

---

## 1. Scope + end-user experience

End-user one-liner:

```
curl -fsSL https://<host>/install.sh | bash
# installer drops the binary, then runs cfcf init interactively (or
# accepts answers via flags / stdin -- see §1.1).
```

Behind the scenes the installer must:

1. Detect platform (`uname -s` / `uname -m`).
2. Download the per-platform tarball + its `.sha256` from GitHub Releases.
3. Verify the checksum.
4. Unpack into `~/.cfcf/` (layout in §7).
5. Symlink `~/.cfcf/bin/cfcf` → `/usr/local/bin/cfcf` (or print a PATH-update instruction if that path isn't writable).
6. Smoke-test `cfcf --version`.
7. **Print "installation complete" + wait for Enter (interactive only).** When the user presses Enter, exec `~/.cfcf/bin/cfcf init`. Setting `CFCF_SKIP_INIT=1` skips the prompt + handoff entirely. See §1.1.
8. After `cfcf init` returns (or is skipped), print a "next steps" hint pointing at workspace creation.

**Out of scope for the installer:**

- Embedder model download as a separate step — `cfcf init` (run by the installer in step 7) already downloads + activates + warms the user-picked embedder when one is selected. No `--with-embedder` flag needed on the installer; init handles it.
- Installing agent CLIs (`claude-code`, `codex`, git) — those are third-party tools with their own install paths. The installer prints their install URLs on first-run if missing.
- Auto-update (`cfcf self-update` is future work — see §10).

### 1.1 The `cfcf init` hand-off — interactive only (decision 2026-04-25)

`cfcf init` is fully interactive: ~10 questions (agent picks, model picks, max iterations, pause cadence, autoReviewSpecs, autoDocumenter, notifications, embedder pick, permissions ack). The installer assumes a human is at the keyboard and chains directly into init at the end of the install:

```
[cfcf] cfcf v0.9.0 installed at ~/.cfcf/.
[cfcf] symlinked /usr/local/bin/cfcf
[cfcf] smoke test: cfcf 0.9.0 (bun 1.3.x, sqlite 3.46.0+vec0.1.6)

[cfcf] Installation complete.
       Next: cfcf init walks you through agent + embedder + permission setup.
       Press Enter to run it now, or Ctrl-C to exit and run `cfcf init` yourself later.
```

The script then waits for Enter and execs `cfcf init`. End state after init returns: agents configured, embedder downloaded + active + warmed (per the 2026-04-25 init behaviour), permissions acknowledged.

**The `</dev/tty` wrinkle.** When the user runs `curl -fsSL ... | bash`, the script's stdin is the curl pipe, not the terminal — so a plain `read` returns immediately with empty input. Standard installer pattern (rustup, nvm) is to read from `/dev/tty` directly:

```bash
# Wrong -- reads from the curl pipe (empty), exec'd immediately:
read -r -p "Press Enter to continue: "

# Right -- reads from the actual terminal even when stdin is a pipe:
read -r -p "Press Enter to continue: " </dev/tty
```

Same trick applies if anything in the installer ever needs input. `cfcf init` itself uses `node:readline` which already opens `/dev/tty` correctly when run as a fresh process, so the install script's `exec ~/.cfcf/bin/cfcf init` works without further plumbing.

**What about non-interactive provisioning?** Out of scope for now (no concrete demand). If/when fleet provisioning, devcontainer post-create, or CI installs become a real use case, the path is to add a `--non-interactive` mode to `cfcf init` (with per-prompt flags + env vars) and an `--unattended` flag to the install script that picks the non-interactive branch automatically when stdin isn't a TTY. Sketched below for whoever picks it up — not built or tracked as a current plan item:

> _Future:_ `cfcf init --non-interactive --dev-agent claude-code --embedder nomic-embed-text-v1.5 --acknowledge-permissions [...]`. All defaults match the interactive defaults so the minimal invocation has only the agent + permission ack as required. `--acknowledge-permissions` always required (no silent yes for permission ack). Equivalent env vars (`CFCF_INIT_*`) for callers that prefer env over flags. Install script detects `! -t 0` and uses this branch with values pulled from env, exiting non-zero if required answers are missing.

### 1.2 Skipping the init handoff entirely

Power users may want the binary on disk without running init right now (e.g. they want to inspect `~/.cfcf/` first, or they're scripting). The script supports `CFCF_SKIP_INIT=1` (or `--skip-init` flag) which prints next-steps and exits without launching init. The `</dev/tty` read is also skipped under that flag so the script is fully unattended.

```bash
CFCF_SKIP_INIT=1 curl -fsSL ... | bash
# → installs binary, prints "Run cfcf init when ready", exits 0.
```

### 1.3 Server-coexistence during `cfcf init`

Whether `cfcf server` is running while the installer triggers `cfcf init`:

- **Safe** (no data corruption): SQLite handles concurrent access via WAL mode; config writes are atomic via temp-file-and-rename.
- **But staleness** if the server is up: the server's `LocalClio` singleton holds an in-memory cached embedder reference loaded at server start. When init writes a new active-embedder row, the running server keeps using the old reference until restart. Init has no way to reach into a separate process to invalidate that cache today.
- **Recommendation:** the install script should detect a running server and either prompt to stop+restart or print a warning. The default install flow assumes no server is running yet (it's a fresh install).
- **Future refinement:** a small `POST /api/clio/embedders/invalidate-cache` endpoint that init pings after a successful active-embedder write. Then init + a running server play together cleanly. Not blocker for 5.5; track as a small follow-up under 6.19 polish.

The install script's check (rough sketch):

```bash
if pgrep -f "cfcf server" >/dev/null 2>&1; then
  echo "[cfcf] cfcf server is running. Please stop it first:"
  echo "         cfcf server stop"
  echo "       Then re-run this installer."
  exit 1
fi
```

---

## 2. Decisions — the four follow-up questions, answered

### Q1. Release CI shape

**Decision: tag on `main` → release workflow → standard GitHub Release with all assets.**

- **Trigger:** `workflow_dispatch` only (decided 2026-04-26). Manual run via the GitHub Actions UI or `gh workflow run release.yml -f tag=v0.10.0`. The workflow takes a `tag` input + an optional `prerelease` flag. Tag must already exist + be reachable from `main` (verified in the first job). Tagging is a separate developer act — pushing a tag never triggers a release. See §6.1 for the full YAML.
- **Matrix:** `darwin-arm64`, `darwin-x64`, `linux-x64` for v1; `windows-x64` follow-up (Phase 4). Each matrix leg runs on a native runner (macOS for darwin, Ubuntu for linux, Windows-latest for windows) to avoid cross-compile headaches with the native deps.
- **Artifacts per leg** (all uploaded to the release):
  - `cfcf-<platform>-<version>.tar.gz` — the bundle (§7).
  - `cfcf-<platform>-<version>.tar.gz.sha256` — single-line `sha256 filename` format compatible with `sha256sum -c`.
  - A merged `SHA256SUMS` file (all platforms in one file) is assembled in a final release-summary job and uploaded too, for users who want to cross-verify.
- **Release-level artifacts** (from the `release` job, not per-platform):
  - `install.sh` — the bash installer (single file, platform-aware internally).
  - `install.ps1` — the PowerShell installer (Phase 4; stub in v1).
  - `MANIFEST.txt` — version pins for cfcf, bun, sqlite, sqlite-vec, transformers, onnxruntime-node, sharp.
  - `SHA256SUMS` — as above.
- **Release creation:** `gh release create "$GITHUB_REF_NAME" --generate-notes --verify-tag <all-assets>`. `--generate-notes` builds release notes from PR titles merged since the last tag. For `v*-rc.*` tags we add `--prerelease`.
- **"Latest" pointer:** `gh release create` with `--latest` marks the newest non-prerelease as `/releases/latest/download/*`. The installer relies on this for `CFCF_VERSION=latest`.
- **Permissions:** `GITHUB_TOKEN` with `contents: write` is enough for `gh release create` on the same repo. No PAT required.
- **Concurrency:** `concurrency: release-${{ github.ref }}` + `cancel-in-progress: false` so two tags never fight.

Full YAML in §6.

### Q2. Where the install URL lives — four phases, no confusion

The confusion in the earlier draft was collapsing "where the script is hosted" with "where the binary tarball is hosted." They're separate:

|   | Install script | Release tarballs |
|---|---|---|
| **Phase 0** (local dev) | Served from `bun run scripts/serve-dist.ts` on localhost | Built manually on the dev's laptop, served from the same localhost dir |
| **Phase 1** (private CI) | Uploaded as a release asset to the private `cfcf` repo; users download via `gh release download` (needs a PAT) | Uploaded by CI to private `cfcf` repo releases |
| **Phase 2** (public releases repo) | Served from `https://raw.githubusercontent.com/fstamatelopoulos/cfcf-releases/main/install.sh` — anonymous `curl` works | Uploaded by CI to `cfcf-releases` public repo; anonymous download via `https://github.com/fstamatelopoulos/cfcf-releases/releases/latest/download/<file>` |
| **Phase 3** (vanity domain) | `https://cerefox.org/install` → HTTP-302 → Phase 2 URL | Same as Phase 2; `cfcf-releases` is still the real origin |
| **Phase 4** (windows) | Adds `install.ps1` alongside; no change to the bash one | Adds `cfcf-windows-x64-<version>.zip` to each release |

Phase 0 and Phase 1 need **no new repo** — they work on what exists today. Phase 2 is the first user-visible shape and requires either open-sourcing `cfcf` or creating a dedicated `cfcf-releases` public repo. The install script is identical across all phases; only the **default `CFCF_BASE_URL`** changes, and it's overridable via env var, so the same script works in every phase.

### Q3. SQLite — the plan

**Yes, the installer handles the SQLite story.** We ship our own libsqlite3 per platform with `loadExtension` enabled, and the binary wires it via `Database.setCustomSQLite(...)`. This is how:

**Components:**

| Component | Source | Where it lives |
|---|---|---|
| bun runtime | embedded in `cfcf-binary` by `bun --compile` | `~/.cfcf/bin/cfcf` |
| bun:sqlite wrapper | built into bun | embedded in `cfcf-binary` |
| **libsqlite3** (our pinned build) | compiled in release CI from amalgamation | `~/.cfcf/native/libsqlite3.<ext>` |
| **sqlite-vec.\<ext\>** | downloaded in release CI from sqlite-vec's GH Releases | `~/.cfcf/native/sqlite-vec.<ext>` |
| Clio DB | created by the binary on first run | `~/.cfcf/clio.db` |

**Call chain on every `cfcf` invocation:**

```
1. cfcf process starts.
2. Before the first `new Database(...)` call, cfcf runs
   setCustomSqliteIfAvailable() (packages/core/src/clio/db.ts, §11):
      - reads ~/.cfcf/native/libsqlite3.<ext>
      - if present: calls Database.setCustomSQLite(path)
      - if absent: no-op (dev mode, or a partial install -- FTS5 still
        works against the system SQLite but loadExtension may be disabled)
3. Clio opens clio.db using the (now-custom) bun:sqlite.
4. Clio v1 (no extensions): runs migrations, queries FTS5. Done.
5. Clio v2 (item 6.15): additionally calls
      db.loadExtension(path.join(CFCF_NATIVE_DIR, "sqlite-vec"))
   Works because the custom libsqlite3 has SQLITE_ENABLE_LOAD_EXTENSION=1.
```

**What 6.15 is going to need (and therefore what 5.5 must provide):**

- A SQLite build where `loadExtension` works on every platform (macOS disables it by default in the system SQLite).
- sqlite-vec's `.dylib` / `.so` / `.dll` available at a known path.
- A way for Bun to use our custom SQLite: this is exactly what `Database.setCustomSQLite(path: string)` does — points bun:sqlite at a different libsqlite3 instead of the system one. Called once at process start, before any DB is opened.

**Where we get sqlite-vec.** From [github.com/asg017/sqlite-vec/releases](https://github.com/asg017/sqlite-vec/releases). They publish prebuilt loadable extensions per platform as `.tar.gz` archives containing a single `.dylib` / `.so` / `.dll`. Version pinned in the release CI (§6). Do **not** download at install time — the tarball bundles it so installs are atomic and offline-friendly.

**What we compile ourselves.** libsqlite3 from the official amalgamation at [sqlite.org/download.html](https://sqlite.org/download.html). Tiny C code, compiles in seconds. Flags:

```
-DSQLITE_ENABLE_LOAD_EXTENSION=1    # the whole point
-DSQLITE_ENABLE_FTS5=1              # Clio uses FTS5 already
-DSQLITE_ENABLE_JSON1=1             # our migrations use json_extract
-DSQLITE_ENABLE_RTREE=1             # future-proofing; ~30 kB
-DSQLITE_THREADSAFE=1               # Bun serializes access; needed anyway
-O2
# platform-specific:
darwin:  -dynamiclib -install_name @rpath/libsqlite3.dylib  -o libsqlite3.dylib
linux:   -shared -fPIC                                       -o libsqlite3.so
windows: /LD                                                 /Fe:sqlite3.dll
```

**Version pin policy (decided 2026-04-26):** SQLite + sqlite-vec versions are **explicitly pinned per cfcf release**. Constants live in `scripts/build-sqlite.sh` + `scripts/fetch-sqlite-vec.sh`, are recorded in each tarball's `MANIFEST.txt`, and are bumped intentionally per cfcf release after verifying compatibility (sqlite-vec's CHANGELOG documents the minimum SQLite it expects). Bumping is a deliberate human act, not an automatic "use whatever's latest" build-time lookup — that would let a sqlite-vec breaking change silently land in a cfcf release.

Starting pins (verified 2026-04-26):
- **SQLite 3.53.0** (latest stable; amalgamation at `https://sqlite.org/2026/sqlite-amalgamation-3530000.zip`). For reference, Bun's bundled `bun:sqlite` reports 3.43.2 — the custom-SQLite path gives us a 10-version-newer engine + extension-loading where Apple's system lib disables it.
- **sqlite-vec 0.1.9** (latest stable; assets at `https://github.com/asg017/sqlite-vec/releases/download/v0.1.9/sqlite-vec-0.1.9-loadable-{macos-aarch64,macos-x86_64,linux-x86_64,windows-x86_64}.tar.gz`). 0.1.9 added metadata columns + partition-key support to vec0; backwards-compatible with the earlier 0.1.x API our 6.15 work targets.

**Why not just use bun's system SQLite everywhere?** Three reasons:

1. **macOS:** Apple's system SQLite is built with `SQLITE_OMIT_LOAD_EXTENSION` → `loadExtension()` silently errors. 6.15 breaks on every Mac. This is the biggest driver.
2. **Linux distro drift:** Ubuntu 22.04, Debian 12, Amazon Linux 2, Alpine all ship different SQLite versions. sqlite-vec's ABI requirements may not match. A pinned build eliminates drift.
3. **Deterministic behavior across users:** FTS5 tokenizer internals + UPSERT semantics vary slightly between SQLite versions. Pinning means a bug reproduced on one machine reproduces on every machine.

**Does Clio v1 still work without the custom SQLite?** Yes. `setCustomSqliteIfAvailable()` is a no-op when the file is absent, and Clio v1 only uses FTS5, which every system SQLite has. 6.15 will error loudly if the custom SQLite isn't present when it tries `loadExtension` — the error message points the user at reinstalling via `curl | bash`.

### Q4. Native deps, Bun-is-not-a-user-prereq, Option A tarball, Windows

**Key correction:** Bun's `--compile` embeds the Bun runtime inside `cfcf-binary`. End users need **nothing** on their machine — no Bun, no Node, no npm. The README's "Bun v1.3+" line is a **developer** prerequisite.

Given that, the three externalized native deps (`@huggingface/transformers`, `onnxruntime-node`, `sharp`) need to resolve at runtime without the user's help. The only feasible shape is **Option A — self-contained tarball**:

- Release CI runs `bun install --production` during the build, producing a pruned `node_modules/` with just these three deps (and their transitive native-addon deps).
- The tarball includes `node_modules/` colocated next to the `cfcf` binary.
- Bun's module resolution walks up from the binary's directory looking for `node_modules/`, so colocated = automatic. No `NODE_PATH` shim needed.
- Per-platform tarball carries only that platform's native-addon variants. The darwin-arm64 tarball doesn't contain darwin-x64 `.node` files, etc.

**Size estimate:**

| Component | Size |
|---|---|
| `cfcf-binary` (Bun-compiled, Bun runtime included) | ~65 MB |
| `onnxruntime-node` (platform .node addon) | ~40 MB |
| `@huggingface/transformers` | ~30 MB |
| `sharp` (platform .node addon) | ~10 MB |
| `libsqlite3.<ext>` | <1 MB |
| `sqlite-vec.<ext>` | <1 MB |
| misc (MANIFEST, licence concatenation) | <100 kB |
| **Total per tarball** | **~150 MB** |

Acceptable for a local LLM-tool install.

**What's bundled vs. lazy (confirmation, 2026-04-22 follow-up):**

Everything cfcf needs to **run** ships in the tarball. The only intentional lazy-download is the embedder model. Note (2026-04-25 clarification): the embedder model normally downloads during `cfcf init` (when the user picks one) — `cfcf init` is the canonical "configure this machine" step. The installer's `--with-embedder` flag (§10 / 6.19) becomes the non-interactive provisioning equivalent: it lets a fleet provisioning script pre-cache the model without a human running `cfcf init`. A user who skips the embedder during `cfcf init` (picks "S") gets FTS-only mode until they run `cfcf clio embedder install`.

| Ships in the tarball | Lazy-downloaded after install |
|---|---|
| `cfcf` binary (Bun runtime embedded) | Embedder model weights (~20-430 MB depending on catalogue pick; goes to `~/.cfcf/models/` on first use per 5.7) |
| `bin/node_modules/` (transformers, onnxruntime-node, sharp, all transitive deps) | Future: user-chosen alternate embedder if they `cfcf clio embedder install <other>` |
| `native/libsqlite3.<ext>` (our pinned build with loadExtension enabled) | |
| `native/sqlite-vec.<ext>` (fetched in release CI at build time, not at install time) | |
| `MANIFEST`, `LICENSE`, `uninstall.sh` | |

Consequence: a user with no network after install can still `cfcf init`, skip the embedder, and run cfcf in FTS-only mode. All DB / agent-orchestration / Clio-keyword-search paths work offline. Only semantic-search hybrid mode requires the later one-time embedder download. That's the intentional boundary.

6.19's pending `--with-embedder <name>` flag on `install.sh` would collapse even the embedder download into the initial install for users who want a truly one-shot "ready to go" experience. Tracked separately; not in 5.5.

**Windows story in v1 vs. follow-up:**

- **v1:** ship a `cfcf-windows-x64-<version>.zip` alongside Mac/Linux tarballs (so it's available for manual download from the GitHub release page), **no** PowerShell installer yet. Windows users manually unzip + add to PATH. Document this in `docs/guides/installing.md`.
- **Phase 4 follow-up:** `install.ps1` with the same logic as the bash installer. Installs to `%LOCALAPPDATA%\cfcf\`, updates PATH via registry. `irm https://<host>/install.ps1 | iex` as the one-liner.
- **WSL** as a no-extra-work fallback: the Linux installer works unchanged inside WSL.

Decision: Windows v1 supports **manual unzip** (W3 in the previous draft); Phase 4 adds the installer.

---

## 3. Full architecture + call-chains

### 3.1 Install-time flow

```
User runs:  curl -fsSL https://<host>/install.sh | bash

┌─ install.sh (running on user's machine) ─────────────────────────┐
│                                                                   │
│ 1. detect OS + arch                                               │
│       os="$(uname -s)"                                            │
│       arch="$(uname -m)"                                          │
│       case $os-$arch in Darwin-arm64) platform=darwin-arm64 …     │
│                                                                   │
│ 2. resolve release URLs                                           │
│       CFCF_BASE_URL ??= https://github.com/fstamatelopoulos/cfcf-releases   │
│                       /releases/latest/download                   │
│       tarball="cfcf-${platform}-${version}.tar.gz"                │
│                                                                   │
│ 3. download tarball + sha256 to $(mktemp -d)                      │
│       curl -fsSL "$CFCF_BASE_URL/$tarball"     -o "$tmp/$tarball" │
│       curl -fsSL "$CFCF_BASE_URL/$tarball.sha256" -o "$tmp/$sha"  │
│                                                                   │
│ 4. verify checksum                                                │
│       (cd "$tmp" && sha256sum -c "$sha")                          │
│                                                                   │
│ 5. unpack                                                         │
│       tar xzf "$tmp/$tarball" -C "$HOME/.cfcf" --strip-components=1│
│                                                                   │
│ 6. symlink                                                        │
│       ln -sf "$HOME/.cfcf/bin/cfcf" "/usr/local/bin/cfcf"         │
│       (falls back to "add ~/.cfcf/bin to PATH" message)           │
│                                                                   │
│ 7. smoke test                                                     │
│       "$HOME/.cfcf/bin/cfcf" --version                            │
│                                                                   │
│ 8. print next-steps hint                                          │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### 3.2 Runtime flow (every `cfcf` invocation)

Verified end-to-end on Intel Mac during the 2026-04-26 Phase-0 smoke. Annotations updated to match what actually shipped.

```
                    ~/.cfcf/bin/cfcf   (bun-compiled standalone)
                           │
                           ▼
    ┌────────── Bun runtime (embedded) ─────────────────┐
    │                                                    │
    │  On openClioDb() — first new Database(...):        │
    │    1. applyCustomSqlite() (db.ts §11.1)            │
    │       reads CFCF_NATIVE_DIR or ~/.cfcf/native      │
    │    2. if libsqlite3.<ext> exists:                  │
    │         Database.setCustomSQLite(path)             │
    │       Verified: sqlite_version() returns the       │
    │       pinned 3.53.0, not bun's bundled 3.43.2      │
    │    3. open clio.db with the (now-custom) driver    │
    │                                                    │
    │  Item 6.15 (sqlite-vec HNSW, future):              │
    │    db.loadExtension(getSqliteVecPath().path,       │
    │                     "sqlite3_vec_init")            │
    │    Verified: vec0 KNN query returns the right      │
    │    nearest-neighbour result                        │
    │                                                    │
    │  On first embedder call:                           │
    │    resolve @huggingface/transformers via           │
    │    colocated node_modules/                         │
    │    (Bun's compile-mode resolver walks up from      │
    │     process.execPath; finds ~/.cfcf/bin/node_      │
    │     modules/)                                      │
    │    if not cached, transformers.js downloads the    │
    │    model to ~/.cfcf/models/                        │
    │                                                    │
    └────────────────────────────────────────────────────┘
```

### 3.3 Upgrade flow (re-running the installer on top of an existing install)

The installer is idempotent + non-destructive on user data. Re-running it produces an upgrade, never a wipe. Concrete contract:

| Path | Behaviour on upgrade |
|---|---|
| `~/.cfcf/bin/` | Replaced wholesale (binary + colocated node_modules/) |
| `~/.cfcf/native/` | Replaced wholesale (libsqlite3 + sqlite-vec, with whatever pins the new tarball ships) |
| `~/.cfcf/MANIFEST` | Replaced; new version + timestamps |
| `~/.cfcf/uninstall.sh` | Replaced |
| `~/.cfcf/clio.db` | **Preserved.** Migrations apply lazily on next openClioDb() — see below |
| `~/.cfcf/models/` | **Preserved.** Existing embedder downloads survive |
| `~/.cfcf/logs/` | **Preserved.** Per-workspace agent logs survive |
| Platform config dir (`~/Library/Application Support/cfcf/` on macOS, `$XDG_CONFIG_HOME/cfcf/` on Linux) | **Untouched** — installer never writes there |

This is enforced by `tar xzf … --strip-components=1` only matching what's *in* the tarball; entries the tarball doesn't contain are left as-is.

**Schema migration on upgrade:**

- **Clio DB** (`clio.db`) has a built-in migrations runner in `packages/core/src/clio/db.ts`. The `clio_migrations` table tracks what's applied; new schema = new `migrations/000N_name.sql` file embedded into the binary via `import ... with { type: "text" }`. `runMigrations()` skips already-applied entries idempotently. **Same pattern Cerefox uses** — file-based versioned migrations, no separate "migrate" command.
- **Workspace configs** at `<config-dir>/workspaces/<id>/config.json` go through `validateConfig()` on every read. New required fields are backfilled per `validateConfig`'s defaults; new optional fields are simply absent until the user / web UI sets them. Existing fields are never silently transformed — destructive schema changes require an explicit migration step (none planned for v1).
- **Global config** (same dir, `config.json`) also goes through `validateConfig()`. The `version` field (`CONFIG_VERSION` constant in `core/src/constants.ts`) lets us trigger explicit upgrade logic if/when a destructive change is unavoidable. Currently `1`; bump only on a real breaking change.

End user contract: **upgrading never loses data.** A user who has been ingesting into Clio for months upgrades the binary and finds every doc still searchable — possibly with new schema features available, never with old features broken.

### 3.4 Dependency resolution (colocated node_modules)

Bun's module resolver, when executing a compiled binary, walks up from `require.main`'s directory looking for `node_modules/`. Since our binary lives at `~/.cfcf/bin/cfcf` and the runtime deps live at `~/.cfcf/bin/node_modules/`, resolution "just works" with zero wiring. This is the same behavior Node.js has had since v0.x.

No `NODE_PATH` needed. No shim script needed. The symlink at `/usr/local/bin/cfcf` points at the real binary; resolution follows the real path, not the symlink.

---

## 4. The SQLite story — full detail (6.15 infra)

(Summarised above in §2 Q3; this section has the operational details.)

### 4.1 Why we can't just use `bun:sqlite` out of the box

`bun:sqlite` links against whatever libsqlite3 the OS provides. On macOS that's Apple's system SQLite built with `-DSQLITE_OMIT_LOAD_EXTENSION`. Bun itself can't change that — the compile-time flag was set by Apple when they built the system library. Result: `db.loadExtension("...")` silently fails on every Mac.

Bun exposes `Database.setCustomSQLite(path: string)` specifically to work around this. It replaces the default libsqlite3 at runtime with one the app ships. Documented at [bun.sh/docs/api/sqlite#setcustomsqlite](https://bun.sh/docs/api/sqlite#setcustomsqlite).

### 4.2 Compiling the pinned SQLite

Release CI step (platform-specific, see `scripts/build-sqlite.sh` in §8):

```bash
SQLITE_VERSION=3460000          # 3.46.0
curl -fsSL "https://sqlite.org/2024/sqlite-amalgamation-${SQLITE_VERSION}.zip" -o sqlite.zip
unzip -q sqlite.zip
cd sqlite-amalgamation-${SQLITE_VERSION}

CFLAGS="-DSQLITE_ENABLE_LOAD_EXTENSION=1 \
        -DSQLITE_ENABLE_FTS5=1 \
        -DSQLITE_ENABLE_JSON1=1 \
        -DSQLITE_ENABLE_RTREE=1 \
        -DSQLITE_THREADSAFE=1 \
        -O2"

case "$PLATFORM" in
  darwin-*)
    clang $CFLAGS -dynamiclib -install_name @rpath/libsqlite3.dylib \
          sqlite3.c -o libsqlite3.dylib ;;
  linux-*)
    gcc   $CFLAGS -shared -fPIC \
          sqlite3.c -o libsqlite3.so ;;
  windows-*)
    cl    $CFLAGS /LD sqlite3.c /Fe:sqlite3.dll ;;
esac
```

Builds in under 30 seconds per platform. Output: one file, ~1 MB.

### 4.3 Downloading sqlite-vec

sqlite-vec publishes prebuilt `.tar.gz` per platform in its releases. URL pattern (confirmed from its repo at design time):

```
https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/sqlite-vec-0.1.6-loadable-macos-aarch64.tar.gz
https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/sqlite-vec-0.1.6-loadable-macos-x86_64.tar.gz
https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/sqlite-vec-0.1.6-loadable-linux-x86_64.tar.gz
https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/sqlite-vec-0.1.6-loadable-windows-x86_64.tar.gz
```

(Version + exact URL format should be re-verified against [the sqlite-vec releases page](https://github.com/asg017/sqlite-vec/releases) at build time.)

Extract to get `vec0.<ext>` (sqlite-vec's filename) → rename to `sqlite-vec.<ext>` for consistency in our tarball.

### 4.4 Binary-side wiring

Single file change: add `setCustomSqliteIfAvailable()` to `packages/core/src/clio/db.ts`, called once before the first `new Database(...)`. Full code in §11.

### 4.5 What 6.15 will add on top

(Documented here so 5.5 scope is clear: we ship the infra, not the consumer.)

- New migration `0003_vec_tables.sql` that creates a `vec0` virtual table for chunk embeddings:
  ```sql
  CREATE VIRTUAL TABLE clio_vec_chunks USING vec0(
    chunk_id INTEGER PRIMARY KEY,
    embedding FLOAT[768]        -- matches the active embedder's dim
  );
  ```
- Code in `local-clio.ts` that calls `db.loadExtension(join(CFCF_NATIVE_DIR, "sqlite-vec"))` during `ensureInitialized()` and falls back to brute-force cosine (the v1 path) if loadExtension throws.
- Reindex flow to populate `clio_vec_chunks` from `clio_chunks.embedding`.
- Hybrid RRF query changes to use `vec_distance_cosine(...)` instead of the TS loop.

**None of 6.15 is built in 5.5.** 5.5's job is just to make loadExtension work.

---

## 5. Phase 0 dev loop — how to test before CI works

**This is where the earlier draft was unclear. Explicit version now.**

Phase 0 means: the release workflow isn't written (or isn't trusted) yet. We want to exercise `install.sh` end-to-end on a developer's laptop without touching GitHub. To do this we produce a tarball locally, serve it from localhost, and run the installer pointing at localhost.

### 5.1 One-command local build

New script at `scripts/build-release-tarball.sh`:

```bash
#!/usr/bin/env bash
# Build a cfcf-<platform>-<version>.tar.gz for the current machine.
# Everything the release CI does, but on your laptop, to one tarball.
set -euo pipefail

VERSION="${1:-0.0.0-dev}"
PLATFORM="$(scripts/detect-platform.sh)"      # prints "darwin-arm64" etc.
STAGE="$(mktemp -d)"
OUT_DIR="${OUT_DIR:-dist}"

mkdir -p "$OUT_DIR"

# 1. build the binary
bun run build --outfile "$STAGE/bin/cfcf"

# 2. stage runtime deps
scripts/stage-runtime-deps.sh "$STAGE/bin/node_modules"

# 3. build SQLite + fetch sqlite-vec
scripts/build-sqlite.sh "$PLATFORM" "$STAGE/native"
scripts/fetch-sqlite-vec.sh "$PLATFORM" "$STAGE/native"

# 4. manifest + licence
scripts/write-manifest.sh "$VERSION" "$PLATFORM" > "$STAGE/MANIFEST"
cp LICENSE "$STAGE/LICENSE"

# 5. tar it up
TARBALL="cfcf-${PLATFORM}-${VERSION}.tar.gz"
tar czf "$OUT_DIR/$TARBALL" -C "$STAGE" .
(cd "$OUT_DIR" && sha256sum "$TARBALL" > "$TARBALL.sha256")

echo "Built: $OUT_DIR/$TARBALL"
```

Running it produces `dist/cfcf-darwin-arm64-0.0.0-dev.tar.gz` + `.sha256`.

### 5.2 Local HTTP server

We already require Bun as a dev prereq, so we stay in-ecosystem rather than reaching for `python3 -m http.server`. New `scripts/serve-dist.ts` (~20 lines, uses `Bun.serve`):

```ts
// scripts/serve-dist.ts — Phase-0 local file server for installer testing.
// Usage: bun run scripts/serve-dist.ts [port]
import { file } from "bun";
import { resolve, join, normalize } from "node:path";

const port = Number(process.argv[2] ?? 8080);
const root = resolve("dist");

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    // Prevent path traversal outside dist/.
    const target = normalize(join(root, url.pathname));
    if (!target.startsWith(root)) return new Response("forbidden", { status: 403 });
    const f = file(target);
    if (!(await f.exists())) return new Response("not found", { status: 404 });
    return new Response(f);
  },
});

console.log(`[serve-dist] http://localhost:${port}/  (root: ${root})`);
```

Phase-0 sequence from the repo root:

```bash
# 1. Build the per-platform tarball into dist/.
bun run scripts/build-release-tarball.sh 0.0.0-dev
#   → dist/cfcf-<platform>-0.0.0-dev.tar.gz + .sha256

# 2. Put install.sh + SHA256SUMS + MANIFEST.txt where the server will
#    find them (mirrors the real release layout).
cp scripts/install.sh dist/
cp dist/cfcf-*-0.0.0-dev.tar.gz.sha256 dist/SHA256SUMS
echo "cfcf: 0.0.0-dev" > dist/MANIFEST.txt

# 3. Serve.
bun run scripts/serve-dist.ts
```

Leave that terminal running; use another for the install step (§5.3).

### 5.3 Install from localhost

From another terminal:

```bash
export CFCF_BASE_URL="http://localhost:8080"
export CFCF_VERSION="0.0.0-dev"
curl -fsSL "$CFCF_BASE_URL/install.sh" | bash
```

`install.sh` honours `CFCF_BASE_URL` (overrides the default GitHub URL). After this runs:
- `~/.cfcf/bin/cfcf` exists.
- `cfcf --version` prints `0.0.0-dev`.
- `cfcf clio stats` works (opens `~/.cfcf/clio.db` against the custom libsqlite3).

**That's Phase 0 done.** No GitHub Actions involvement, no real release. The script was built on your laptop, the tarball was built on your laptop, the install happened on your laptop. We've proven the install flow works end-to-end.

### 5.4 From Phase 0 → Phase 1

Phase 1 is "same thing, but CI built the tarball and uploaded it to a GitHub Release on the `cfcf` repo." Steps:

1. Land `.github/workflows/release.yml` (per §6).
2. Push a pre-release tag (`v0.9.0-rc.1`) to `main`.
3. CI runs, tarballs get uploaded to a GitHub Release.
4. `CFCF_BASE_URL=https://github.com/fstamatelopoulos/cfcf/releases/download/v0.9.0-rc.1 curl -fsSL <raw install.sh URL> | bash` — works.
5. When confident, move to Phase 2 (public `cfcf-releases` repo) by mirroring the assets + updating install.sh's default URL.

---

## 6. Release CI — full spec

### 6.1 File: `.github/workflows/release.yml`

**Trigger: `workflow_dispatch` only** (decided 2026-04-26). Tagging and releasing are deliberately separated — a tag is a developer milestone marker; a release is an explicit publishing act. No tag push ever creates a release. Run via the GitHub Actions UI ("Run workflow" button) or `gh workflow run release.yml -f tag=v0.10.0`.

```yaml
name: release
on:
  workflow_dispatch:
    inputs:
      tag:
        description: 'Existing git tag to build from (e.g. v0.10.0). The tag must already exist on the repo and be reachable from main.'
        required: true
        type: string
      prerelease:
        description: 'Mark this as a prerelease (does not become "latest").'
        required: false
        type: boolean
        default: false

permissions:
  contents: write      # gh release create
  actions: read

concurrency:
  group: release-${{ inputs.tag }}
  cancel-in-progress: false

jobs:
  # ── sanity: tag must exist + be reachable from main ────────────────
  verify:
    runs-on: ubuntu-latest
    outputs:
      sha: ${{ steps.resolve.outputs.sha }}
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - name: Resolve tag → sha + verify on main
        id: resolve
        run: |
          if ! git rev-parse "refs/tags/${{ inputs.tag }}" >/dev/null 2>&1; then
            echo "::error::Tag '${{ inputs.tag }}' does not exist. Tag locally + push first."
            exit 1
          fi
          sha="$(git rev-parse "refs/tags/${{ inputs.tag }}^{}")"
          echo "sha=$sha" >> "$GITHUB_OUTPUT"
          git fetch origin main --depth=0
          if ! git merge-base --is-ancestor "$sha" origin/main; then
            echo "::error::Tag '${{ inputs.tag }}' (sha $sha) is not on main."
            exit 1
          fi

  # ── per-platform build ──────────────────────────────────────────────
  build:
    needs: verify
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-14          # arm64 runner
            platform: darwin-arm64
            bun-target: bun-darwin-arm64
          - os: macos-13          # x64 runner (Intel; runner availability tracked in §15)
            platform: darwin-x64
            bun-target: bun-darwin-x64
          - os: ubuntu-latest
            platform: linux-x64
            bun-target: bun-linux-x64
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.tag }}     # build from the tagged commit, not HEAD
      - uses: oven-sh/setup-bun@v1
        with: { bun-version: 1.3.x }
      - run: bun install

      # full tarball produced by the same script Phase 0 uses
      - run: scripts/build-release-tarball.sh "${{ inputs.tag }}"
        env:
          PLATFORM: ${{ matrix.platform }}
          BUN_TARGET: ${{ matrix.bun-target }}

      # smoke-test the tarball (untar + run cfcf --version + check-deps)
      - run: scripts/smoke-tarball.sh "dist/cfcf-${{ matrix.platform }}-${{ inputs.tag }}.tar.gz" "${{ matrix.platform }}"

      - uses: actions/upload-artifact@v4
        with:
          name: cfcf-${{ matrix.platform }}
          retention-days: 14         # short window: artifacts only used during the release run
          path: |
            dist/cfcf-${{ matrix.platform }}-${{ inputs.tag }}.tar.gz
            dist/cfcf-${{ matrix.platform }}-${{ inputs.tag }}.tar.gz.sha256

  # ── assemble SHA256SUMS + publish release ──────────────────────────
  release:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.tag }}
      - uses: actions/download-artifact@v4
        with:
          path: dist
          merge-multiple: true

      - name: Assemble SHA256SUMS
        run: |
          cd dist
          cat *.sha256 > SHA256SUMS
          rm -- *.sha256

      - name: Write MANIFEST.txt
        run: scripts/write-manifest.sh "${{ inputs.tag }}" > dist/MANIFEST.txt

      - name: Copy install scripts
        run: |
          cp scripts/install.sh dist/
          # install.ps1 added in Phase 4

      - name: Create GitHub Release
        env: { GH_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
        run: |
          flag="--latest"
          if [[ "${{ inputs.prerelease }}" == "true" ]]; then flag="--prerelease"; fi
          gh release create "${{ inputs.tag }}" \
            --title "${{ inputs.tag }}" \
            --generate-notes \
            --verify-tag \
            $flag \
            dist/*.tar.gz dist/SHA256SUMS dist/MANIFEST.txt dist/install.sh
```

### 6.2 Flow

1. Developer lands changes on `main`, batches commits, pushes when ready.
2. Tag locally + push: `git tag -a v0.10.0 -m "..." && git push origin v0.10.0`. **No CI runs from this step.** The tag is just a marker.
3. When ready to publish a release: open the GitHub Actions UI → "release" workflow → "Run workflow" → enter `v0.10.0` as the `tag` input. Or `gh workflow run release.yml -f tag=v0.10.0`.
4. `verify` job resolves the tag → sha and confirms reachability from `main` (rejects tags from feature branches, force-pushed tags pointing off-tree, etc.).
5. `build` matrix (three legs) checks out the tagged commit + runs `scripts/build-release-tarball.sh` per platform + smoke-tests the result.
6. `release` job downloads all artifacts, assembles `SHA256SUMS`, generates `MANIFEST.txt`, calls `gh release create` with all assets including `install.sh`.
7. Result: a GitHub Release at `https://github.com/<host>/<repo>/releases/tag/v0.10.0` with all assets attached.

**Why workflow_dispatch only:** tag-pushed triggers conflate "milestone marker" with "publish a release," so accidental tags become accidental releases. Manual dispatch keeps the act of releasing explicit. The user explicitly raised this on 2026-04-26 after observing the v0.9.0 milestone tag (no binaries shipped) — that distinction is hard to preserve under tag-trigger.

### 6.3 The "latest" pointer

`--latest` (on non-RC tags) tells GitHub to mark this release as the "latest" — accessible via `https://github.com/fstamatelopoulos/cfcf-releases/releases/latest/download/<file>` without knowing the version. `install.sh` with `CFCF_VERSION=latest` relies on this.

---

## 7. Tarball layout + manifest

### 7.1 Layout (darwin-arm64 shown; linux + windows analogous)

```
cfcf-darwin-arm64-v0.9.0/
├── bin/
│   ├── cfcf                                  # Bun-compiled standalone binary
│   └── node_modules/
│       ├── @huggingface/
│       │   └── transformers/…
│       ├── onnxruntime-node/…                # with darwin-arm64 .node
│       └── sharp/…                           # with darwin-arm64 .node
├── native/
│   ├── libsqlite3.dylib                      # our pinned SQLite
│   └── sqlite-vec.dylib                      # from sqlite-vec release
├── MANIFEST                                  # version pins
├── LICENSE                                   # concatenated licences
└── uninstall.sh                              # scripts/uninstall.sh copy
```

### 7.2 `~/.cfcf/` after install

```
~/.cfcf/
├── bin/              # from tarball (unchanged on upgrade)
├── native/           # from tarball
├── models/           # lazy-populated on first embedder install
├── clio.db           # user data
├── logs/             # per-workspace agent logs
├── MANIFEST          # copy of tarball's MANIFEST -- used to detect upgrades
└── uninstall.sh      # copy of tarball's uninstall.sh
```

### 7.3 MANIFEST format

```
cfcf:            v0.9.0
bun:             1.3.x
sqlite:          3.46.0
sqlite-vec:      0.1.6
transformers:    <whatever bun install resolved>
onnxruntime-node: <whatever bun install resolved>
sharp:           <whatever bun install resolved>
platform:        darwin-arm64
built-at:        2026-04-22T18:00:00Z
```

Machine-readable (key:value, one per line). `cfcf --version` reads this at runtime to print the full set, not just the cfcf version.

---

## 8. Build scripts — ready-to-copy bash

All scripts go in `scripts/`, all are bash, all use `set -euo pipefail`.

### 8.1 `scripts/detect-platform.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$os-$arch" in
  darwin-arm64)   echo "darwin-arm64" ;;
  darwin-x86_64)  echo "darwin-x64" ;;
  linux-x86_64)   echo "linux-x64" ;;
  mingw*|msys*|cygwin*) echo "windows-x64" ;;
  *) echo "Unsupported platform: $os-$arch" >&2; exit 1 ;;
esac
```

### 8.2 `scripts/build-sqlite.sh`

```bash
#!/usr/bin/env bash
# Build libsqlite3 with loadExtension enabled from the amalgamation.
# Usage: build-sqlite.sh <platform> <out-dir>
set -euo pipefail
PLATFORM="$1"
OUT_DIR="$2"
SQLITE_VERSION="${SQLITE_VERSION:-3460000}"

mkdir -p "$OUT_DIR"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "https://sqlite.org/2024/sqlite-amalgamation-${SQLITE_VERSION}.zip" -o "$tmp/s.zip"
(cd "$tmp" && unzip -q s.zip)
cd "$tmp/sqlite-amalgamation-${SQLITE_VERSION}"

FLAGS="-DSQLITE_ENABLE_LOAD_EXTENSION=1 \
       -DSQLITE_ENABLE_FTS5=1 \
       -DSQLITE_ENABLE_JSON1=1 \
       -DSQLITE_ENABLE_RTREE=1 \
       -DSQLITE_THREADSAFE=1 \
       -O2"

case "$PLATFORM" in
  darwin-*)
    clang $FLAGS -dynamiclib -install_name @rpath/libsqlite3.dylib \
          sqlite3.c -o libsqlite3.dylib
    cp libsqlite3.dylib "$OUT_DIR/" ;;
  linux-*)
    gcc $FLAGS -shared -fPIC \
        sqlite3.c -o libsqlite3.so
    cp libsqlite3.so "$OUT_DIR/" ;;
  windows-*)
    # Assumes MSVC available on the runner
    cl $FLAGS /LD sqlite3.c /Fe:sqlite3.dll
    cp sqlite3.dll "$OUT_DIR/libsqlite3.dll" ;;
  *) echo "Unsupported platform $PLATFORM"; exit 1 ;;
esac
```

### 8.3 `scripts/fetch-sqlite-vec.sh`

```bash
#!/usr/bin/env bash
# Download sqlite-vec prebuilt for the platform, place it in <out-dir>.
# Usage: fetch-sqlite-vec.sh <platform> <out-dir>
set -euo pipefail
PLATFORM="$1"
OUT_DIR="$2"
SQLITE_VEC_VERSION="${SQLITE_VEC_VERSION:-0.1.6}"

# Map our platform → sqlite-vec's platform string
case "$PLATFORM" in
  darwin-arm64)  sv="macos-aarch64" ; ext="dylib" ;;
  darwin-x64)    sv="macos-x86_64"  ; ext="dylib" ;;
  linux-x64)     sv="linux-x86_64"  ; ext="so"    ;;
  windows-x64)   sv="windows-x86_64"; ext="dll"   ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

url="https://github.com/asg017/sqlite-vec/releases/download/v${SQLITE_VEC_VERSION}/sqlite-vec-${SQLITE_VEC_VERSION}-loadable-${sv}.tar.gz"
curl -fsSL "$url" -o "$tmp/sv.tar.gz"
(cd "$tmp" && tar xzf sv.tar.gz)

mkdir -p "$OUT_DIR"
# sqlite-vec's tarball places the lib at the top level, often named `vec0.<ext>`
mv "$tmp"/vec0.* "$OUT_DIR/sqlite-vec.${ext}"
```

### 8.4 `scripts/stage-runtime-deps.sh`

The runtime-deps staging is the single most failure-prone step in the build, so it gets explicit verification. Three threats it must defend against:

1. **Bun's untrusted-deps default skips postinstalls** → `onnxruntime-node`'s install script never runs → published npm tarball's bundled binaries (whatever arch they happen to be) are all you get. Defended via `trustedDependencies` in the staging package.json (see line `"trustedDependencies": [...]` below).
2. **Bun's `.bun/` content-addressed layout produces symlinks** → naive `cp -r` of `node_modules/` ships dangling symlinks pointing at paths that don't exist on the user's machine. Defended via `--linker hoisted` (flat layout, no `.bun/` indirection) + `cp -RL` (dereference symlinks).
3. **Postinstall silently picks the wrong arch** → script ran, but downloaded the build host's arch instead of the matrix leg's target arch. Mostly impossible because the matrix leg IS native to its target, but assert it anyway via the post-install verification block at the bottom.

```bash
#!/usr/bin/env bash
# Stage the three externalised runtime deps for tarball inclusion.
# Output: a flat node_modules/ directory containing onnxruntime-node,
# sharp, @huggingface/transformers, all transitive deps, and the
# arch-specific native addons FOR THE CURRENT MACHINE'S PLATFORM.
#
# This script MUST run on a runner of the target architecture
# (release CI matrix arranges this); postinstalls download whatever
# arch process.platform / process.arch report at run time.
#
# Usage: stage-runtime-deps.sh <out-node-modules-dir> <platform>
set -euo pipefail
OUT="$1"
PLATFORM="$2"          # darwin-arm64 | darwin-x64 | linux-x64

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# 1. Compose a fresh package.json with the same version pins used by
#    packages/core (resolve-runtime-deps.js does the substitution).
#    trustedDependencies forces Bun to RUN the postinstall scripts of
#    onnxruntime-node + sharp; without this Bun silently skips them
#    and we ship a node_modules/ that's missing the native binary.
cat > "$tmp/package.json" <<'EOF'
{
  "name": "cfcf-runtime-deps",
  "version": "0.0.0",
  "private": true,
  "dependencies": {
    "@huggingface/transformers": "<resolved>",
    "onnxruntime-node": "<resolved>",
    "sharp": "<resolved>"
  },
  "trustedDependencies": ["onnxruntime-node", "sharp"]
}
EOF
scripts/resolve-runtime-deps.js "$tmp/package.json"

# 2. Install with the hoisted linker so node_modules/ is a flat tree
#    rather than the default isolated layout (which symlinks into
#    .bun/<pkg>@<ver>/node_modules/<pkg>). Hoisted means we can copy
#    the whole tree without ending up with broken symlinks pointing
#    into the build host's content-addressed cache.
(cd "$tmp" && bun install --production --frozen-lockfile --linker hoisted)

# 3. Copy the staged tree into the output dir, dereferencing any
#    remaining symlinks (-L). cp -RL preserves directory structure
#    + follows symlinks; rsync would also work and is sometimes
#    faster on macOS.
mkdir -p "$OUT"
cp -RL "$tmp/node_modules/." "$OUT/"

# 4. Verification: assert the platform-specific native binaries
#    exist at the expected paths. If they don't, FAIL THE BUILD --
#    a missing-binary error never reaches end users this way.
echo "[stage-runtime-deps] verifying native binaries for $PLATFORM..."

# Map our platform → the path components onnxruntime-node uses.
# IMPORTANT: napi-v3 is correct for onnxruntime-node 1.21.0 (the version
# we pin per §14a so darwin-x64 gets a binary). Bump to napi-v6 if/when
# we move to ORT-node 1.22+.
case "$PLATFORM" in
  darwin-arm64) ort_os=darwin; ort_arch=arm64;  ext=node ;;
  darwin-x64)   ort_os=darwin; ort_arch=x64;    ext=node ;;
  linux-x64)    ort_os=linux;  ort_arch=x64;    ext=node ;;
  windows-x64)  ort_os=win32;  ort_arch=x64;    ext=node ;;
  *) echo "Unsupported platform: $PLATFORM" >&2; exit 1 ;;
esac

ort_napi_dir="napi-v3"          # matches ORT-node 1.21.x; bump if pin changes
ort_binding="$OUT/onnxruntime-node/bin/${ort_napi_dir}/${ort_os}/${ort_arch}/onnxruntime_binding.${ext}"
if [[ ! -f "$ort_binding" ]]; then
  echo "FAIL: missing $ort_binding" >&2
  echo "      onnxruntime-node's postinstall didn't produce the expected file." >&2
  echo "      Check: was trustedDependencies honoured? (bun install logs should show" >&2
  echo "      'running postinstall script' for onnxruntime-node)" >&2
  exit 1
fi
echo "[stage-runtime-deps] ✓ onnxruntime-node binding: $ort_binding"

# sharp uses npm's optional-platform-packages pattern. Each
# @img/sharp-<platform> sub-package contains lib/sharp-<platform>.node.
# The presence of the right sub-package is the check.
sharp_pkg_name=""
case "$PLATFORM" in
  darwin-arm64) sharp_pkg_name="@img/sharp-darwin-arm64" ;;
  darwin-x64)   sharp_pkg_name="@img/sharp-darwin-x64" ;;
  linux-x64)    sharp_pkg_name="@img/sharp-linux-x64" ;;
  windows-x64)  sharp_pkg_name="@img/sharp-win32-x64" ;;
esac
if [[ ! -d "$OUT/$sharp_pkg_name" ]]; then
  echo "FAIL: missing $OUT/$sharp_pkg_name" >&2
  echo "      sharp's optional platform package didn't install." >&2
  exit 1
fi
echo "[stage-runtime-deps] ✓ sharp platform package: $sharp_pkg_name"

# Pure-JS package: just the directory has to exist.
if [[ ! -d "$OUT/@huggingface/transformers" ]]; then
  echo "FAIL: missing $OUT/@huggingface/transformers" >&2
  exit 1
fi
echo "[stage-runtime-deps] ✓ @huggingface/transformers"

echo "[stage-runtime-deps] all native deps verified for $PLATFORM"
```

`scripts/resolve-runtime-deps.js` reads `packages/core/package.json`, pulls the three version pins, and writes them into the temp `package.json` so staging is always in lockstep with what dev mode uses.

### 8.5 `scripts/write-manifest.sh`

```bash
#!/usr/bin/env bash
# Emit a MANIFEST for inclusion in the tarball.
# Usage: write-manifest.sh <version>
set -euo pipefail
VERSION="$1"
PLATFORM="$(scripts/detect-platform.sh)"
cat <<EOF
cfcf: $VERSION
bun: $(bun --version)
sqlite: ${SQLITE_VERSION:-3460000}
sqlite-vec: ${SQLITE_VEC_VERSION:-0.1.6}
transformers: $(bun pm ls @huggingface/transformers --json 2>/dev/null | jq -r '.[0].version' || echo unknown)
onnxruntime-node: $(bun pm ls onnxruntime-node --json 2>/dev/null | jq -r '.[0].version' || echo unknown)
sharp: $(bun pm ls sharp --json 2>/dev/null | jq -r '.[0].version' || echo unknown)
platform: $PLATFORM
built-at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
```

### 8.6 `scripts/build-release-tarball.sh`

(Already sketched in §5.1. Calls the five scripts above in order and tars the result.)

### 8.7 `scripts/serve-dist.ts`

(Inlined in §5.2. Bun-based local HTTP server for Phase-0 testing.)

### 8.8 `scripts/uninstall.sh`

```bash
#!/usr/bin/env bash
# Remove a cfcf install.
set -euo pipefail
SYMLINK="${CFCF_SYMLINK_DIR:-/usr/local/bin}/cfcf"
INSTALL_DIR="${CFCF_INSTALL_DIR:-$HOME/.cfcf}"

echo "[cfcf] removing symlink $SYMLINK (if any)"
rm -f "$SYMLINK" || true

echo "[cfcf] removing $INSTALL_DIR"
read -r -p "About to rm -rf $INSTALL_DIR (contains your Clio DB + logs). Proceed? [y/N] " ans
if [[ "$ans" == "y" || "$ans" == "Y" ]]; then
  rm -rf "$INSTALL_DIR"
  echo "[cfcf] uninstalled."
else
  echo "[cfcf] aborted."
fi
```

(Ships in the tarball at `uninstall.sh`; user runs `~/.cfcf/uninstall.sh` or `cfcf-uninstall` if we symlink that too.)

---

## 9. Install script — full spec

Full, copy-ready version of `scripts/install.sh`:

```bash
#!/usr/bin/env bash
#
# cfcf installer.
#
# Env vars (all optional):
#   CFCF_BASE_URL       Override the release base URL (default:
#                       https://github.com/fstamatelopoulos/cfcf-releases/releases/latest/download
#                       or /releases/download/<version> if CFCF_VERSION != latest)
#   CFCF_VERSION        "latest" (default) or a specific tag like v0.9.0
#   CFCF_INSTALL_DIR    Where to install cfcf (default: ~/.cfcf)
#   CFCF_SYMLINK_DIR    Where to drop the symlink (default: /usr/local/bin)
#   CFCF_NO_SYMLINK     If set, skip the symlink step and just print PATH instructions

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────
: "${CFCF_VERSION:=latest}"
: "${CFCF_INSTALL_DIR:=$HOME/.cfcf}"
: "${CFCF_SYMLINK_DIR:=/usr/local/bin}"
: "${CFCF_REPO:=fstamatelopoulos/cfcf-releases}"    # change for Phase 1/2
if [[ -z "${CFCF_BASE_URL:-}" ]]; then
  if [[ "$CFCF_VERSION" == "latest" ]]; then
    CFCF_BASE_URL="https://github.com/${CFCF_REPO}/releases/latest/download"
  else
    CFCF_BASE_URL="https://github.com/${CFCF_REPO}/releases/download/${CFCF_VERSION}"
  fi
fi

# ── Platform detection ────────────────────────────────────────────────
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$os-$arch" in
  darwin-arm64)  platform=darwin-arm64 ;;
  darwin-x86_64) platform=darwin-x64 ;;
  linux-x86_64)  platform=linux-x64 ;;
  mingw*|msys*|cygwin*)
    echo "[cfcf] Windows detected. Use install.ps1 instead, or run this from WSL." >&2
    exit 1 ;;
  *)
    echo "[cfcf] Unsupported platform: $os-$arch" >&2
    echo "[cfcf] Supported: darwin-arm64, darwin-x64, linux-x64. Windows support pending." >&2
    exit 1 ;;
esac

# ── Resolve version string used in filenames ─────────────────────────
if [[ "$CFCF_VERSION" == "latest" ]]; then
  # latest/download URLs don't include the version in the filename
  # BUT our release-CI embeds it, so we probe one file to get the version
  resolved="$(curl -fsSL -o /dev/null -w '%{url_effective}' \
    "$CFCF_BASE_URL/MANIFEST.txt" || true)"
  # URL is now the final /releases/download/<VERSION>/MANIFEST.txt
  version="$(echo "$resolved" | sed -nE 's|.*/releases/download/([^/]+)/.*|\1|p')"
  if [[ -z "$version" ]]; then
    echo "[cfcf] could not resolve latest version; set CFCF_VERSION=<tag>" >&2
    exit 1
  fi
else
  version="$CFCF_VERSION"
fi

tarball="cfcf-${platform}-${version}.tar.gz"
sha="${tarball}.sha256"

# ── Download + verify ─────────────────────────────────────────────────
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "[cfcf] downloading $tarball from $CFCF_BASE_URL"
curl -fsSL "$CFCF_BASE_URL/$tarball" -o "$tmp/$tarball"

echo "[cfcf] downloading checksums"
# SHA256SUMS contains one line per tarball; extract the one we need
curl -fsSL "$CFCF_BASE_URL/SHA256SUMS" -o "$tmp/SHA256SUMS"
grep " $tarball\$" "$tmp/SHA256SUMS" > "$tmp/$sha"

echo "[cfcf] verifying checksum"
(cd "$tmp" && sha256sum -c "$sha")

# ── Unpack ────────────────────────────────────────────────────────────
echo "[cfcf] installing to $CFCF_INSTALL_DIR"
mkdir -p "$CFCF_INSTALL_DIR"
tar xzf "$tmp/$tarball" -C "$CFCF_INSTALL_DIR" --strip-components=1

# ── Symlink / PATH ────────────────────────────────────────────────────
if [[ -z "${CFCF_NO_SYMLINK:-}" && -w "$CFCF_SYMLINK_DIR" ]]; then
  ln -sf "$CFCF_INSTALL_DIR/bin/cfcf" "$CFCF_SYMLINK_DIR/cfcf"
  echo "[cfcf] symlinked $CFCF_SYMLINK_DIR/cfcf"
else
  echo "[cfcf] did not create symlink ($CFCF_SYMLINK_DIR not writable)"
  echo "[cfcf] add this to your shell rc to use cfcf:"
  echo "         export PATH=\"$CFCF_INSTALL_DIR/bin:\$PATH\""
fi

# ── Smoke test ────────────────────────────────────────────────────────
echo "[cfcf] smoke test"
"$CFCF_INSTALL_DIR/bin/cfcf" --version

# ── Optional: refuse if cfcf server is already running ────────────────
# (per §1.3 -- a running server caches active embedder + config in
# memory and won't pick up the new install's reconfigure cleanly.)
if pgrep -f "cfcf server" >/dev/null 2>&1; then
  echo "[cfcf] cfcf server is currently running."
  echo "[cfcf] Stop it before continuing so init's config takes effect:"
  echo "         cfcf server stop"
  exit 1
fi

# ── Hand off to cfcf init (interactive, unless CFCF_SKIP_INIT) ───────
cat <<EOF

[cfcf] cfcf $version installed at $CFCF_INSTALL_DIR.
[cfcf] Next: cfcf init walks you through agent + embedder + permissions.
EOF

if [[ -z "${CFCF_SKIP_INIT:-}" ]]; then
  echo "[cfcf] Press Enter to run 'cfcf init' now, or Ctrl-C to exit and run it later."
  # </dev/tty so the read sees the actual terminal even when stdin is
  # the curl pipe (rustup/nvm pattern).
  read -r _ </dev/tty || true
  echo "[cfcf] launching cfcf init..."
  exec "$CFCF_INSTALL_DIR/bin/cfcf" init
else
  cat <<EOF

[cfcf] CFCF_SKIP_INIT set; not launching cfcf init.
       When you're ready: cfcf init

       cfcf --help                for command reference
       $CFCF_INSTALL_DIR/uninstall.sh   to uninstall
EOF
fi
```

### 9.1 Error-path behaviour

- **Network failure** mid-download: `set -e` + `curl -fsSL` trip; the installer aborts and prints the failed URL. The temp dir is cleaned by the trap.
- **Checksum mismatch:** `sha256sum -c` exits non-zero; `set -e` trips; install aborts with the standard `sha256sum: …: FAILED` message. Nothing is written to `$CFCF_INSTALL_DIR`.
- **Partial previous install:** tar `--strip-components=1` on top of an existing dir overwrites `bin/` + `native/` + `MANIFEST` but leaves `models/` + `clio.db` + `logs/` alone. This is intentional: upgrades don't touch user data.
- **`/usr/local/bin` not writable** (e.g. locked-down corp Mac, `sudo`-less Linux): installer prints explicit PATH-update instructions and continues; the binary itself is still installed.
- **Platform mismatch** (e.g. running on `darwin-x64` but the release only has `darwin-arm64`): `curl -f` returns 404; install aborts with a clear "not supported yet" message.

---

## 10. Uninstall + self-update

### 10.1 Uninstall

`scripts/uninstall.sh` in §8.7. Bundled into the tarball at `~/.cfcf/uninstall.sh`. Also symlinked as `cfcf-uninstall` → `/usr/local/bin/cfcf-uninstall` for discoverability.

### 10.2 Self-update — `cfcf self-update`

**DECIDED 2026-04-26: ships in 5.5.** The dogfood-the-installer-every-iteration loop is the primary use case, and a manual `bash install.sh ... | CFCF_VERSION=...` is too much friction to repeat per release.

The CLI command is a thin wrapper:

1. Read `<install-dir>/MANIFEST` for the local version. Bail if missing (dev mode).
2. Fetch `<CFCF_BASE_URL>/MANIFEST.txt` for the latest version (HTTP redirect resolves "latest" → the actual tag).
3. Compare. Same-version → "already on latest, no upgrade needed" + exit 0.
4. Different → prompt the user (skipped under `--yes`), then run `curl -fsSL <base>/install.sh | bash` with `CFCF_VERSION=<latest>` + `CFCF_SKIP_INIT=1` in the env.
5. install.sh's existing logic takes it from there (sha256 verify, untar, Gatekeeper xattr strip, smoke test). Upgrade preserves user data per §3.3.

Implementation in `packages/cli/src/commands/self-update.ts` (~180 LoC). Flags:
- `--check` — report current vs latest, exit without installing
- `--yes` — non-interactive (automation / CI)
- `--version <ver>` — install a specific tag instead of latest
- `--base-url <url>` — override the install URL

**Web-UI new-version notification + server-side periodic poll** is tracked separately under plan item 6.20. It's the "tell me when there's a new version" UX layer; the CLI command is "do the upgrade" and ships now.

A future `cfcf self-update --rollback <ver>` is feasible (just install an older version) but only useful once we have multiple released versions to roll back between. Not in 5.5.

---

## 11. Binary-side source changes

### 11.1 `packages/core/src/clio/db.ts`

Add once-at-process-start setup. The file currently has something like:

```ts
import { Database } from "bun:sqlite";
export function openClioDb(path: string): Database { return new Database(path); }
```

Change to:

```ts
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let customSqliteApplied = false;

/**
 * Point bun:sqlite at the pinned libsqlite3 shipped with the installer
 * (item 5.5). This is REQUIRED on macOS for `db.loadExtension(...)` to
 * work (Apple's system SQLite has load-extension compiled out). Called
 * idempotently from openClioDb() before any new Database(...) — calling
 * Database.setCustomSQLite AFTER a Database is opened has no effect on
 * that DB, so we must run before first open. Silently no-ops in dev
 * (no installer) or when the user manually deleted ~/.cfcf/native/.
 */
export function applyCustomSqlite(): void {
  if (customSqliteApplied) return;
  customSqliteApplied = true;

  const nativeDir = process.env.CFCF_NATIVE_DIR ?? join(homedir(), ".cfcf", "native");
  const ext = process.platform === "darwin" ? ".dylib"
            : process.platform === "win32"  ? ".dll"
            : ".so";
  const libPath = join(nativeDir, `libsqlite3${ext}`);
  if (!existsSync(libPath)) return;

  try {
    Database.setCustomSQLite(libPath);
  } catch (err) {
    process.stderr.write(
      `[clio] warning: could not set custom SQLite at ${libPath}: ${err}\n` +
      `[clio] falling back to system SQLite. sqlite-vec features will be disabled.\n`,
    );
  }
}

export function openClioDb(path: string): Database {
  applyCustomSqlite();
  return new Database(path);
}
```

One shared helper. No other files need to change.

### 11.2 `cfcf --version` readout

`packages/cli/src/commands/version.ts` (or wherever it lives) should additionally print `~/.cfcf/MANIFEST` contents when the file exists, so users see:

```
$ cfcf --version
cfcf v0.9.0
bun: 1.3.12
sqlite: 3.46.0 (pinned, ~/.cfcf/native/libsqlite3.dylib)
sqlite-vec: 0.1.6 (~/.cfcf/native/sqlite-vec.dylib)
platform: darwin-arm64
built: 2026-04-22T18:00:00Z
```

### 11.3 First-run diagnostics — `cfcf doctor`

**DECIDED 2026-04-26: include in 5.5** (after the install pipeline + Phase-0 smoke pass, before docs sign-off). Self-check that confirms an install is healthy. Runs:

| Check | Surfaces |
|---|---|
| `~/.cfcf/MANIFEST` parseable + records the binary's actual version | Mismatched / partial install |
| `~/.cfcf/native/libsqlite3.<ext>` exists | Custom SQLite missing → loadExtension would fail (6.15 broken) |
| `applyCustomSqlite()` activated successfully (`PRAGMA library_version` returns the pinned version) | The custom lib loads cleanly |
| `~/.cfcf/native/sqlite-vec.<ext>` exists | Future sqlite-vec features will work |
| `~/.cfcf/bin/node_modules/{@huggingface/transformers,onnxruntime-node,sharp}` exist | The three runtime deps are colocated as expected |
| `cfcf clio embedder check-deps` passes (the existing item from §11.4) | Each runtime dep imports successfully |
| Active embedder (if any) cached at `~/.cfcf/models/<hfModelId>/` | Embedder install is complete (else: HF download will fire on next search) |
| Detected agents from `cfcf init` are still resolvable on PATH | `claude-code`, `codex` haven't been removed since init |

Output: one line per check, ✓ or ✗, plus a final summary. Exits 0 when everything passes, 1 when any required check fails. Optional `--json` flag for scripting.

Tiny implementation footprint (~80 LoC under `packages/cli/src/commands/doctor.ts`). Each check is a pure function returning `{ name, status, detail? }`; `cfcf doctor` just runs them and prints. Can be reused by future automated diagnostics (e.g. the iteration loop's pre-run sanity check).

### 11.4 `cfcf clio embedder check-deps` + friendly module-not-found wrapping

Two pieces, both belt-and-braces against the same class of bug (native deps missing or arch-mismatched on the user's machine):

**`cfcf clio embedder check-deps`** — a tiny new CLI subcommand that just `await import`s the three runtime deps and prints the result:

```ts
// packages/cli/src/commands/clio.ts (sketch)
embedderCmd
  .command("check-deps")
  .description(
    "Verify the runtime deps (@huggingface/transformers + onnxruntime-node + sharp) " +
    "load correctly on this machine. Useful for diagnosing 'Cannot find module' or " +
    "missing-native-binary errors after an install."
  )
  .action(async () => {
    const deps = ["@huggingface/transformers", "onnxruntime-node", "sharp"];
    let ok = true;
    for (const name of deps) {
      try {
        await import(name);
        console.log(`✓ ${name}`);
      } catch (err) {
        ok = false;
        console.error(`✗ ${name}: ${err instanceof Error ? err.message : err}`);
      }
    }
    process.exit(ok ? 0 : 1);
  });
```

This is the canonical probe used by:
- The release CI's `smoke-tarball.sh` (§13.2 layer 2) — fails the build if any leg's tarball can't load its own deps.
- Users debugging a broken install (`cfcf clio embedder check-deps` is the first thing the `docs/guides/installing.md` troubleshooting section tells them to run).
- The `cfcf doctor` command from §11.3 once it lands.

**Friendly wrapper** in `local-clio.ts` (or wherever the dynamic import of `@huggingface/transformers` happens) — catches `Cannot find module` / `MODULE_NOT_FOUND` errors and re-throws with a CFCF-specific message:

```ts
async function loadTransformers(): Promise<typeof import("@huggingface/transformers")> {
  try {
    return await import("@huggingface/transformers");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Cannot find module") || msg.includes("MODULE_NOT_FOUND")) {
      throw new Error(
        `Failed to load @huggingface/transformers. This usually means the runtime ` +
        `node_modules/ is missing or the platform-specific native binary (for ` +
        `${process.platform}-${process.arch}) didn't install. Try:\n` +
        `  1. cfcf clio embedder check-deps   (diagnose which dep is missing)\n` +
        `  2. Re-install cfcf via the installer (it ships colocated native deps)\n` +
        `Original error: ${msg}`,
      );
    }
    throw err;
  }
}
```

Both pieces are small (≤30 lines each) and ship in 5.5. They mean:
- A misbuilt tarball is caught by CI before reaching users (via check-deps in smoke-tarball).
- A user whose install somehow drifted (manually deleted `node_modules/`, partial upgrade, etc.) gets a self-explanatory error rather than a raw Bun stack trace.

---

## 12. Docs + README updates

### 12.1 `docs/guides/installing.md` (new)

Content outline:

1. **Quick install** — the one-liner, plus copy-pasteable commands for each platform.
2. **What gets installed** — pointer at §7.2 of this doc.
3. **Manual install** — for users who don't trust `curl | bash`: download the tarball, verify with `sha256sum -c`, untar, symlink.
4. **Windows** — WSL instructions (v1); PowerShell installer (phase 4).
5. **Uninstalling** — `~/.cfcf/uninstall.sh` + rm `/usr/local/bin/cfcf*`.
6. **Upgrading** — re-run `curl | bash`; user data under `~/.cfcf/` survives.
7. **Troubleshooting** — Gatekeeper on macOS (`xattr -d com.apple.quarantine ~/.cfcf/bin/cfcf` as a v1 workaround); "command not found" after install → PATH not updated; SQLite + sqlite-vec errors → point at `cfcf doctor`.

### 12.2 `README.md`

- Replace the "Prerequisites: Node.js v20+, Bun v1.3+" line with:
  > **For end users:** git. That's it.
  > **For developers building from source:** Bun v1.3+, Node v20+, git.
- Add a "Install" section with the one-liner.

### 12.3 Item 5.8 user manual

Should inherit this doc; mentioned explicitly in the 5.5 plan row.

---

## 13. Testing strategy

### 13.1 Unit-ish

- `scripts/detect-platform.sh` — one test file under `scripts/tests/` that runs it with `uname` mocked via a shim.
- The `applyCustomSqlite` helper — test that calling it with `CFCF_NATIVE_DIR=/tmp/empty` is a no-op; with `CFCF_NATIVE_DIR=/tmp/fake-with-lib` it calls `Database.setCustomSQLite` exactly once (mock the bun:sqlite module).

### 13.2 Integration (per-platform, runs in release CI)

Per-platform integration tests run in two layers:

**Layer 1 — staging-time verification** (inside `stage-runtime-deps.sh` itself, §8.4): asserts the platform-specific `onnxruntime_binding.node`, `@img/sharp-<platform>` package, and `@huggingface/transformers` directory all exist at the expected paths. Fails the build immediately if Bun's postinstall didn't pull the right native binaries — the most common failure mode.

**Layer 2 — end-to-end smoke** (after tarball assembly, before upload). Implemented as `scripts/smoke-tarball.sh`:

```bash
#!/usr/bin/env bash
# Untar the just-built tarball into a temp dir and exercise it like
# a fresh user install would. If anything fails, fail the build leg.
# Usage: smoke-tarball.sh <tarball-path> <platform>
set -euo pipefail
TARBALL="$1"
PLATFORM="$2"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

tar xzf "$TARBALL" -C "$stage"
root="$(echo "$stage"/cfcf-*)"        # the unpacked tree

# 1. cfcf --version: smoke that the binary loads + can print its
#    MANIFEST. If the colocated node_modules/ isn't wired correctly
#    this surfaces immediately.
"$root/bin/cfcf" --version

# 2. cfcf clio stats with an isolated config dir (don't touch any
#    real ~/.cfcf/). This is the integration test for the SQLite
#    custom-lib wiring + Clio init path.
isolated="$(mktemp -d)"
CFCF_CONFIG_DIR="$isolated/config" CFCF_LOGS_DIR="$isolated/logs" \
  HOME="$isolated" "$root/bin/cfcf" clio stats

# 3. SQLite version pin: open the just-created clio.db and confirm
#    PRAGMA library_version returns our pinned 3.46.0, not whatever
#    the system shipped. Catches a missed Database.setCustomSQLite()
#    call.
expected_sqlite="3.46.0"          # keep in sync with build-sqlite.sh
got="$(HOME="$isolated" "$root/bin/cfcf" clio stats --json | \
       jq -r '.sqliteVersion // empty')"
if [[ "$got" != "$expected_sqlite" ]]; then
  echo "FAIL: expected SQLite $expected_sqlite, got '$got'" >&2
  exit 1
fi

# 4. Native deps load smoke: trigger a code path that imports
#    @huggingface/transformers + onnxruntime-node. Without setting
#    up a real embedder we can't call .embed(), but loading the
#    module itself proves the colocated node_modules/ + native
#    addons resolve. Use --check-deps (TODO: add to cli) which
#    just imports + reports.
"$root/bin/cfcf" clio embedder check-deps    # exits 0 on success

echo "[smoke-tarball] all checks passed for $PLATFORM"
```

(`cfcf clio embedder check-deps` is a small new subcommand that imports `@huggingface/transformers` + `onnxruntime-node` + `sharp` and prints "OK" — see §11.4. It's the canonical "are my native deps wired correctly?" probe.)

Hooked into `release.yml` (§6.1) as a step between build and upload-artifact:

```yaml
- run: scripts/smoke-tarball.sh dist/cfcf-${{ matrix.platform }}-${{ github.ref_name }}.tar.gz ${{ matrix.platform }}
```

If any layer-1 or layer-2 check fails, the leg fails and no release is published. **A user never gets a tarball where the binary can't load its own deps.**

### 13.3 Manual smoke (per release)

A `docs/release-checklist.md` (new) with:

- Fresh VM or clean user account per platform: download install.sh, run it, `cfcf init`, create a workspace, run one iteration, confirm Clio writes work.
- `cfcf --version` shows every pinned version correctly.
- `~/.cfcf/uninstall.sh` cleanly removes everything.

---

## 14. Rollout phases (recap with explicit hand-offs)

| Phase | Goal | Hosting | Who builds the tarball | Blocker resolution |
|---|---|---|---|---|
| 0 | Validate install.sh end-to-end on a dev laptop | `bun run scripts/serve-dist.ts` on localhost | `scripts/build-release-tarball.sh` on dev machine | None — works today |
| 1 | Validate release.yml on the private `cfcf` repo | GitHub Releases on `cfcf` (private); download via PAT for external test VMs | GitHub Actions | None |
| 2 | First user-facing shape | Public `cfcf-releases` repo (Releases + raw install.sh); anonymous curl works | GitHub Actions (either mirrors to the public repo, or the workflow runs directly there) | **Decide: open-source cfcf itself, or create a dedicated public `cfcf-releases` repo.** |
| 3 | Vanity URL | `cerefox.org/install` → HTTP-302 → Phase 2 URL | Unchanged | Paid domain ownership |
| 4 | Windows | Adds `install.ps1` + `cfcf-windows-x64-<version>.zip` | GitHub Actions (adds windows-latest to the matrix) | Windows-native build tooling (MSVC on the runner) |

Each phase is a proper subset of the next — nothing built in an earlier phase gets thrown away.

---

## 14a. darwin-x64 (Intel Mac) support — DECIDED 2026-04-25

**Decision: Option A. Pin `@huggingface/transformers@3.8.1` + `onnxruntime-node@1.21.0`.** Intel Mac is fully supported with native ORT performance — same code path as every other platform, no degradation, no platform-conditional logic.

### Background

Discovered while debugging dev-mode failure: `onnxruntime-node@1.24.3` ships binaries for linux/x64, linux/arm64, darwin/arm64, win32/x64, win32/arm64 — **but not darwin/x64**. Microsoft dropped Intel-Mac builds starting with 1.24.x (Feb 2026). 1.23.2 (Nov 2025) was the last version to include them. The postinstall script (`script/install.js`) only handles CUDA-EP downloads; CPU binaries are bundled in the published npm tarball and simply aren't there for darwin-x64 in 1.24+.

### Investigation summary

| onnxruntime-node version | darwin-x64? | release date |
|---|---|---|
| 1.18.0 → 1.23.2 | ✅ | May 2024 → Nov 2025 |
| 1.24.1 → 1.24.3 | ❌ | Feb 2026 → Mar 2026 |

`@huggingface/transformers` pins onnxruntime-node exactly. Version mapping:

| transformers version | onnxruntime-node | darwin-x64? |
|---|---|---|
| 3.7.x → 3.8.1 (last 3.x) | 1.21.0 | ✅ |
| 4.0.0 → 4.2.0 (current) | 1.24.3 | ❌ |

So the natural pin pair is **transformers 3.8.1 + onnxruntime-node 1.21.0**. cfcf only uses `pipeline("feature-extraction", ...)` — that API has been stable since 2.x, so the 4.x → 3.8.1 downgrade has no functional impact for us.

### End-to-end verification (2026-04-25, Intel Mac, Bun 1.3.12)

Ran the real `LocalClio.installActiveEmbedder({ loadNow: true })` path with the new pin. Result:

- HF download: `bge-small-en-v1.5` (127 MB) downloaded successfully with the `cfcf` progress bar.
- Pipeline warmup completed.
- `embed(["hello world", "fox"])` returned 2 × 384-dim vectors in **21 ms** — full native speed, no WASM fallback, no degradation.
- Model files landed at `~/.cfcf/models/Xenova/bge-small-en-v1.5/`.

### Implications for 5.5 implementation

The per-platform release matrix stays the same: `darwin-arm64`, `darwin-x64`, `linux-x64` for v1. All three legs use the same pinned versions, all three produce equivalent tarballs. No platform-conditional code in the installer or in cfcf. The §8.4 staging script's verification block still asserts the platform-specific native binary is present — for darwin-x64 that means `node_modules/onnxruntime-node/bin/napi-v3/darwin/x64/onnxruntime_binding.node` (note: 1.21.0 uses `napi-v3`, not `napi-v6` like 1.24.x — adjust the path map in the verification block).

### Trade-offs accepted

- We're a few minor versions behind the latest transformers.js. Any feature added in 4.0.0+ is unavailable until Microsoft brings darwin-x64 back OR we drop Intel Mac support. cfcf's actual API surface (`pipeline("feature-extraction", ...)`, mean pooling, normalization) is identical between 3.x and 4.x, so no functional impact today. We'll re-evaluate if a future cfcf feature requires a newer transformers.

- ORT-node 1.21.0 (March 2025) is ~14 months old. ONNX format compatibility within an ORT generation is excellent; no model from our catalogue should fail. If an embedder we add later requires ORT-node 1.24+ specifically (unlikely), we'd revisit.

- We're tied to whatever transformers 3.8.1 supports for embedder model formats. The current catalogue (bge-small, MiniLM, nomic, bge-base) all work; verified for bge-small in the 2026-04-25 probe.

### Option B / C / D — superseded

- **Option B (drop Intel Mac)**: rejected. Option A gives Intel Mac users full functionality; no reason to exclude them.
- **Option C (FTS-only on darwin-x64)**: kept as a fallback in the existing `LocalClio.getEmbedder()` graceful-degradation path. If for any reason the embedder fails to load on a particular install, Clio still works for keyword search. Not the primary darwin-x64 story.
- **Option D (WASM via onnxruntime-web)**: investigated 2026-04-25; documented in §14b as a deferred research note. Not needed now that A works.

## 14b. Option D (WASM-via-onnxruntime-web) — investigated 2026-04-25, deferred

This section captures what we learned probing whether transformers.js can be coerced into using its bundled `onnxruntime-web` instead of `onnxruntime-node`. Captured here so a future contributor doesn't repeat the same investigation.

### What works

- `onnxruntime-web/webgpu` loads cleanly in Bun on Intel Mac. `InferenceSession`, `Tensor`, `env` all functional. WASM ORT in Node-via-Bun is feasible at the runtime level.
- transformers.js exposes a `globalThis[Symbol.for("onnxruntime")]` injection point. Setting it before transformers loads makes transformers prefer the injected ORT.

### What doesn't work without significant patching

- transformers.js's `onnx.js` does `import * as ONNX_NODE from "onnxruntime-node"` at module load. This evaluates onnxruntime-node's `binding.js`, which calls `require('../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node')` at top level. On darwin-x64 in 1.24.x this throws `MODULE_NOT_FOUND` and the entire transformers module fails to load.

- Even after stubbing `binding.js` so the import doesn't throw + setting `ORT_SYMBOL`, the `if (ORT_SYMBOL in globalThis)` branch in onnx.js does NOT populate `supportedDevices` / `defaultDevices`. Calls to `pipeline()` then fail with `Unsupported device: "cpu". Should be one of: .` (empty list).

- Even after patching the bundle to populate `supportedDevices` / `defaultDevices`, the next failure is that transformers.js bundles the **browser** version of ORT-web (`ort.webgpu.bundle.min.mjs`), which loads models via `fetch(URL)`. When transformers passes it a local file path, it errors `ERR_INVALID_URL`. There is no built-in WASM-on-Node code path in transformers.js as of 4.2.0.

### What it would cost to make Option D work

Either (a) vendor/fork transformers.js with a Node-aware WASM loader (substantial, ongoing maintenance burden), or (b) roll our own embedder using `onnxruntime-web/node` + a standalone tokenizer (several hundred LOC we'd own). Estimated 1-2 weeks of dev time.

### Why we deferred

Option A (the version pin) gives Intel Mac users full native performance with zero new code. Option D adds complexity for a worse user experience (WASM is 2-5x slower than native ORT). If Microsoft adds darwin-x64 back to a future ORT release, the version-pin path naturally becomes obsolete and we'd just bump versions. If they don't, and Intel Mac becomes important enough that staying behind on transformers.js is a real cost, *then* Option D becomes worth the engineering investment.

Until then: A wins.

---

## 15. Open questions

- **SQLite version pin** (currently `3.46.0`). Re-verify against sqlite-vec's compatibility note when bumping for a future release.
- **sqlite-vec version pin** (currently `0.1.6`). Same: bump intentionally, in lockstep with SQLite if needed.
- **Signing macOS binary.** **DECIDED 2026-04-26: option (a)** — install script runs `xattr -d com.apple.quarantine ~/.cfcf/bin/cfcf` after unpack. Apple Developer signing ($99/yr) deferred indefinitely; Gatekeeper bypass is documented in `docs/guides/installing.md`'s troubleshooting section as the expected first-run experience.
- **Linux distro coverage.** The generic `linux-x64` tarball assumes glibc ≥ 2.31 (what Ubuntu 20.04 ships). Musl (Alpine) is separate. Out of scope until someone asks.
- **Phase 2 hosting choice.** **DEFERRED 2026-04-26.** v1 ships only the build pipeline + tarballs + install.sh. Distribution channel is left open — user shares tarballs out-of-band (Dropbox, S3, locally-served via `scripts/serve-dist.ts`, or eventually a public `cfcf-releases` repo with optional GitHub Pages landing page). The install script is **hosting-agnostic via `CFCF_BASE_URL`** so no code change is required when we pick a channel — we just publish the assets there + tell users which URL to point at. Future GitHub Pages on `cfcf-releases` would give us a free public landing page (search-indexed by Google) with the install one-liner; that's a follow-up phase, not part of 5.5.
- ~~**Auto-update** (`cfcf self-update`)~~. ✓ in 5.5; see §10.2.

---

## 16. Pick-up checklist

When 5.5 gets scheduled (possibly immediately after this doc):

### 16.1 Pre-flight (none of these is 5.5 code; do once)

- [ ] Decide Phase 2 hosting: open-source `cfcf` or create `cfcf-releases`. Everything else runs on Phase 0 first so this isn't a blocker — but decide before Phase 2.
- [ ] Verify latest stable sqlite-vec version at build time. Update `SQLITE_VEC_VERSION` in `scripts/fetch-sqlite-vec.sh`.
- [ ] Verify SQLite pin works with sqlite-vec pin (read sqlite-vec release notes).

### 16.2 Build order (each step landable independently; run tests + typecheck at each)

1. [x] `scripts/detect-platform.sh` (§8.1). ✓ shipped 2026-04-26.
2. [x] `scripts/build-sqlite.sh` (§8.2). ✓ shipped + verified end-to-end on Intel Mac (clang produced libsqlite3.dylib, sqlite3_load_extension symbol present, sqlite_version() returns the pinned 3.53.0).
3. [x] `scripts/fetch-sqlite-vec.sh` (§8.3). ✓ shipped + verified vec0 KNN query against the pinned 0.1.9.
4. [x] `applyCustomSqlite()` + `getSqliteVecPath()` in `packages/core/src/clio/db.ts` (§11.1) + 3 new unit tests covering no-op + null + path/entryPoint surfacing. ✓ shipped 2026-04-26.
5. [x] `scripts/stage-runtime-deps.sh` + `scripts/resolve-runtime-deps.js` (§8.4). ✓ shipped with the threats #1-3 verification block. The transitive-vs-direct dep gotcha (pinning `*` for ORT-node forced 1.24.x with no darwin-x64) was caught by the verification + fixed by pinning only transformers.
6. [x] `scripts/write-manifest.sh` (§8.5). ✓ shipped with `CFCF_NODE_MODULES` override so release builds read versions from the staged tree.
7. [x] `scripts/build-release-tarball.sh` (§5.1, §8.6). ✓ shipped — produces `dist/cfcf-darwin-x64-v0.0.0-dev.tar.gz` (140 MB) on Intel Mac.
8. [x] `scripts/smoke-tarball.sh` (§13.2). ✓ shipped + passes (cfcf --version + clio embedder list + custom SQLite version assertion all OK).
9. [x] `scripts/install.sh` (§9) with `CFCF_BASE_URL` (file:// + http(s)://), `CFCF_SKIP_INIT`, running-server guard, Gatekeeper xattr strip. ✓ shipped + Phase-0 smoked end-to-end against localhost.
10. [x] `scripts/uninstall.sh` (§8.7). ✓ shipped + verified removal with `CFCF_FORCE`.
11. [x] `scripts/serve-dist.ts` (Bun.serve, ~25 LoC). ✓ shipped + used in the smoke test.
12. [x] Update `cfcf --version` to read `~/.cfcf/MANIFEST` (§11.2). ✓ shipped + verified the multi-line MANIFEST output during smoke.
13. [x] Add `.github/workflows/release.yml` (§6.1) — workflow_dispatch only, takes tag input, verifies on main, builds matrix, smoke-tests, gh release create. ✓ shipped.
14. [x] Write `docs/guides/installing.md` (§12.1) + update `README.md` (§12.2). ✓ shipped.
15. [x] **`cfcf doctor`** (§11.3). ✓ shipped + verified against the dev tree. Detects dev-mode (no MANIFEST) and downgrades the runtime-dep colocation failures to warnings so dev-mode doctor isn't alarming.
16. [x] **`cfcf self-update`** (§10.2). ✓ shipped. Thin wrapper that re-runs install.sh in upgrade mode. Implements `--check`, `--yes`, `--version`, `--base-url`. Bails cleanly in dev mode. ~180 LoC under `packages/cli/src/commands/self-update.ts`.
17. [ ] **First real install on the dogfood Mac.** Build a tarball locally; run the installer against it via file://; use the resulting `~/.cfcf/bin/cfcf` for daily work. Verify `cfcf doctor` reports all green; verify `cfcf self-update --check` works against the future host once one is configured. This is the empirical proof that the install pipeline is healthy on at least one platform; informs whether to push the branch + open the PR.
18. [ ] Mark plan item 5.5 ✅ and link back to this doc in the completion note. Close out 6.19's installer-pre-warm pending note (now superseded by `cfcf init`'s warmup behaviour from 2026-04-25 — the installer execs `cfcf init` and init handles the embedder download).

### 16.3 Order rationale

- Steps 1–4 are the SQLite infra; they can be validated **without any of the release plumbing** by running the helpers manually + unit-testing `applyCustomSqlite`.
- Steps 5–7 are tarball assembly; they produce a usable tarball without CI.
- Steps 8–9 are the install script itself; Phase 0 runs end-to-end after these.
- Steps 10–11 are polish + CI; they unblock Phase 1.
- Steps 12–13 are docs + plan update.

Each step is independently useful; the chain breaks cleanly at any point if something surprises us.

---

This doc should be enough for a clean session to pick up and build 5.5 end-to-end without re-deriving decisions. The critical invariants:

1. Bun is not a user prerequisite (embedded in `--compile`).
2. The installer ships everything, including SQLite + sqlite-vec.
3. Colocated `node_modules/` next to the binary is how native deps resolve; no `NODE_PATH`, no shim scripts.
4. `Database.setCustomSQLite(path)` is the macOS-loadExtension workaround; it must be called before the first `new Database(...)`.
5. The release workflow is tag-triggered on `main`; the install script is hosting-agnostic via `CFCF_BASE_URL`.
6. Phase 0 (local) and Phase 1 (private CI) require no external infra; Phase 2 requires a public repo decision.
