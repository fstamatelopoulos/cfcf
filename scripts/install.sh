#!/usr/bin/env bash
#
# cfcf curl-bash installer.
#
# Per docs/research/installer-design.md §4. Thin wrapper that:
#   1. Ensures Bun ≥ 1.3 is on PATH (installs it via Bun's official
#      installer if missing).
#   2. Resolves the cfcf tarball URL (from CFCF_BASE_URL + CFCF_VERSION).
#   3. Runs `bun install -g <tarball-URL>`. Bun's package manager handles
#      the rest -- including the postinstall step for the per-platform
#      @cerefox/cfcf-native-<platform> package.
#   4. Hands off to `cfcf init` (interactive) unless CFCF_SKIP_INIT is set.
#
# Phase 1 (cfcf private):  curl -fsSL <url>/install.sh | bash
# Phase 2 (cfcf public):   bun install -g @cerefox/cfcf-cli  -- direct,
#                          this script becomes optional.
#
# Env vars (all optional):
#   CFCF_BASE_URL     where to fetch tarballs from (http/https/file://)
#   CFCF_VERSION      tag to install ("latest" or e.g. "v0.10.0")
#   CFCF_SKIP_INIT    skip the press-Enter handoff to cfcf init at the end

set -euo pipefail

: "${CFCF_VERSION:=latest}"
: "${CFCF_RELEASES_REPO:=fstamatelopoulos/cfcf-releases}"
if [[ -z "${CFCF_BASE_URL:-}" ]]; then
  if [[ "$CFCF_VERSION" == "latest" ]]; then
    CFCF_BASE_URL="https://github.com/${CFCF_RELEASES_REPO}/releases/latest/download"
  else
    CFCF_BASE_URL="https://github.com/${CFCF_RELEASES_REPO}/releases/download/${CFCF_VERSION}"
  fi
fi

# ── 1. Ensure Bun is on PATH ──────────────────────────────────────────
if ! command -v bun >/dev/null 2>&1; then
  echo "[cfcf] Bun not found. Installing via Bun's official installer..."
  curl -fsSL https://bun.sh/install | bash
  # Update PATH so the next line finds bun in this shell.
  export PATH="$HOME/.bun/bin:$PATH"
  if ! command -v bun >/dev/null 2>&1; then
    echo "[cfcf] Bun install failed -- ensure ~/.bun/bin is on PATH and re-run." >&2
    exit 1
  fi
fi

bun_version="$(bun --version)"
echo "[cfcf] Using Bun $bun_version"

# ── 2. Resolve tarball URL ────────────────────────────────────────────
# For "latest", we follow GitHub's redirect convention. file:// users
# must set CFCF_VERSION explicitly (no "latest" symlink convention).
if [[ "$CFCF_VERSION" == "latest" ]]; then
  case "$CFCF_BASE_URL" in
    file://*)
      echo "[cfcf] CFCF_VERSION=latest is not supported with file:// URLs." >&2
      echo "[cfcf] Set CFCF_VERSION explicitly, e.g. CFCF_VERSION=v0.10.0." >&2
      exit 1 ;;
  esac
  echo "[cfcf] Resolving latest version..."
  resolved="$(curl -fsSL -o /dev/null -w '%{url_effective}' "$CFCF_BASE_URL/MANIFEST.txt" || true)"
  version="$(echo "$resolved" | sed -nE 's|.*/releases/download/([^/]+)/.*|\1|p')"
  if [[ -z "$version" ]]; then
    echo "[cfcf] Could not resolve latest version. Set CFCF_VERSION=<tag> explicitly." >&2
    exit 1
  fi
  echo "[cfcf] Latest = $version"
else
  version="$CFCF_VERSION"
fi

# Strip leading 'v' from the tag for the npm-style version inside the
# tarball name (build-cli.sh does the same).
v_no_prefix="${version#v}"
tarball_url="$CFCF_BASE_URL/cfcf-${v_no_prefix}.tgz"

# ── 3. Install ────────────────────────────────────────────────────────
echo "[cfcf] Installing cfcf $version from $tarball_url"
bun install -g "$tarball_url"

# Confirm cfcf is on PATH; if Bun's global bin isn't there, surface
# the standard hint.
if ! command -v cfcf >/dev/null 2>&1; then
  echo "[cfcf] cfcf installed but not on PATH."
  echo "[cfcf] Add Bun's global bin to your shell rc:"
  echo "         export PATH=\"$HOME/.bun/bin:\$PATH\""
  exit 0
fi

echo "[cfcf] cfcf $version installed."

# ── 4. Hand off to cfcf init (interactive) ────────────────────────────
if [[ -z "${CFCF_SKIP_INIT:-}" ]] && [[ -t 0 || -e /dev/tty ]]; then
  echo "[cfcf] Press Enter to run 'cfcf init' now, or Ctrl-C to exit and run it later."
  read -r _ </dev/tty 2>/dev/null || true
  echo "[cfcf] Launching cfcf init..."
  exec cfcf init
else
  echo "[cfcf] Next: cfcf init"
  echo "[cfcf]       cfcf doctor   (verify install)"
  echo "[cfcf]       cfcf --help   (command reference)"
fi
