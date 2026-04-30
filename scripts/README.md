# cfcf Scripts

Development and release utility scripts.

## Release / install

| Script | Role |
|---|---|
| `build-cli.sh [version]` | Bundles `packages/cli/src/index.ts` (no `--compile`), stages the publish-shaped package, runs `bun pm pack` → `dist/cfcf-X.Y.Z.tgz`. The npm tarball users `bun install -g`. The published name is `@cerefox/codefactory`; the CLI binary is `cfcf`. **Version resolution** (first non-empty wins): positional arg → `CFCF_VERSION` env → root `package.json`'s `version` field. Leading `v` is optional in either form. |
| `build-native-package.sh <platform> <version>` | Builds the per-platform `@cerefox/codefactory-native-<platform>` tarball: pinned libsqlite3 + sqlite-vec + a small `package.json` with matching `os`/`cpu` fields. |
| `build-sqlite.sh <platform> <out-dir>` | Compiles libsqlite3 from the pinned amalgamation with `SQLITE_ENABLE_LOAD_EXTENSION=1`. Called by `build-native-package.sh`. |
| `fetch-sqlite-vec.sh <platform> <out-dir>` | Downloads the pinned sqlite-vec loadable extension. Called by `build-native-package.sh`. |
| `install.sh` | The curl-bash installer. Bootstraps Bun if missing, then `bun install -g <tarball>`, then hands off to `cfcf init`. |
| `uninstall.sh` | One-liner wrapper around `bun remove -g @cerefox/codefactory`. |
| `smoke-tarball.sh <cli-tarball> [native-tarball]` | Installs a freshly-built tarball into an isolated sandbox and runs `cfcf --version` + `cfcf doctor`. |
| `stage-dist.sh [version]` | Convenience wrapper: wipes `dist/`, builds the cli + host-platform native tarballs, copies `install.sh`, writes `MANIFEST.txt`. After it runs, `dist/` is ready for a `file://` dogfood install via the printed one-liner. **Caches** compiled libsqlite3 + downloaded sqlite-vec under `~/.cache/cfcf-build/` (override via `CFCF_BUILD_CACHE_DIR`); subsequent runs skip the network + compile. CI (`release.yml`) does NOT set the env var, so release builds always do a clean download + compile. |
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
