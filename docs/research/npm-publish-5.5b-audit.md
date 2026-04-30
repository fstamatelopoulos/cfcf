# 5.5b — npm-publish audit (step 1 of the 8-step plan)

**Status**: Pre-implementation audit. No code changes yet.
**Branch**: `iteration-5/npm-publish-5.5b`.
**Reviewer's job**: read this, push back on anything that feels wrong, then I execute steps 2-8.

This doc captures what's currently in place, what changes for 5.5b, and what risks I've identified. It's the rationale you'll want when reviewing the code changes that follow.

---

## TL;DR

The existing release pipeline (built in 5.5) is already 80% there. It produces correctly-shaped npm tarballs (`cfcf-X.Y.Z.tgz` and `cerefox-cfcf-native-<platform>-X.Y.Z.tgz`), uploads them to GitHub Releases, and `install.sh` + `cfcf self-update` install from those tarballs. The remaining 20% is:

1. **Wire up `npm publish`** in `release.yml` — gated behind a `publish_to_npm` workflow input so we can run-without-publishing during testing
2. **Rename** the published package from `@cerefox/cfcf-cli` to **`@cerefox/codefactory`** (per the 2026-04-29 naming decision)
3. **Add npm-required `package.json` fields** the current build doesn't bother with (`repository`, `homepage`, `keywords`, `license`)
4. **Refactor `install.sh` + `cfcf self-update`** to default to npm, with the GitHub-Releases tarball path preserved as a fallback for offline/airgapped users
5. **Fix a small bug**: `bun run build` hardcodes `v0.0.0-dev` regardless of `package.json`. Should default to `package.json`'s version so local-test installs report the right version.

No architectural changes. Same monorepo shape, same build script, same install path; just the registry source differs.

---

## What's there today

### `release.yml` workflow (4 jobs, ~190 lines)

Triggered by `workflow_dispatch` only. Inputs: `tag` (required) + `prerelease` (default false).

```
verify        → checks tag exists + is on main
   │
   ├──→ build-native (matrix: darwin-arm64, darwin-x64, linux-x64)
   │       → packs @cerefox/cfcf-native-<platform>-X.Y.Z.tgz
   │
   └──→ build-cli (single ubuntu runner)
           → packs cfcf-X.Y.Z.tgz
            ↓
release   → assembles SHA256SUMS + MANIFEST.txt + install.sh
          → uploads everything to GitHub Releases via gh release create
```

**What works well:**
- Tag-on-main verification before any build (sane safety check)
- Per-platform native package builds run on matching runners (no cross-compile guesswork)
- `concurrency.group` keyed on tag prevents duplicate releases for the same tag
- `--latest` vs `--prerelease` flag is clean (gh release CLI native flag, not a homemade hack)
- Heavy native deps (`@huggingface/transformers`, `onnxruntime-node`, `sharp`) are externalised — the user's npm/bun installer fetches them at install time, the cfcf tarball stays small

**What's missing for npm publishing:**
- No `npm publish` step anywhere
- No `NPM_TOKEN` secret consumption
- No `npm publish --dry-run` sanity check
- No conditional gating (every release is identical; can't run "build but don't publish")

**What needs to change but is fixable:**
- Hardcoded references to `@cerefox/cfcf-cli` (rename to `@cerefox/codefactory`)
- Native packages similarly: `cerefox-cfcf-native-*` → `cerefox-codefactory-native-*`. Decided below.

### `scripts/build-cli.sh` (~190 lines)

Builds the publish-shaped tarball:

1. Build web bundle (already present in CI)
2. Embed help bundle (already present in CI as of v0.16.1)
3. `bun build` the CLI; externalise `@huggingface/transformers`, `onnxruntime-node`, `sharp`
4. Stage a publish-ready package directory:
   - `package.json` named `@cerefox/cfcf-cli` (will become `@cerefox/codefactory`)
   - Includes runtime deps + `optionalDependencies` for the per-platform native packages (with `os`/`cpu` filters)
   - `bin/cfcf.js` shebang stub that imports `dist/cfcf.js`
5. `bun pm pack` produces the `.tgz`
6. SHA256 the output

**Bug**: line in root `package.json`:
```json
"build": "scripts/build-cli.sh v0.0.0-dev"
```

This hardcodes the version label baked into the tarball. Local builds always end up as `0.0.0-dev`. Fix: default to `package.json`'s version, accept explicit override:
```bash
# Default to package.json version when not provided
VERSION_INPUT="${1:-$(node -p "require('./package.json').version")}"
```

(or `bun -e 'console.log(require("./package.json").version)'` since we're in Bun-land).

After the fix:
- `bun run build` → `dist/cfcf-0.16.1.tgz` (matches current package.json)
- `bun run build v0.0.0-dev` → `dist/cfcf-0.0.0-dev.tgz` (explicit override; for special cases)
- `release.yml` calls `scripts/build-cli.sh "${{ inputs.tag }}"` so CI keeps full control over the version

### `scripts/install.sh` (~210 lines)

Curl-bash installer. Today's flow:

1. Resolve the tarball URL from `CFCF_BASE_URL` (defaults to GitHub Releases)
2. Detect platform → fetch the matching `@cerefox/cfcf-native-<platform>` tarball
3. Run `bun install -g <native-tarball-URL>` (needed because the optional-dep entry in cfcf-cli's package.json points at npm, but during the private phase those native packages aren't on npm yet — install.sh installs them explicitly first)
4. Run `bun install -g <cfcf-tarball-URL>` for the CLI itself
5. Hand off to `cfcf init` interactive setup
6. Ensure Bun ≥ 1.3 is installed (bootstrapped via `curl bun.sh/install` if missing)

**Step 2-3 become unnecessary once the native packages are on npm.** Bun's optional-deps resolver handles the per-platform selection automatically. install.sh can then just run `bun install -g @cerefox/codefactory` and let bun do the work.

But we keep install.sh for two reasons:

1. **Bun bootstrap** for users who don't yet have bun (a fresh-machine `curl URL | bash` is more friendly than "first install bun, then run bun install -g X")
2. **Offline/airgapped** users: `CFCF_INSTALL_SOURCE=tarball` mode falls back to the GitHub-Releases tarball path. We always upload tarballs to GitHub Releases anyway, so this fallback is free.

### `cfcf self-update` CLI command

Today: `bun install -g <tarball-URL-from-GitHub-Releases>`. Becomes: `bun install -g @cerefox/codefactory@latest` by default. The bun-dedup workaround stays (lockfile dups are bun's bug, registry-source-agnostic).

---

## Decisions to confirm before step 2

### Decision 1: Native package naming — rename or keep?

Today's native package names: `@cerefox/cfcf-native-darwin-arm64`, `@cerefox/cfcf-native-darwin-x64`, `@cerefox/cfcf-native-linux-x64`.

Two options:

**A. Rename to `@cerefox/codefactory-native-*`** — consistent with the new CLI name. Cleaner.
**B. Keep `@cerefox/cfcf-native-*`** — these are an implementation detail; users never type them; they're referenced from `optionalDependencies` in the published `@cerefox/codefactory` package.json. Keeping the old name avoids any churn.

**My lean: A.** Once we publish, native package names are publicly visible (in npmjs.com listings, in lockfiles, in `bun pm ls`). Cleaner brand alignment is worth the trivial extra rename work in `build-native-package.sh`. Confirm at end of audit.

### Decision 2: How aggressive should `npm publish --dry-run` be?

Adding `--dry-run` to CI is cheap and catches pre-publish issues (wrong files in tarball, broken `package.json`). I propose:

- **Always run `--dry-run`** when `release.yml` runs, regardless of whether `publish_to_npm=true`. It's the canary; it costs ~2s.
- **Only run real `npm publish`** when `publish_to_npm=true` AND we're on a non-prerelease tag (or we accept that prereleases also publish; configurable).

### Decision 3: Should the `tag` input format change?

Today: `tag=v0.16.1` (with leading `v`). The script strips the `v` for the npm version (`0.16.1`).

I'd keep this as-is. The user types git-tag form; the script normalises. Familiar.

### Decision 4: 2FA on npm — required, or just recommended?

If the npm account has 2FA enabled:
- Granular access tokens DON'T require 2FA at publish time (they encode the auth)
- Real `npm publish` from a logged-in laptop DOES require 2FA approval

For 5.5b: the GitHub Action publishes via `NPM_TOKEN`. So 2FA on the account is enabled (a one-time setup) but doesn't gate each publish. The token itself is the publish credential.

**Strong recommendation:** enable 2FA on the @cerefox npm account anyway. It protects against token-theft + account takeover. Use a TOTP authenticator (1Password, Authy, GitHub Mobile). The user's choice to enable or skip; I recommend enabling.

### Decision 5: Use `npm publish` or `bun publish`?

Both work. `npm publish` is the canonical tool; `bun publish` exists but as of bun 1.3 it has fewer features (no `--access` flag historically; some auth quirks). Within `release.yml` we'd run `npm publish` (npm CLI is available on GitHub-hosted runners by default).

---

## Risks I want to flag

### R1 — First publish is irreversible

Already covered in the prior conversation. Worth reiterating:

- `0.16.1` published to npm = forever-reserved on the registry, even if unpublished within 72 hours
- Publish-then-fix means we burn version numbers (cosmetic but eternal)
- Recovery is "publish 0.16.2 with the fix" — the bad version is just deprecated

**Mitigation**: do a full `npm publish --dry-run` + a fresh-container `bun install -g <tarball-URL>` smoke test before flipping to public + real publish.

### R2 — Repo public + npm publish leaks something

Once the repo is public, every commit in history becomes accessible. `git log --all`, `git show`, etc. If anything sensitive was ever committed (even in a now-removed file), it's still in history.

**Pre-flip checklist** (manual; I'll write it out as a checklist in the README before the flip):
- `gitleaks detect` or similar secret scanner against full history
- Search for `.env`, `*.pem`, `id_rsa`, `*.key` anywhere in history
- Search for hardcoded API keys, OAuth client secrets, etc.
- Verify no internal-only docs leak proprietary names/URLs

This isn't a 5.5b code change; it's a 5.5b operator action before the flip.

### R3 — `NPM_TOKEN` scope creep

A token over-scoped to "publish anything in @cerefox" is a foot-gun. Recommend:

- **Granular access token** scoped to specific packages: `@cerefox/codefactory` + `@cerefox/codefactory-native-*` (or whatever names we settle on)
- 90-day expiry with calendar reminder for rotation
- Stored only as a GitHub repo secret, never echoed in logs (GitHub auto-redacts)
- If the org gets more packages later, generate a new token; don't expand the existing one

### R4 — `optionalDependencies` resolution gotcha

The `@cerefox/codefactory` package.json will have:

```json
"optionalDependencies": {
  "@cerefox/codefactory-native-darwin-arm64": "0.16.1",
  "@cerefox/codefactory-native-darwin-x64":   "0.16.1",
  "@cerefox/codefactory-native-linux-x64":    "0.16.1"
}
```

bun + npm resolve ONE based on the user's `os`/`cpu`. The other two get skipped silently.

**Risk**: a user on an unsupported platform (e.g. windows-arm64, freebsd-x64) gets a successful `bun install -g @cerefox/codefactory` but NO native package — and runtime errors when cfcf tries to load the custom libsqlite3.

**Mitigation today** (already implemented in 5.5): `cfcf doctor` checks for the native package + reports clearly. We just need to make sure the post-install banner from npm/bun mentions running `cfcf doctor` first. Adding to the `postinstall` script in the published package.json is an option (some projects do this; some find it noisy). Decision: TBD; not blocking 5.5b.

### R5 — Test-tag pollution on GitHub

Step 7 of the plan involves `gh workflow run release.yml -f tag=v0.X.Y-rc1` against a test tag. This creates:

- A git tag (`v0.X.Y-rc1`) on the repo
- A GitHub Release artefact set
- (If publish_to_npm=true) an actual npm publish

For pre-flight testing we want:
- Test tags clearly named (`-rc1`, `-test`, `-canary` suffixes)
- `publish_to_npm=false` to skip the npm leg
- After testing, optionally delete the test tag + GitHub Release if we don't want the clutter

**Important**: npm versions can NOT be reused. A test tag `v0.99.0-rc1` published to npm reserves `0.99.0-rc1` forever. Use a clearly-throwaway version like `0.99.0-rc1-cfcf-test-<date>` if testing real publish, OR (better) keep test runs to `publish_to_npm=false` only.

---

## Proposed `release.yml` change shape (preview, not yet committed)

```yaml
on:
  workflow_dispatch:
    inputs:
      tag: { required: true, type: string }
      prerelease: { type: boolean, default: false }
      publish_to_npm:                                    # NEW
        description: 'Publish to npmjs.com under @cerefox/codefactory. Default false (build + GitHub Release only).'
        required: false
        type: boolean
        default: false

jobs:
  verify: ...                # unchanged
  build-native: ...          # unchanged (or rename to codefactory-native-* per Decision 1)
  build-cli: ...             # unchanged (modulo new package name)

  release:                   # GitHub Release leg — unchanged
    needs: [build-native, build-cli]
    ...

  npm-publish:               # NEW JOB
    needs: [build-native, build-cli]
    if: ${{ inputs.publish_to_npm == true }}
    runs-on: ubuntu-latest
    steps:
      - actions/download-artifact (the staged tarballs)
      - setup-node@v4 with registry-url=https://registry.npmjs.org
      - name: npm publish --dry-run (sanity)
        run: npm publish --dry-run dist/cerefox-codefactory-native-darwin-arm64-*.tgz
        # ... repeat for each artefact
      - name: npm publish (real, native packages first)
        run: npm publish --access public dist/cerefox-codefactory-native-*.tgz
        env: { NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }} }
      - name: npm publish (real, CLI last so its optionalDeps already exist)
        run: npm publish --access public dist/cfcf-*.tgz
        env: { NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }} }
```

Key details:

- **Order matters**: native packages publish first, CLI second. The CLI's `optionalDependencies` reference the native packages; if the CLI publishes first, transient resolution failures could occur. Native-first is safe.
- **`--access public`**: scoped packages (`@cerefox/...`) are private-by-default on npm. `--access public` makes them visible. Set once at publish time; npm remembers the setting.
- **Two artefact paths kept side-by-side**: GitHub Releases (existing) AND npm (new). Either is sufficient for install; together they give offline + online both.

---

## Step 1 deliverables

This audit (you're reading it). Plus:

- ✅ `docs/plan.md` 5.5b entry rewritten with the 8-step plan
- ✅ This doc at `docs/research/npm-publish-5.5b-audit.md`
- ⏳ Pending: your approval / pushback / corrections on the 5 decisions in this doc, then I move to step 2

---

## Open questions for you (review-and-decide)

1. **Decision 1 (native package naming)**: rename to `@cerefox/codefactory-native-*`, or keep `@cerefox/cfcf-native-*`? My lean: rename.
2. **Decision 4 (npm 2FA)**: do you want to enable 2FA on the @cerefox npm account, or skip for now? (Strongly recommend enabling.)
3. **Decision 5 (npm vs bun publish)**: confirm we use `npm publish` in CI (not `bun publish`). My lean: npm.
4. Anything in the **Risks** section you want me to elaborate on or address differently?
5. **Native-deps `postinstall` doctor nudge** (R4): do you want the published package to print a "run cfcf doctor" hint after install, or stay quiet? My lean: stay quiet for now; the existing post-install banner already mentions doctor.

Once these are confirmed, step 2 is straightforward: update `package.json` files + start touching `release.yml`.
