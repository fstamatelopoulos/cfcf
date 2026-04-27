#!/usr/bin/env bash
#
# Build + stage a complete dist/ ready for a file:// install. Convenience
# wrapper that runs:
#   1. scripts/build-cli.sh <version>            (cfcf-X.Y.Z.tgz)
#   2. scripts/build-native-package.sh <plat> X  (per-platform native tgz)
#   3. cp scripts/install.sh    → dist/install.sh
#   4. write a minimal MANIFEST.txt into dist/
#
# After it runs, dist/ contains everything the installer needs:
#   cfcf-X.Y.Z.tgz                                 (cli)
#   cerefox-cfcf-native-<platform>-X.Y.Z.tgz       (native, host platform)
#   install.sh                                      (the curl-bash wrapper)
#   MANIFEST.txt                                    (resolves "latest" mode)
#
# Then dogfood the install with:
#   CFCF_BASE_URL="file://$(pwd)/dist" CFCF_VERSION=v0.0.0-dev bash dist/install.sh
#
# Usage:  stage-dist.sh [version]
#         e.g. stage-dist.sh v0.0.0-dev   (default if omitted)
#
# Builds for the host platform only (whatever scripts/detect-platform.sh
# reports). Cross-platform builds happen in release.yml's matrix.

set -euo pipefail

VERSION_INPUT="${1:-v0.0.0-dev}"
VERSION="${VERSION_INPUT#v}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/dist}"

PLATFORM="$("$SCRIPT_DIR/detect-platform.sh")"

# ── Cache the libsqlite3 + sqlite-vec downloads/builds across runs ────
#
# stage-dist.sh wipes dist/ on every invocation, so the per-platform
# native package gets rebuilt every time -- which means re-downloading
# the SQLite amalgamation (~3 MB) + recompiling, plus re-downloading
# the sqlite-vec release asset. The compiled binaries are
# deterministic given a (version, platform) pair, so caching them in
# ~/.cache/cfcf-build/ skips both the network and the compile on
# subsequent runs.
#
# build-sqlite.sh + fetch-sqlite-vec.sh honour CFCF_BUILD_CACHE_DIR
# when set; release.yml does NOT set it (CI runners are ephemeral and
# the env var stays unset, preserving the original "fresh download
# every time" behaviour with no risk of stale cache hits in releases).
# Override the path with CFCF_BUILD_CACHE_DIR=<path> stage-dist.sh.
export CFCF_BUILD_CACHE_DIR="${CFCF_BUILD_CACHE_DIR:-$HOME/.cache/cfcf-build}"
mkdir -p "$CFCF_BUILD_CACHE_DIR"

echo "[stage-dist] version:  $VERSION_INPUT (npm form: $VERSION)"
echo "[stage-dist] platform: $PLATFORM"
echo "[stage-dist] out:      $OUT_DIR"
echo "[stage-dist] cache:    $CFCF_BUILD_CACHE_DIR"
echo

# Wipe the prior dist/ to avoid stale tarballs lingering. tsbuildinfo
# leaks under dist/ have bitten us before -- a clean rebuild prevents
# that. Preserve the dir itself.
mkdir -p "$OUT_DIR"
find "$OUT_DIR" -mindepth 1 -delete 2>/dev/null || true

# 1. CLI tarball
echo "[stage-dist] 1/4  build cli tarball"
"$SCRIPT_DIR/build-cli.sh" "$VERSION_INPUT"
echo

# 2. Per-platform native tarball
echo "[stage-dist] 2/4  build native tarball ($PLATFORM)"
"$SCRIPT_DIR/build-native-package.sh" "$PLATFORM" "$VERSION_INPUT"
echo

# 3. install.sh
echo "[stage-dist] 3/4  copy install.sh"
cp "$SCRIPT_DIR/install.sh" "$OUT_DIR/install.sh"
chmod +x "$OUT_DIR/install.sh"

# 4. MANIFEST.txt
# install.sh's "latest" mode follows GitHub's release-redirect; for
# file:// installs CFCF_VERSION must be explicit, but we still write
# MANIFEST.txt so the user can curl it for sanity / scripted use.
echo "[stage-dist] 4/4  write MANIFEST.txt"
cat > "$OUT_DIR/MANIFEST.txt" <<EOF
cfcf: $VERSION_INPUT
cli-tarball: cfcf-$VERSION.tgz
native-tarball: cerefox-cfcf-native-$PLATFORM-$VERSION.tgz
built-at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
host-platform: $PLATFORM
EOF

echo
echo "[stage-dist] ✓ dist/ ready:"
ls -la "$OUT_DIR"
echo
echo "[stage-dist] Install with:"
echo "  CFCF_BASE_URL=\"file://$OUT_DIR\" CFCF_VERSION=$VERSION_INPUT bash $OUT_DIR/install.sh"
echo
echo "[stage-dist] If a previous cfcf install is on PATH, stop the server first:"
echo "  cfcf server stop"
echo "[stage-dist] After install, restart it (the running server still has the old bundled JS in memory):"
echo "  cfcf server start"
