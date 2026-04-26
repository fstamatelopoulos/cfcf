#!/usr/bin/env bash
#
# Emit the MANIFEST text file that ships inside every per-platform
# tarball. Records every pinned version (cfcf, bun, sqlite, sqlite-vec
# + the runtime npm deps) so a user / `cfcf --version` can see exactly
# which versions are running locally.
#
# Usage:  write-manifest.sh <version> [out-path]
#         If <out-path> is omitted, prints to stdout.
#
# Field shape: "key: value", one per line. Machine-readable + scannable.
# `cfcf --version` parses this; release.yml uploads it as a release
# asset alongside the tarballs.

set -euo pipefail

VERSION="${1:?version argument required (e.g. v0.10.0)}"
OUT="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM="$("$SCRIPT_DIR/detect-platform.sh")"

# These match the constants the build scripts pin to. Keep in sync if
# build-sqlite.sh / fetch-sqlite-vec.sh / packages/core/package.json
# change.
SQLITE_VERSION="${SQLITE_VERSION:-3.53.0}"
SQLITE_VEC_VERSION="${SQLITE_VEC_VERSION:-0.1.9}"

bun_version="$(bun --version 2>/dev/null || echo unknown)"

# Resolve the actually-installed transformers/onnxruntime-node/sharp
# versions. Search order:
#   1. CFCF_NODE_MODULES (set by build-release-tarball.sh during release
#      builds) — points at the staged tree where versions are flat
#   2. packages/core/node_modules — dev mode (symlinks into .bun/, only
#      direct deps land here)
#   3. fall back to "unknown"
read_version() {
  local pkg="$1"
  local candidates=()
  [[ -n "${CFCF_NODE_MODULES:-}" ]] && candidates+=("$CFCF_NODE_MODULES/$pkg/package.json")
  candidates+=("$SCRIPT_DIR/../packages/core/node_modules/$pkg/package.json")
  for p in "${candidates[@]}"; do
    if [[ -f "$p" ]]; then
      bun -e "console.log(JSON.parse(require('fs').readFileSync('$p','utf8')).version)" 2>/dev/null && return
    fi
  done
  echo "unknown"
}

transformers_v="$(read_version "@huggingface/transformers" "unknown")"
ort_v="$(read_version "onnxruntime-node" "unknown")"
sharp_v="$(read_version "sharp" "unknown")"

emit() { cat <<EOF
cfcf:                $VERSION
platform:            $PLATFORM
built-at:            $(date -u +%Y-%m-%dT%H:%M:%SZ)
bun:                 $bun_version
sqlite:              $SQLITE_VERSION
sqlite-vec:          $SQLITE_VEC_VERSION
transformers:        $transformers_v
onnxruntime-node:    $ort_v
sharp:               $sharp_v
EOF
}

if [[ -n "$OUT" ]]; then
  emit > "$OUT"
  echo "[write-manifest] wrote $OUT"
else
  emit
fi
