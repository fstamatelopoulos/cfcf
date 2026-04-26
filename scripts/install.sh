#!/usr/bin/env bash
#
# cfcf installer.
#
# Hosting-agnostic by design: the install URL is configurable via
# CFCF_BASE_URL, supporting both:
#   - HTTP/HTTPS (production: GitHub Releases, public web mirror)
#   - file:// (Phase-0 dev testing, or any locally-shared tarball)
#
# Usage (in order of how interactive things get):
#   curl -fsSL https://<host>/install.sh | bash
#   curl -fsSL https://<host>/install.sh | CFCF_VERSION=v0.10.0 bash
#   CFCF_BASE_URL=http://localhost:8080 CFCF_VERSION=v0.0.0-dev \
#     curl -fsSL http://localhost:8080/install.sh | bash
#   CFCF_BASE_URL=file:///tmp/dist CFCF_VERSION=v0.0.0-dev bash install.sh
#
# Env vars (all optional unless noted):
#   CFCF_BASE_URL       Where to fetch tarballs + SHA256SUMS from. Supports
#                       https://, http://, file://. Default: the future
#                       public cfcf-releases repo's GH Release URL.
#   CFCF_VERSION        Tag to install ("latest" or e.g. "v0.10.0"). Default
#                       "latest" — only meaningful for the GitHub Releases
#                       URL pattern (file:// requires an explicit version).
#   CFCF_INSTALL_DIR    Where cfcf lives on disk (default: ~/.cfcf).
#   CFCF_SYMLINK_DIR    Where to drop the symlink (default: /usr/local/bin).
#   CFCF_NO_SYMLINK     If set, skip the symlink + print PATH instructions.
#   CFCF_SKIP_INIT      If set, skip the press-Enter handoff to `cfcf init`
#                       at the end. Power-user / scripted-install path.
#   CFCF_NO_CHECKSUM    DEBUG ONLY. Skip the sha256 verification. Useful
#                       during Phase-0 dev when the local tarball is being
#                       rebuilt repeatedly. Never set this for real installs.

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────
: "${CFCF_VERSION:=latest}"
: "${CFCF_INSTALL_DIR:=$HOME/.cfcf}"
: "${CFCF_SYMLINK_DIR:=/usr/local/bin}"
# Default base URL is the future cfcf-releases GH repo. Easy to flip
# once we land on a final hosting choice. Users can always override.
: "${CFCF_RELEASES_REPO:=fstamatelopoulos/cfcf-releases}"
if [[ -z "${CFCF_BASE_URL:-}" ]]; then
  if [[ "$CFCF_VERSION" == "latest" ]]; then
    CFCF_BASE_URL="https://github.com/${CFCF_RELEASES_REPO}/releases/latest/download"
  else
    CFCF_BASE_URL="https://github.com/${CFCF_RELEASES_REPO}/releases/download/${CFCF_VERSION}"
  fi
fi

# ── Platform detection ────────────────────────────────────────────────
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$os-$arch" in
  darwin-arm64)  platform=darwin-arm64 ;;
  darwin-x86_64) platform=darwin-x64 ;;
  linux-x86_64)  platform=linux-x64 ;;
  mingw*|msys*|cygwin*)
    echo "[cfcf] Windows detected. Use install.ps1 instead, or run this from WSL." >&2
    exit 1 ;;
  *)
    echo "[cfcf] Unsupported platform: $os-$arch" >&2
    echo "[cfcf] Supported: darwin-arm64, darwin-x64, linux-x64. Windows support pending." >&2
    exit 1 ;;
esac

# ── Helpers: HTTP and file:// alike ───────────────────────────────────
# fetch <url> <out-path>: copy bytes from a URL to a local path. Supports
# http(s)://, file://, and (implicitly) absolute file paths via file://.
fetch() {
  local url="$1" out="$2"
  case "$url" in
    file://*)
      cp "${url#file://}" "$out" ;;
    http://*|https://*)
      curl -fsSL "$url" -o "$out" ;;
    *)
      echo "[cfcf] unsupported URL scheme: $url" >&2
      exit 1 ;;
  esac
}

# ── Resolve the version when CFCF_VERSION=latest ─────────────────────
# For the GitHub Releases /latest/download URL pattern, the version
# comes embedded in the redirect target. We probe MANIFEST.txt first
# to get the resolved version. file:// users must set CFCF_VERSION
# explicitly because there's no "latest" symlink convention there.
if [[ "$CFCF_VERSION" == "latest" ]]; then
  case "$CFCF_BASE_URL" in
    file://*)
      echo "[cfcf] CFCF_VERSION=latest is not supported with file:// URLs." >&2
      echo "[cfcf] Set CFCF_VERSION explicitly, e.g. CFCF_VERSION=v0.10.0." >&2
      exit 1 ;;
    *)
      echo "[cfcf] resolving latest version..."
      resolved="$(curl -fsSL -o /dev/null -w '%{url_effective}' "$CFCF_BASE_URL/MANIFEST.txt" || true)"
      version="$(echo "$resolved" | sed -nE 's|.*/releases/download/([^/]+)/.*|\1|p')"
      if [[ -z "$version" ]]; then
        echo "[cfcf] could not resolve latest version. Set CFCF_VERSION=<tag> explicitly." >&2
        exit 1
      fi
      echo "[cfcf] latest = $version"
      ;;
  esac
else
  version="$CFCF_VERSION"
fi

tarball="cfcf-${platform}-${version}.tar.gz"

# ── Server-running guard (per design doc §1.3) ───────────────────────
if pgrep -f "cfcf server" >/dev/null 2>&1; then
  echo "[cfcf] cfcf server is currently running."
  echo "[cfcf] Stop it before continuing so init's config takes effect:"
  echo "         cfcf server stop"
  exit 1
fi

# ── Download + verify ────────────────────────────────────────────────
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "[cfcf] downloading $tarball"
echo "[cfcf]   from: $CFCF_BASE_URL"
fetch "$CFCF_BASE_URL/$tarball" "$tmp/$tarball"

if [[ -z "${CFCF_NO_CHECKSUM:-}" ]]; then
  echo "[cfcf] downloading SHA256SUMS"
  fetch "$CFCF_BASE_URL/SHA256SUMS" "$tmp/SHA256SUMS"
  echo "[cfcf] verifying checksum"
  # Extract just our tarball's line + verify from inside $tmp so the
  # filename is relative.
  if ! grep " $tarball\$" "$tmp/SHA256SUMS" > "$tmp/$tarball.sha256"; then
    echo "[cfcf] $tarball not in SHA256SUMS — refusing to install" >&2
    exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$tmp" && sha256sum -c "$tarball.sha256")
  else
    # macOS doesn't ship sha256sum; do the comparison manually.
    expected="$(awk '{print $1}' "$tmp/$tarball.sha256")"
    actual="$(shasum -a 256 "$tmp/$tarball" | awk '{print $1}')"
    if [[ "$expected" != "$actual" ]]; then
      echo "[cfcf] sha256 mismatch:" >&2
      echo "[cfcf]   expected: $expected" >&2
      echo "[cfcf]   actual:   $actual" >&2
      exit 1
    fi
    echo "$tarball: OK"
  fi
else
  echo "[cfcf] CFCF_NO_CHECKSUM set — skipping checksum verification (DEBUG ONLY)"
fi

# ── Unpack ────────────────────────────────────────────────────────────
echo "[cfcf] installing to $CFCF_INSTALL_DIR"
mkdir -p "$CFCF_INSTALL_DIR"
# --strip-components=1 drops the "cfcf-<platform>-<version>/" prefix
# directory the tarball is rooted at, leaving bin/ + native/ + MANIFEST
# at the install dir's top level.
tar xzf "$tmp/$tarball" -C "$CFCF_INSTALL_DIR" --strip-components=1

# ── macOS Gatekeeper bypass (per design doc §15) ─────────────────────
# Unsigned binaries downloaded from the web get a com.apple.quarantine
# extended attribute. Stripping it tells Gatekeeper "I trust this" so
# the user doesn't get the "can't be opened because it is from an
# unidentified developer" dialog. Apple Developer signing is the proper
# fix; deferred indefinitely.
if [[ "$platform" == darwin-* ]]; then
  if command -v xattr >/dev/null 2>&1; then
    xattr -d com.apple.quarantine "$CFCF_INSTALL_DIR/bin/cfcf" 2>/dev/null || true
    # Also strip from .node addons since they'd hit the same dialog.
    find "$CFCF_INSTALL_DIR" -name "*.node" -exec xattr -d com.apple.quarantine {} \; 2>/dev/null || true
    find "$CFCF_INSTALL_DIR" -name "*.dylib" -exec xattr -d com.apple.quarantine {} \; 2>/dev/null || true
  fi
fi

# ── Symlink / PATH ────────────────────────────────────────────────────
if [[ -z "${CFCF_NO_SYMLINK:-}" && -w "$CFCF_SYMLINK_DIR" ]]; then
  ln -sf "$CFCF_INSTALL_DIR/bin/cfcf" "$CFCF_SYMLINK_DIR/cfcf"
  echo "[cfcf] symlinked $CFCF_SYMLINK_DIR/cfcf"
else
  echo "[cfcf] did not create symlink ($CFCF_SYMLINK_DIR not writable)"
  echo "[cfcf] add this to your shell rc to use cfcf:"
  echo "         export PATH=\"$CFCF_INSTALL_DIR/bin:\$PATH\""
fi

# ── Smoke test ────────────────────────────────────────────────────────
echo "[cfcf] smoke test"
"$CFCF_INSTALL_DIR/bin/cfcf" --version

# ── Hand off to cfcf init (interactive, unless CFCF_SKIP_INIT) ───────
echo
echo "[cfcf] cfcf $version installed at $CFCF_INSTALL_DIR."
echo "[cfcf] Next: cfcf init walks you through agent + embedder + permissions."

if [[ -z "${CFCF_SKIP_INIT:-}" ]]; then
  echo "[cfcf] Press Enter to run 'cfcf init' now, or Ctrl-C to exit and run it later."
  # </dev/tty so the read sees the actual terminal even when stdin is
  # the curl pipe (rustup/nvm pattern).
  read -r _ </dev/tty 2>/dev/null || true
  echo "[cfcf] launching cfcf init..."
  exec "$CFCF_INSTALL_DIR/bin/cfcf" init
else
  cat <<EOF

[cfcf] CFCF_SKIP_INIT set; not launching cfcf init.
       When you're ready: cfcf init

       cfcf --help                for command reference
       $CFCF_INSTALL_DIR/uninstall.sh  to uninstall
EOF
fi
