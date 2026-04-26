#!/usr/bin/env bash
#
# Download the sqlite-vec loadable extension prebuilt for a given platform
# and place it in <out-dir> as `sqlite-vec.<dylib|so|dll>`. Released
# binaries come from github.com/asg017/sqlite-vec — we don't compile vec0
# ourselves.
#
# Usage:  fetch-sqlite-vec.sh <platform> <out-dir>
# Env override: SQLITE_VEC_VERSION (default 0.1.9 — verified 2026-04-26).
#
# The version is pinned per cfcf release (decided 2026-04-26). Bump in
# lockstep with the SQLite pin in build-sqlite.sh after verifying
# compatibility — sqlite-vec's CHANGELOG documents the minimum SQLite
# version it requires.

set -euo pipefail

PLATFORM="${1:?platform argument required (e.g. darwin-arm64)}"
OUT_DIR="${2:?out-dir argument required}"
SQLITE_VEC_VERSION="${SQLITE_VEC_VERSION:-0.1.9}"

# Map our cfcf platform tag → sqlite-vec's release-asset platform tag +
# expected lib filename inside the tarball.
case "$PLATFORM" in
  darwin-arm64) sv_platform="macos-aarch64"   ; ext="dylib" ;;
  darwin-x64)   sv_platform="macos-x86_64"    ; ext="dylib" ;;
  linux-x64)    sv_platform="linux-x86_64"    ; ext="so"    ;;
  windows-x64)  sv_platform="windows-x86_64"  ; ext="dll"   ;;
  *)
    echo "[fetch-sqlite-vec] unsupported platform: $PLATFORM" >&2
    exit 1 ;;
esac

asset="sqlite-vec-${SQLITE_VEC_VERSION}-loadable-${sv_platform}.tar.gz"
url="https://github.com/asg017/sqlite-vec/releases/download/v${SQLITE_VEC_VERSION}/${asset}"

mkdir -p "$OUT_DIR"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "[fetch-sqlite-vec] downloading $url"
curl -fsSL "$url" -o "$tmp/sv.tar.gz"
(cd "$tmp" && tar xzf sv.tar.gz)

# sqlite-vec's tarballs lay the lib out at the top level under the name
# `vec0.<ext>`. Find it explicitly rather than hardcoding so future
# packaging tweaks don't silently break.
src=$(find "$tmp" -maxdepth 3 -type f -name "vec0.${ext}" | head -1)
if [[ -z "$src" ]]; then
  echo "[fetch-sqlite-vec] FAIL: vec0.${ext} not found in $url" >&2
  echo "[fetch-sqlite-vec] tarball contents:" >&2
  (cd "$tmp" && find . -type f | head -20 >&2)
  exit 1
fi

dest="$OUT_DIR/sqlite-vec.${ext}"
cp "$src" "$dest"
chmod +r "$dest"
bytes="$(wc -c < "$dest" | tr -d ' ')"
echo "[fetch-sqlite-vec] ✓ $dest  ($bytes bytes, sqlite-vec v${SQLITE_VEC_VERSION})"
