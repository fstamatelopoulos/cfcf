#!/usr/bin/env bash
#
# Build the publishable @cerefox/cfcf-cli npm tarball.
#
# Per docs/research/installer-design.md §3.1 + §3.3. Output: a single
# npm-format tarball (`cfcf-X.Y.Z.tgz`) ready for `bun install -g`.
#
# Strategy:
#   1. Bundle packages/cli/src/index.ts via `bun build` (no --compile;
#      the previous self-contained-binary attempt is documented in the
#      decisions log under 2026-04-26).
#   2. Externalise the heavy native-bearing deps (@huggingface/transformers
#      and its transitive onnxruntime-node + sharp). The user's runtime
#      resolves them via the standard npm resolver after install. This is
#      the same pattern Vercel CLI, Yarn, etc. use.
#   3. Stage a publish-shaped package directory (package.json renamed to
#      @cerefox/cfcf-cli, tiny bin/cfcf.js entry, dist/cfcf.js bundle,
#      README.md). Run `bun pm pack` to produce the tarball.
#
# Usage:  build-cli.sh <version>
#         e.g. build-cli.sh v0.10.0  →  dist/cfcf-0.10.0.tgz
#
# The version argument may include the leading 'v'; we strip it when
# stamping into package.json (npm versions are unprefixed).

set -euo pipefail

VERSION_INPUT="${1:?version argument required (e.g. v0.10.0)}"
VERSION="${VERSION_INPUT#v}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/dist}"

# The runtime deps that transformers+ORT need installed on the user's
# machine. Pinned to the exact versions verified to work together
# (decision in docs/decisions-log.md 2026-02-13).
TRANSFORMERS_VERSION="3.8.1"
COMMANDER_VERSION="^13.1.0"
HONO_VERSION="^4.7.0"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/bin" "$stage/dist"

echo "[build-cli] target version: $VERSION"
echo "[build-cli] stage:          $stage"
echo "[build-cli] output:         $OUT_DIR/cfcf-$VERSION.tgz"
echo

# ── 1. embed web/dist + help docs into core (bundle picks them up) ────
cd "$REPO_ROOT"
echo "[build-cli] 1/4  build web + embed help-content + bundle"
bun run build:web
# Generate the help-content module (docs/guides/*.md → packages/core/src/
# help-content.generated.ts) so the user manual / focused guides ship
# inside the bundle. `cfcf help <topic>` and the web UI Help tab read
# from the generated module; same shape as web-assets.generated.ts.
bun run scripts/embed-help-content.ts

# ── 2. bun build the CLI ──────────────────────────────────────────────
# --target=bun produces output that uses Bun-specific globals (Bun.spawn,
#   bun:sqlite, etc.) — fine because cfcf requires Bun at runtime.
# --external for the heavy native deps; the user's npm-resolver fetches
#   them after install.
echo "[build-cli] 2/4  bun build (no --compile)"
bun build packages/cli/src/index.ts \
  --target=bun \
  --external @huggingface/transformers \
  --external onnxruntime-node \
  --external sharp \
  --outfile "$stage/dist/cfcf.js"

# ── 3. stage the publish-shaped package ───────────────────────────────
echo "[build-cli] 3/4  stage publish-shaped package"

# Tiny shebang stub. bun install -g generates a wrapper that points at
# this file, so it has to be self-contained — just import the bundle.
cat > "$stage/bin/cfcf.js" <<'EOF'
#!/usr/bin/env bun
// @cerefox/cfcf-cli entry stub. The real CLI lives in ../dist/cfcf.js
// (a pre-bundled single file produced by `bun build` at release time).
import "../dist/cfcf.js";
EOF
chmod +x "$stage/bin/cfcf.js"

# Generate the publishable package.json. Distinct from the workspace
# package.json (which is named @cfcf/cli and isn't publishable). Heavy
# native deps go in optionalDependencies for the per-platform native
# package; transformers + commander + hono are required runtime deps.
cat > "$stage/package.json" <<EOF
{
  "name": "@cerefox/cfcf-cli",
  "version": "$VERSION",
  "description": "Cerefox Code Factory (cf²) -- deterministic orchestration harness for AI coding agents",
  "type": "module",
  "bin": {
    "cfcf": "./bin/cfcf.js"
  },
  "scripts": {
    "postinstall": "bun ./bin/cfcf.js completion install || true"
  },
  "files": [
    "bin",
    "dist",
    "README.md"
  ],
  "engines": {
    "bun": ">=1.3.0"
  },
  "dependencies": {
    "@huggingface/transformers": "$TRANSFORMERS_VERSION",
    "commander": "$COMMANDER_VERSION",
    "hono": "$HONO_VERSION"
  },
  "optionalDependencies": {
    "@cerefox/cfcf-native-darwin-arm64": "$VERSION",
    "@cerefox/cfcf-native-darwin-x64":   "$VERSION",
    "@cerefox/cfcf-native-linux-x64":    "$VERSION"
  },
  "trustedDependencies": [
    "onnxruntime-node",
    "sharp"
  ],
  "license": "UNLICENSED",
  "homepage": "https://github.com/fstamatelopoulos/cfcf"
}
EOF

# Short README that points users at the install + docs entry points.
# Kept minimal so the tarball stays small.
cat > "$stage/README.md" <<EOF
# cfcf — Cerefox Code Factory (cf²)

Deterministic orchestration harness for AI coding agents.

## Install

\`\`\`bash
bun install -g @cerefox/cfcf-cli
\`\`\`

Requires Bun ≥ 1.3. See https://bun.sh/install.

## Getting started

\`\`\`bash
cfcf init       # interactive first-run setup
cfcf doctor     # verify install
cfcf --help     # command reference
\`\`\`

Full documentation: https://github.com/fstamatelopoulos/cfcf
EOF

# ── 4. pack ───────────────────────────────────────────────────────────
echo "[build-cli] 4/4  bun pm pack"
mkdir -p "$OUT_DIR"
(
  cd "$stage"
  # `bun pm pack` writes the tarball to the current dir; we move it into
  # OUT_DIR. The default name is "<scope>-<name>-<version>.tgz" --
  # @cerefox-cfcf-cli-X.Y.Z.tgz here. We rename it to match the simpler
  # cfcf-X.Y.Z.tgz convention release.yml uses.
  bun pm pack >/dev/null
  src_tgz="$(ls -t cerefox-cfcf-cli-*.tgz 2>/dev/null | head -1)"
  if [[ -z "$src_tgz" ]]; then
    src_tgz="$(ls -t @cerefox-cfcf-cli-*.tgz 2>/dev/null | head -1)"
  fi
  if [[ -z "$src_tgz" ]]; then
    src_tgz="$(ls -t *.tgz | head -1)"
  fi
  cp "$src_tgz" "$OUT_DIR/cfcf-$VERSION.tgz"
)

# sha256 in the standard `<sha>  <filename>` format.
(
  cd "$OUT_DIR"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "cfcf-$VERSION.tgz" > "cfcf-$VERSION.tgz.sha256"
  else
    shasum -a 256 "cfcf-$VERSION.tgz" > "cfcf-$VERSION.tgz.sha256"
  fi
)

bytes="$(wc -c < "$OUT_DIR/cfcf-$VERSION.tgz" | tr -d ' ')"
human="$(echo "$bytes" | awk '{
  if ($1 > 1073741824) printf "%.1f GB", $1/1073741824
  else if ($1 > 1048576) printf "%.1f MB", $1/1048576
  else if ($1 > 1024) printf "%.1f KB", $1/1024
  else print $1 " bytes"
}')"
echo
echo "[build-cli] ✓ $OUT_DIR/cfcf-$VERSION.tgz  ($human)"
echo "[build-cli] ✓ $OUT_DIR/cfcf-$VERSION.tgz.sha256"
