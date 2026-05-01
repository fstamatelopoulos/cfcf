#!/usr/bin/env bash
#
# local-install.sh — build cfcf from this checkout and install it on
# your machine, mimicking what an end user gets via the curl-bash
# install.sh + GitHub Release path. Use this for end-to-end UX testing
# of changes that touch the install pipeline (install.sh, build-cli.sh,
# self-update, banners, etc.) before triggering a real release.
#
# What it does:
#   1. Cleans any existing cfcf install (uninstall.sh).
#      Skip with --keep if you want to test an upgrade-in-place path.
#   2. Runs scripts/stage-dist.sh to build dist/ (CLI + native + install.sh).
#   3. Runs the local install.sh against `file://$(pwd)/dist`.
#   4. Verifies the install with `cfcf --version` and `cfcf doctor`.
#   5. Prints how to restore the published version when you're done.
#
# Result: `cfcf` on your PATH points at the locally-built version,
# installed at the same canonical location an end user gets
# (~/.bun/lib/node_modules/...) with the same banner/doctor experience.
#
# Usage:
#   ./scripts/local-install.sh                      # auto-version: v<root.version>-local
#   ./scripts/local-install.sh v0.16.5-rc           # custom label
#   ./scripts/local-install.sh --keep               # don't uninstall first
#   ./scripts/local-install.sh --keep v0.16.5-rc    # both
#
# To restore the published version when you're done:
#   cfcf self-update --yes
#   # or just re-run the canonical curl-bash installer:
#   curl -fsSL https://github.com/fstamatelopoulos/cfcf/releases/latest/download/install.sh | bash

set -euo pipefail

# ── Args ───────────────────────────────────────────────────────────────

VERSION_INPUT=""    # empty = auto-derive from root package.json
DO_CLEAN=1          # default: clean before install (the common case)

for arg in "$@"; do
  case "$arg" in
    --keep)
      DO_CLEAN=0
      ;;
    --clean)
      # Backwards-compat / explicit. Already the default; harmless to pass.
      DO_CLEAN=1
      ;;
    -h|--help)
      sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "[local-install] unknown flag: $arg" >&2
      exit 1
      ;;
    *)
      # Normalise: strip leading "v", then re-add (so v0.16.5 and 0.16.5 both work).
      VERSION_INPUT="v${arg#v}"
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Auto-derive version from root package.json ─────────────────────────

if [[ -z "$VERSION_INPUT" ]]; then
  # Read the root version with a tiny portable JS so we don't depend on
  # `jq` being installed. node + bun both expose the same Node API here.
  root_version="$(
    cd "$REPO_DIR" && \
    node -e 'console.log(require("./package.json").version)' 2>/dev/null \
    || bun --silent -e 'console.log(JSON.parse(await Bun.file("package.json").text()).version)' 2>/dev/null
  )"
  if [[ -z "$root_version" ]]; then
    echo "[local-install] ✗ could not read version from $REPO_DIR/package.json" >&2
    echo "[local-install]   pass an explicit version: ./scripts/local-install.sh v0.16.5-rc" >&2
    exit 1
  fi
  VERSION_INPUT="v${root_version}-local"
fi

echo "[local-install] checkout: $REPO_DIR"
echo "[local-install] version label: $VERSION_INPUT"
if (( DO_CLEAN )); then
  echo "[local-install] mode: clean install (use --keep to skip the uninstall step)"
else
  echo "[local-install] mode: keep existing install (--keep)"
fi
echo

# ── Step 1: clean (default) ────────────────────────────────────────────

if (( DO_CLEAN )); then
  echo "[local-install] step 1/4: cleaning existing cfcf install"
  if [[ -x "$SCRIPT_DIR/uninstall.sh" ]]; then
    bash "$SCRIPT_DIR/uninstall.sh" || true
  else
    # uninstall.sh missing for some reason; do the canonical removal inline.
    npm remove -g --prefix "$HOME/.bun" \
      @cerefox/codefactory \
      @cerefox/codefactory-native-darwin-arm64 \
      @cerefox/codefactory-native-darwin-x64 \
      @cerefox/codefactory-native-linux-x64 \
      2>/dev/null || true
  fi
  echo
else
  echo "[local-install] step 1/4: skipping clean (--keep)"
  echo
fi

# ── Step 2: stage dist/ ────────────────────────────────────────────────

echo "[local-install] step 2/4: building dist/ via stage-dist.sh"
"$SCRIPT_DIR/stage-dist.sh" "$VERSION_INPUT"
echo

# ── Step 3: run install.sh against the local dist ──────────────────────

echo "[local-install] step 3/4: running install.sh against file://$REPO_DIR/dist"
echo
CFCF_BASE_URL="file://$REPO_DIR/dist" \
CFCF_VERSION="$VERSION_INPUT" \
  bash "$REPO_DIR/dist/install.sh"

# ── Step 4: verify ─────────────────────────────────────────────────────

echo
echo "[local-install] step 4/4: verifying install"

# Make sure the freshly-installed cfcf is what we run, not a stale shell
# alias / hashed path. `command -v` returns the resolved path; we shell out
# to it explicitly.
cfcf_path="$(command -v cfcf || true)"
if [[ -z "$cfcf_path" ]]; then
  echo "[local-install] ✗ cfcf not on PATH after install. Check install.sh output above."
  exit 1
fi

actual_version="$("$cfcf_path" --version 2>&1 || echo unknown)"
echo "[local-install]   binary: $cfcf_path"
echo "[local-install]   version: $actual_version"
echo

echo "[local-install] running cfcf doctor:"
echo
"$cfcf_path" doctor || {
  echo
  echo "[local-install] ✗ doctor reported issues (above). Local install may be broken."
  exit 1
}

# ── Done ───────────────────────────────────────────────────────────────

echo
echo "[local-install] ✓ done. Local install of $VERSION_INPUT is live."
echo
echo "  To restore the published version when you're finished testing:"
echo "    cfcf self-update --yes"
echo "    # or, equivalently, re-run the canonical curl-bash installer:"
echo "    curl -fsSL https://github.com/fstamatelopoulos/cfcf/releases/latest/download/install.sh | bash"
echo
