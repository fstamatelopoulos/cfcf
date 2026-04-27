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

mkdir -p "$OUT_DIR"
dest="$OUT_DIR/sqlite-vec.${ext}"

# ── Optional cache (CFCF_BUILD_CACHE_DIR) ─────────────────────────────
# Local-dev speedup: stage-dist.sh sets CFCF_BUILD_CACHE_DIR; release.yml
# does not. When set, we skip the GitHub Releases download (~3 MB
# tarball + extract) on subsequent runs with the same (version, platform).
# CI runs are unaffected because the env var is unset there.
if [[ -n "${CFCF_BUILD_CACHE_DIR:-}" ]]; then
  cache_dir="$CFCF_BUILD_CACHE_DIR/sqlite-vec/$SQLITE_VEC_VERSION/$PLATFORM"
  if [[ -f "$cache_dir/sqlite-vec.${ext}" ]]; then
    echo "[fetch-sqlite-vec] cache hit: $cache_dir/sqlite-vec.${ext} (sqlite-vec v$SQLITE_VEC_VERSION, $PLATFORM)"
    cp "$cache_dir/sqlite-vec.${ext}" "$dest"
    chmod +r "$dest"
    bytes="$(wc -c < "$dest" | tr -d ' ')"
    echo "[fetch-sqlite-vec] ✓ $dest  ($bytes bytes, from cache)"
    exit 0
  fi
  echo "[fetch-sqlite-vec] cache miss: $cache_dir/sqlite-vec.${ext}"
fi

asset="sqlite-vec-${SQLITE_VEC_VERSION}-loadable-${sv_platform}.tar.gz"
url="https://github.com/asg017/sqlite-vec/releases/download/v${SQLITE_VEC_VERSION}/${asset}"

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

# `dest` was set up top to drive the cache lookup; reuse it here.
cp "$src" "$dest"
chmod +r "$dest"

# Populate the cache after a successful fetch + extract so the next
# invocation with the same (version, platform) gets a cache hit.
# Only fires when CFCF_BUILD_CACHE_DIR is set.
if [[ -n "${CFCF_BUILD_CACHE_DIR:-}" ]]; then
  mkdir -p "$cache_dir"
  cp "$dest" "$cache_dir/sqlite-vec.${ext}"
  echo "[fetch-sqlite-vec] cached: $cache_dir/sqlite-vec.${ext}"
fi

bytes="$(wc -c < "$dest" | tr -d ' ')"
echo "[fetch-sqlite-vec] ✓ $dest  ($bytes bytes, sqlite-vec v${SQLITE_VEC_VERSION})"
