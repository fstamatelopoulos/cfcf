#!/usr/bin/env bash
#
# Print the cfcf platform tag for the current machine, e.g. "darwin-arm64".
# Used by every other build script to map onto release-asset names.
#
# Supported tags: darwin-arm64, darwin-x64, linux-x64, windows-x64.
# Exits non-zero on unsupported platforms (e.g. linux-arm64, freebsd, alpine
# musl) so a release run fails loudly instead of silently producing a
# mis-tagged tarball.
#
# Allow the caller to override via PLATFORM env var. The release workflow
# uses this to drive cross-platform smoke tests from Linux runners.

set -euo pipefail

if [[ -n "${PLATFORM:-}" ]]; then
  echo "$PLATFORM"
  exit 0
fi

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"

case "$os-$arch" in
  darwin-arm64)         echo "darwin-arm64" ;;
  darwin-x86_64)        echo "darwin-x64" ;;
  linux-x86_64)         echo "linux-x64" ;;
  mingw*|msys*|cygwin*) echo "windows-x64" ;;
  *)
    echo "Unsupported platform: $os-$arch" >&2
    echo "Supported: darwin-arm64, darwin-x64, linux-x64, windows-x64." >&2
    exit 1 ;;
esac
