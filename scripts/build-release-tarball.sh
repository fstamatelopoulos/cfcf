#!/usr/bin/env bash
#
# Assemble a per-platform release tarball that contains everything an
# end user needs to run cfcf:
#   - the Bun-compiled cfcf binary
#   - colocated node_modules/ for the externalised native deps
#   - libsqlite3 (with loadExtension enabled) + sqlite-vec under native/
#   - MANIFEST + LICENSE + uninstall.sh
#
# Used by:
#   - Phase 0: a developer running this on their laptop to test install.sh
#     against localhost (no GitHub Actions involved)
#   - Phase 1+: the release.yml workflow, on a runner of the target arch
#
# Usage:  build-release-tarball.sh <version>
#         e.g. build-release-tarball.sh v0.10.0  →  dist/cfcf-<platform>-v0.10.0.tar.gz
#
# Env:
#   PLATFORM   override platform autodetect (release.yml uses this)
#   BUN_TARGET override the --target flag passed to bun build
#              (default: bun-<platform> with arch normalisation)
#   OUT_DIR    where the final tarball lands (default: dist/)

set -euo pipefail

VERSION="${1:?version argument required (e.g. v0.10.0)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PLATFORM="$("$SCRIPT_DIR/detect-platform.sh")"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/dist}"

# Map cfcf platform tag → bun --target value (arch naming differs).
case "$PLATFORM" in
  darwin-arm64) bun_target_default="bun-darwin-arm64" ;;
  darwin-x64)   bun_target_default="bun-darwin-x64" ;;
  linux-x64)    bun_target_default="bun-linux-x64" ;;
  windows-x64)  bun_target_default="bun-windows-x64" ;;
esac
BUN_TARGET="${BUN_TARGET:-$bun_target_default}"

# Stage everything in a tmp dir; final tar at the very end so a partial
# failure leaves no half-built tarball behind.
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/bin" "$stage/native"

echo "[build-tarball] target: $PLATFORM (bun --target $BUN_TARGET)"
echo "[build-tarball] stage:  $stage"
echo "[build-tarball] output: $OUT_DIR/cfcf-$PLATFORM-$VERSION.tar.gz"
echo

# ── 1. cfcf binary ────────────────────────────────────────────────────
# Externalise the three native-addon-bearing deps so bun --compile
# doesn't try to bundle them. They get colocated under bin/node_modules/.
echo "[build-tarball] 1/6  bun build --compile (cfcf binary)"
cd "$REPO_ROOT"
bun run build:web
bun build packages/cli/src/index.ts \
  --compile \
  --target "$BUN_TARGET" \
  --external @huggingface/transformers \
  --external onnxruntime-node \
  --external sharp \
  --outfile "$stage/bin/cfcf"

# ── 2. runtime deps ───────────────────────────────────────────────────
echo "[build-tarball] 2/6  stage runtime deps (transformers + transitive)"
"$SCRIPT_DIR/stage-runtime-deps.sh" "$stage/bin/node_modules" "$PLATFORM"

# ── 3. libsqlite3 (custom build, loadExtension enabled) ───────────────
echo "[build-tarball] 3/6  compile pinned libsqlite3"
"$SCRIPT_DIR/build-sqlite.sh" "$PLATFORM" "$stage/native"

# ── 4. sqlite-vec (vendored prebuilt) ─────────────────────────────────
echo "[build-tarball] 4/6  fetch pinned sqlite-vec"
"$SCRIPT_DIR/fetch-sqlite-vec.sh" "$PLATFORM" "$stage/native"

# ── 5. MANIFEST + LICENSE + uninstall.sh ──────────────────────────────
echo "[build-tarball] 5/6  manifest + ancillary files"
CFCF_NODE_MODULES="$stage/bin/node_modules" \
  "$SCRIPT_DIR/write-manifest.sh" "$VERSION" "$stage/MANIFEST"
cp "$REPO_ROOT/LICENSE" "$stage/LICENSE" 2>/dev/null || \
  echo "[build-tarball] note: no LICENSE file in repo root, skipping"
cp "$SCRIPT_DIR/uninstall.sh" "$stage/uninstall.sh" 2>/dev/null && \
  chmod +x "$stage/uninstall.sh" || \
  echo "[build-tarball] note: scripts/uninstall.sh not present yet, skipping"

# ── 6. tarball + sha256 ───────────────────────────────────────────────
echo "[build-tarball] 6/6  tar + sha256"
mkdir -p "$OUT_DIR"
tarball_name="cfcf-$PLATFORM-$VERSION.tar.gz"
# --strip-components=0; the tar is rooted at "cfcf-<platform>-<version>/"
# so untarring drops a single named directory rather than scattering
# files at the user's cwd. install.sh handles --strip-components=1.
top_dir="cfcf-$PLATFORM-$VERSION"
mv "$stage" "$(dirname "$stage")/$top_dir"
stage="$(dirname "$stage")/$top_dir"
tar -C "$(dirname "$stage")" -czf "$OUT_DIR/$tarball_name" "$top_dir"

# sha256 in the standard `<sha>  <filename>` format that
# `sha256sum -c` expects.
(
  cd "$OUT_DIR"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$tarball_name" > "$tarball_name.sha256"
  else
    # macOS doesn't have sha256sum; shasum -a 256 is the equivalent.
    shasum -a 256 "$tarball_name" > "$tarball_name.sha256"
  fi
)

bytes="$(wc -c < "$OUT_DIR/$tarball_name" | tr -d ' ')"
human="$(echo "$bytes" | awk '{
  if ($1 > 1073741824) printf "%.1f GB", $1/1073741824
  else if ($1 > 1048576) printf "%.1f MB", $1/1048576
  else if ($1 > 1024) printf "%.1f KB", $1/1024
  else print $1 " bytes"
}')"
echo
echo "[build-tarball] ✓ $OUT_DIR/$tarball_name  ($human)"
echo "[build-tarball] ✓ $OUT_DIR/$tarball_name.sha256"
