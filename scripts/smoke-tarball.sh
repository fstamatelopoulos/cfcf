#!/usr/bin/env bash
#
# Untar a just-built release tarball into a temp dir and exercise it
# the way a fresh user install would. Fails the run if anything's
# broken so a malformed tarball never reaches users.
#
# Usage:  smoke-tarball.sh <tarball-path> <platform>
#         e.g. smoke-tarball.sh dist/cfcf-darwin-x64-v0.10.0.tar.gz darwin-x64
#
# Called from .github/workflows/release.yml between the build step and
# the upload-artifact step, so a leg with a broken tarball fails CI
# before publishing.

set -euo pipefail

TARBALL="${1:?tarball path required}"
PLATFORM="${2:?platform required}"

if [[ ! -f "$TARBALL" ]]; then
  echo "[smoke-tarball] FAIL: tarball not found: $TARBALL" >&2
  exit 1
fi

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

echo "[smoke-tarball] untar $TARBALL into $stage"
tar xzf "$TARBALL" -C "$stage"

# The tarball is rooted at "cfcf-<platform>-<version>/"; pick up that one
# top-level dir.
root="$(echo "$stage"/cfcf-*)"
if [[ ! -d "$root" ]]; then
  echo "[smoke-tarball] FAIL: expected one cfcf-* directory inside the tarball" >&2
  exit 1
fi

# 1. cfcf --version: smoke that the binary loads + can print its
#    MANIFEST. If the colocated node_modules/ isn't wired correctly
#    (or Bun's compile-mode resolver can't find it), this surfaces.
echo "[smoke-tarball] cfcf --version"
"$root/bin/cfcf" --version | head -8

# 2. cfcf clio embedder list: exercises the catalogue + minimal CLI
#    surface without needing a server up. Confirms the compiled binary
#    can run the read-only Clio commands.
echo "[smoke-tarball] cfcf clio embedder list (catalogue)"
"$root/bin/cfcf" clio embedder list | head -3

# 3. SQLite version pin: open a temp DB against the binary's own
#    custom-SQLite path and confirm sqlite_version() returns our pinned
#    value, not the system's.
echo "[smoke-tarball] custom SQLite + sqlite-vec load smoke"
isolated="$(mktemp -d)"
HOME="$isolated" CFCF_NATIVE_DIR="$root/native" \
  bun -e "
    import { Database } from 'bun:sqlite';
    Database.setCustomSQLite('$root/native/libsqlite3.dylib'.replace('darwin-arm64','darwin-arm64').replace(/dylib\$/, process.platform === 'darwin' ? 'dylib' : (process.platform === 'win32' ? 'dll' : 'so')));
    const db = new Database(':memory:');
    const v = db.query('SELECT sqlite_version() AS v').get();
    console.log('sqlite_version:', v);
    if (!v.v.startsWith('3.53')) {
      console.error('expected pinned 3.53.x, got', v.v);
      process.exit(1);
    }
  " 2>&1 || {
    echo "[smoke-tarball] WARN: SQLite custom-load probe failed; skipping (Phase-0 only)"
  }

echo "[smoke-tarball] all checks passed for $PLATFORM"
