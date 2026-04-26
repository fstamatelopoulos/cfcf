#!/usr/bin/env bash
#
# Smoke-test a freshly-built cfcf-X.Y.Z.tgz by installing it into an
# isolated Bun global prefix and exercising the CLI surface a fresh user
# would hit. Fails the run if anything's broken so a malformed tarball
# never reaches users.
#
# Usage:  smoke-tarball.sh <cfcf-tarball> [native-tarball]
#         e.g. smoke-tarball.sh dist/cfcf-0.10.0.tgz \
#                              dist/cerefox-cfcf-native-darwin-arm64-0.10.0.tgz
#
# Per docs/research/installer-design.md §5. The install bun does here
# fetches transformers + ORT + sharp from npmjs.com, so this test
# requires network. The native-tarball arg is optional -- if omitted,
# the user's already-installed @cerefox/cfcf-native-<platform> (if any)
# is used; if neither is present, sqlite-vec checks degrade to warnings.

set -euo pipefail

CLI_TGZ="${1:?cfcf cli tarball required}"
NATIVE_TGZ="${2:-}"

if [[ ! -f "$CLI_TGZ" ]]; then
  echo "[smoke] FAIL: cli tarball not found: $CLI_TGZ" >&2
  exit 1
fi
CLI_TGZ="$(cd "$(dirname "$CLI_TGZ")" && pwd)/$(basename "$CLI_TGZ")"
if [[ -n "$NATIVE_TGZ" ]]; then
  if [[ ! -f "$NATIVE_TGZ" ]]; then
    echo "[smoke] FAIL: native tarball not found: $NATIVE_TGZ" >&2
    exit 1
  fi
  NATIVE_TGZ="$(cd "$(dirname "$NATIVE_TGZ")" && pwd)/$(basename "$NATIVE_TGZ")"
fi

# Isolate the install: separate Bun global-install prefix so we don't
# collide with the developer's real global cfcf install.
sandbox="$(mktemp -d)"
trap 'rm -rf "$sandbox"' EXIT
export BUN_INSTALL="$sandbox/bun"
export PATH="$BUN_INSTALL/bin:$PATH"
mkdir -p "$BUN_INSTALL/bin"

echo "[smoke] sandbox: $sandbox"
echo "[smoke] BUN_INSTALL=$BUN_INSTALL"

# 1. Install the native package first if provided. cfcf's package.json
#    declares it as an optionalDependency, so we want it resolvable on
#    its own, not just transitively.
if [[ -n "$NATIVE_TGZ" ]]; then
  echo "[smoke] 1/4  bun install -g $NATIVE_TGZ"
  bun install -g "$NATIVE_TGZ"
fi

# 2. Install the cfcf CLI tarball.
echo "[smoke] 2/4  bun install -g $CLI_TGZ"
bun install -g "$CLI_TGZ"

# 3. cfcf --version: smoke that the CLI loads + commander parses.
echo "[smoke] 3/4  cfcf --version"
cfcf --version

# 4. cfcf doctor: end-to-end check of the install. doctor prints native
#    package presence + libsqlite3 + sqlite-vec + runtime deps + agent
#    CLIs. Treat any FAIL as a smoke failure; warnings are OK.
echo "[smoke] 4/4  cfcf doctor"
if ! cfcf doctor; then
  echo "[smoke] FAIL: cfcf doctor reported failures (see output above)" >&2
  exit 1
fi

echo
echo "[smoke] all checks passed."
