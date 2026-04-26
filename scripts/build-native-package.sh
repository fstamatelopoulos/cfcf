#!/usr/bin/env bash
#
# Build a per-platform @cerefox/cfcf-native-<platform> npm tarball.
#
# Per docs/research/installer-design.md §3.2. The native package contains
# the pinned libsqlite3 (loadExtension enabled) + sqlite-vec extension;
# `os` + `cpu` fields in package.json restrict installation to the matching
# platform so npm/bun only install the right one. Same pattern sharp,
# swc, esbuild, and Claude Code use.
#
# Usage:  build-native-package.sh <platform> <version>
#         e.g. build-native-package.sh darwin-arm64 v0.10.0
#
# Output: dist/cerefox-cfcf-native-<platform>-<version>.tgz
#
# Env:
#   OUT_DIR           where the tarball lands (default: dist/)
#   SQLITE_VERSION    forwarded to build-sqlite.sh (default pinned)
#   SQLITE_VEC_VERSION forwarded to fetch-sqlite-vec.sh (default pinned)

set -euo pipefail

PLATFORM="${1:?platform argument required (e.g. darwin-arm64)}"
VERSION_INPUT="${2:?version argument required (e.g. v0.10.0)}"
VERSION="${VERSION_INPUT#v}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/dist}"

# Validate platform tag up front so a typo doesn't get pinned into a
# package.json's `os`/`cpu` fields and silently produce an unusable tarball.
case "$PLATFORM" in
  darwin-arm64|darwin-x64|linux-x64|windows-x64) ;;
  *)
    echo "[build-native-package] unsupported platform: $PLATFORM" >&2
    echo "[build-native-package] supported: darwin-arm64, darwin-x64, linux-x64, windows-x64" >&2
    exit 1 ;;
esac

# Map platform → npm `os` / `cpu` values.
case "$PLATFORM" in
  darwin-arm64) npm_os="darwin"; npm_cpu="arm64" ;;
  darwin-x64)   npm_os="darwin"; npm_cpu="x64"   ;;
  linux-x64)    npm_os="linux";  npm_cpu="x64"   ;;
  windows-x64)  npm_os="win32";  npm_cpu="x64"   ;;
esac

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

echo "[build-native-package] platform: $PLATFORM"
echo "[build-native-package] version:  $VERSION"
echo "[build-native-package] stage:    $stage"
echo "[build-native-package] output:   $OUT_DIR/cerefox-cfcf-native-$PLATFORM-$VERSION.tgz"
echo

# ── 1. compile pinned libsqlite3 ──────────────────────────────────────
echo "[build-native-package] 1/3  compile pinned libsqlite3"
"$SCRIPT_DIR/build-sqlite.sh" "$PLATFORM" "$stage"

# ── 2. fetch pinned sqlite-vec ────────────────────────────────────────
echo "[build-native-package] 2/3  fetch pinned sqlite-vec"
"$SCRIPT_DIR/fetch-sqlite-vec.sh" "$PLATFORM" "$stage"

# ── 3. write package.json + pack ──────────────────────────────────────
echo "[build-native-package] 3/3  package.json + pack"
cat > "$stage/package.json" <<EOF
{
  "name": "@cerefox/cfcf-native-$PLATFORM",
  "version": "$VERSION",
  "description": "cfcf pinned native libs (libsqlite3 + sqlite-vec) for $PLATFORM",
  "files": [
    "libsqlite3.*",
    "sqlite-vec.*"
  ],
  "os": ["$npm_os"],
  "cpu": ["$npm_cpu"],
  "license": "UNLICENSED",
  "homepage": "https://github.com/fstamatelopoulos/cfcf"
}
EOF

# Bun's `pm pack` is the simplest way to produce an npm-format tarball
# from a directory. We rename the output to match the cerefox-cfcf-
# native-<platform>-<version>.tgz convention release.yml uploads.
mkdir -p "$OUT_DIR"
(
  cd "$stage"
  bun pm pack >/dev/null
  src_tgz="$(ls -t *.tgz | head -1)"
  cp "$src_tgz" "$OUT_DIR/cerefox-cfcf-native-$PLATFORM-$VERSION.tgz"
)

# sha256 sidecar.
(
  cd "$OUT_DIR"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "cerefox-cfcf-native-$PLATFORM-$VERSION.tgz" > "cerefox-cfcf-native-$PLATFORM-$VERSION.tgz.sha256"
  else
    shasum -a 256 "cerefox-cfcf-native-$PLATFORM-$VERSION.tgz" > "cerefox-cfcf-native-$PLATFORM-$VERSION.tgz.sha256"
  fi
)

bytes="$(wc -c < "$OUT_DIR/cerefox-cfcf-native-$PLATFORM-$VERSION.tgz" | tr -d ' ')"
human="$(echo "$bytes" | awk '{
  if ($1 > 1048576) printf "%.1f MB", $1/1048576
  else if ($1 > 1024) printf "%.1f KB", $1/1024
  else print $1 " bytes"
}')"
echo
echo "[build-native-package] ✓ $OUT_DIR/cerefox-cfcf-native-$PLATFORM-$VERSION.tgz  ($human)"
