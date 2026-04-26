#!/usr/bin/env bash
#
# Stage the three externalised runtime deps (@huggingface/transformers,
# onnxruntime-node, sharp) into a flat node_modules/ tree suitable for
# colocation with the cfcf binary.
#
# Output: <out-dir> populated with a hoisted node_modules/ tree
# containing the runtime deps + their transitive native addons FOR THE
# CURRENT MACHINE'S PLATFORM. This script MUST run on a runner of the
# target architecture (the release CI matrix arranges this).
#
# Usage: stage-runtime-deps.sh <out-node-modules-dir> <platform>
#
# Threats this script defends against (see docs/research/installer-design.md
# §8.4 "three threats"):
#
#   1. Bun's untrusted-deps default skips postinstalls -> trustedDependencies
#      in the staging package.json forces them to run.
#   2. Bun's isolated linker produces dangling symlinks across packages ->
#      --linker hoisted produces a flat tree; cp -RL dereferences any
#      remaining symlinks.
#   3. Postinstall silently picks the wrong arch -> the verification block
#      at the bottom asserts the expected native binaries exist for the
#      current platform. Build fails loudly when missing.

set -euo pipefail

OUT="${1:?out-node-modules-dir argument required}"
PLATFORM="${2:?platform argument required (e.g. darwin-arm64)}"

scripts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# 1. Compose a fresh package.json with the version pins resolved from
#    packages/core/package.json. trustedDependencies forces Bun to RUN
#    onnxruntime-node + sharp postinstalls; without this Bun silently
#    skips them and we ship a node_modules/ that's missing the native
#    binary downloads (sharp's libvips bundle, etc.).
cat > "$tmp/package.json" <<'EOF'
{
  "name": "cfcf-runtime-deps",
  "version": "0.0.0",
  "private": true,
  "dependencies": {},
  "trustedDependencies": ["onnxruntime-node", "sharp"]
}
EOF
"$scripts_dir/resolve-runtime-deps.js" "$tmp/package.json"

# 2. Install with the hoisted linker so node_modules/ is a flat tree
#    rather than the default isolated layout (which symlinks into
#    .bun/<pkg>@<ver>/node_modules/<pkg>). Hoisted means we can copy
#    the whole tree without ending up with broken symlinks pointing
#    into the build host's content-addressed cache.
echo "[stage-runtime-deps] bun install --production --linker hoisted into $tmp"
(cd "$tmp" && bun install --production --linker hoisted --no-summary)

# 3. Copy the staged tree into the output dir, dereferencing any
#    remaining symlinks (-L). cp -RL preserves directory structure +
#    follows symlinks.
mkdir -p "$OUT"
cp -RL "$tmp/node_modules/." "$OUT/"

# 4. Verification: assert the platform-specific native binaries exist
#    at the expected paths. If they don't, FAIL THE BUILD -- a
#    missing-binary error never reaches end users this way.
echo "[stage-runtime-deps] verifying native binaries for $PLATFORM..."

# onnxruntime-node uses napi-v3 in 1.21.x (our pinned version per
# decisions-log 2026-04-25 entry). 1.22+ moved to napi-v6 -- bump this
# constant if/when we move to a 4.x transformers + 1.24+ ORT-node pair.
ort_napi_dir="napi-v3"
case "$PLATFORM" in
  darwin-arm64) ort_os=darwin; ort_arch=arm64;  ort_ext=node ;;
  darwin-x64)   ort_os=darwin; ort_arch=x64;    ort_ext=node ;;
  linux-x64)    ort_os=linux;  ort_arch=x64;    ort_ext=node ;;
  windows-x64)  ort_os=win32;  ort_arch=x64;    ort_ext=node ;;
  *) echo "[stage-runtime-deps] Unsupported platform: $PLATFORM" >&2; exit 1 ;;
esac

ort_binding="$OUT/onnxruntime-node/bin/${ort_napi_dir}/${ort_os}/${ort_arch}/onnxruntime_binding.${ort_ext}"
if [[ ! -f "$ort_binding" ]]; then
  echo "[stage-runtime-deps] FAIL: missing $ort_binding" >&2
  echo "                      onnxruntime-node didn't ship a binary for this arch in the version" >&2
  echo "                      that staged. Listing what IS in onnxruntime-node/bin/:" >&2
  find "$OUT/onnxruntime-node/bin" -maxdepth 4 -type d 2>/dev/null | sed 's/^/                        /' >&2 || true
  exit 1
fi
echo "[stage-runtime-deps] ✓ onnxruntime-node binding: $ort_binding"

# sharp uses npm's optional-platform-packages pattern. Each
# @img/sharp-<platform> sub-package contains lib/sharp-<platform>.node.
# The presence of the right sub-package + libvips bundle is the check.
case "$PLATFORM" in
  darwin-arm64) sharp_pkg="@img/sharp-darwin-arm64"; libvips_pkg="@img/sharp-libvips-darwin-arm64" ;;
  darwin-x64)   sharp_pkg="@img/sharp-darwin-x64";   libvips_pkg="@img/sharp-libvips-darwin-x64" ;;
  linux-x64)    sharp_pkg="@img/sharp-linux-x64";    libvips_pkg="@img/sharp-libvips-linux-x64" ;;
  windows-x64)  sharp_pkg="@img/sharp-win32-x64";    libvips_pkg="@img/sharp-libvips-win32-x64" ;;
esac
if [[ ! -d "$OUT/$sharp_pkg" ]]; then
  echo "[stage-runtime-deps] FAIL: missing $OUT/$sharp_pkg" >&2
  echo "                      sharp's optional platform package didn't install." >&2
  exit 1
fi
echo "[stage-runtime-deps] ✓ sharp platform package: $sharp_pkg"
if [[ ! -d "$OUT/$libvips_pkg" ]]; then
  # Not always fatal — older sharp versions inlined libvips. But warn so
  # we notice if a future bump flips behaviour.
  echo "[stage-runtime-deps] WARN: $libvips_pkg is missing. May be fine for older sharp; verify in the smoke test."
else
  echo "[stage-runtime-deps] ✓ sharp libvips bundle: $libvips_pkg"
fi

# Pure-JS package: just the directory has to exist + have a package.json.
if [[ ! -f "$OUT/@huggingface/transformers/package.json" ]]; then
  echo "[stage-runtime-deps] FAIL: missing $OUT/@huggingface/transformers/" >&2
  exit 1
fi
echo "[stage-runtime-deps] ✓ @huggingface/transformers"

echo "[stage-runtime-deps] all native deps verified for $PLATFORM"
