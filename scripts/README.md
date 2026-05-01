# cfcf Scripts

Development and release utility scripts.

## Developer workflow

Three modes, in order of iteration speed:

| Mode | Command | Time | Use for |
|---|---|---|---|
| **Dev (no install)** | `bun run packages/cli/src/index.ts <cmd>` | ~0s | Day-to-day iteration on CLI / server / core code. Fastest feedback. |
| **Local end-to-end install** | `./scripts/local-install.sh` (cleans first; `--keep` to skip) | ~30s | Full e2e UX testing: install.sh banner, post-install doctor, real `~/.bun/bin/cfcf` symlink, exact same flow an end user gets via curl-bash. |
| **Real release** | trigger `release.yml` from GitHub Actions UI | ~5 min | Ship to npmjs.com + GitHub Release. Irreversible. |

After a `local-install.sh` session, restore the published version with:
```bash
cfcf self-update --version v0.16.4
# or:
npm install -g --prefix ~/.bun @cerefox/codefactory@latest
```

## Release / install

| Script | Role |
|---|---|
| `build-cli.sh [version]` | Bundles `packages/cli/src/index.ts` (no `--compile`), stages the publish-shaped package, runs `bun pm pack` → `dist/cfcf-X.Y.Z.tgz`. The npm tarball users `bun install -g`. The published name is `@cerefox/codefactory`; the CLI binary is `cfcf`. **Version resolution** (first non-empty wins): positional arg → `CFCF_VERSION` env → root `package.json`'s `version` field. Leading `v` is optional in either form. |
| `build-native-package.sh <platform> <version>` | Builds the per-platform `@cerefox/codefactory-native-<platform>` tarball: pinned libsqlite3 + sqlite-vec + a small `package.json` with matching `os`/`cpu` fields. |
| `build-sqlite.sh <platform> <out-dir>` | Compiles libsqlite3 from the pinned amalgamation with `SQLITE_ENABLE_LOAD_EXTENSION=1`. Called by `build-native-package.sh`. |
| `fetch-sqlite-vec.sh <platform> <out-dir>` | Downloads the pinned sqlite-vec loadable extension. Called by `build-native-package.sh`. |
| `install.sh` | The curl-bash installer. Bootstraps Bun + npm if missing, runs `npm install -g --prefix ~/.bun @cerefox/codefactory`, prints the next-steps banner. |
| `uninstall.sh` | Detects cfcf at any of the historical install locations and removes via the right tool. |
| `smoke-tarball.sh <cli-tarball> [native-tarball]` | Installs a freshly-built tarball into an isolated sandbox and runs `cfcf --version` + `cfcf doctor`. |
| `stage-dist.sh [version]` | Convenience wrapper: wipes `dist/`, builds the cli + host-platform native tarballs, copies `install.sh`, writes `MANIFEST.txt`. After it runs, `dist/` is ready for a `file://` install via the printed one-liner. **Caches** compiled libsqlite3 + downloaded sqlite-vec under `~/.cache/cfcf-build/` (override via `CFCF_BUILD_CACHE_DIR`); subsequent runs skip the network + compile. CI (`release.yml`) does NOT set the env var, so release builds always do a clean download + compile. |
| `local-install.sh [--keep] [version]` | **Recommended for end-to-end UX testing of install changes.** Wraps `stage-dist.sh` + `install.sh` + `cfcf doctor` into one command. Mimics what an end user gets via curl-bash, but with locally-built tarballs from the host platform. **Cleans existing cfcf install first by default**; pass `--keep` to test in-place upgrade behaviour. Default version label: `v<root.package.json.version>-local` (e.g. `v0.16.4-local`); pass an explicit `vX.Y.Z[-suffix]` to override. |
| `serve-dist.ts` | Phase-0 dev helper: serves `dist/` over HTTP so `install.sh` can hit `http://localhost:8080/...`. |
| `detect-platform.sh` | Prints the cfcf platform tag (`darwin-arm64`, `darwin-x64`, …) for the current machine. |

See [`docs/research/installer-design.md`](../docs/research/installer-design.md) for the full distribution model and rationale.

## setup-test-repos.sh

Creates two test repos at `/tmp/cfcf-calc` and `/tmp/cfcf-tracker` with problem-pack files copied from `problem-packs/`. Each repo has an initial commit with a README.

```bash
./scripts/setup-test-repos.sh
```

After running, register the workspaces with cfcf:
```bash
bun run dev:cli -- workspace init --repo /tmp/cfcf-calc --name calc
bun run dev:cli -- workspace init --repo /tmp/cfcf-tracker --name tracker
```

## cleanup-test-repos.sh

Removes all cfcf test state: test repos, workspace configs, loop state, and agent logs. Preserves the global cfcf config (`config.json` with agent/model settings).

```bash
./scripts/cleanup-test-repos.sh             # interactive (prompts for confirmation)
./scripts/cleanup-test-repos.sh --force     # skip confirmation
```
