#!/usr/bin/env bash
#
# cfcf curl-bash installer.
#
# Canonical one-liner:
#   curl -fsSL https://github.com/fstamatelopoulos/cfcf/releases/latest/download/install.sh | bash
#
# Designed to "just work" on a stock fresh Mac/Linux — bootstraps the
# whole toolchain (Bun + npm + npm-prefix-fix-if-needed) and then
# installs cfcf via npm, hands off to `cfcf init`. No sudo. No silent
# trust grants. Verbose enough that the user can audit every step.
#
# Why bun + npm + cfcf?
#   Bun is cfcf's RUNTIME (bun:sqlite, Bun.spawn, Bun.serve, Bun.file
#   are used directly throughout the codebase — required at runtime).
#   npm is cfcf's INSTALL TOOL (avoids Bun's postinstall blocking
#   issue oven-sh/bun#4959, which would break onnxruntime-node +
#   protobufjs at install time without a `bun pm trust` workaround).
#   Two tools, clean separation of concerns.
#
# Two install paths share this script:
#   • npm mode (default):
#       npm install -g @cerefox/codefactory[@version]
#   • tarball mode (offline / airgapped / pinned-mirror):
#       npm install -g <native-tarball>
#       npm install -g <cli-tarball>
#     Auto-engages when CFCF_BASE_URL is set; force with
#     CFCF_INSTALL_SOURCE=tarball.
#
# Once npm is published, users with their own npm setup (homebrew Node,
# nvm/fnm/asdf, etc.) can also just run `npm install -g
# @cerefox/codefactory` directly without this wrapper. The wrapper
# exists for the Bun + npm + prefix-fix bootstrap path.
#
# Env vars (all optional):
#   CFCF_INSTALL_SOURCE  "npm" or "tarball" (auto: tarball if
#                        CFCF_BASE_URL is set, else npm)
#   CFCF_VERSION         tag to install ("latest" or e.g. "v0.16.4")
#   CFCF_BASE_URL        where to fetch tarballs from (http/https/file://);
#                        only used in tarball mode
#   CFCF_RELEASES_REPO   override github.com/<owner>/<repo> for the
#                        default tarball URL builder
#                        (default: fstamatelopoulos/cfcf)
#   CFCF_SKIP_INIT       skip the press-Enter handoff to cfcf init
#                        (useful for non-interactive runs / CI)
#
# All shell-rc edits go inside sentinel-marked blocks
# (`# >>> cfcf installer (npm-global path) >>>` ... `<<<`) so they can
# be cleanly removed by the user later if they switch their npm setup.

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────
: "${CFCF_VERSION:=latest}"
: "${CFCF_RELEASES_REPO:=fstamatelopoulos/cfcf}"

# Auto-detect tarball mode when CFCF_BASE_URL is set: the only reason
# to pass that env var is to point us at a tarball mirror.
if [[ -z "${CFCF_INSTALL_SOURCE:-}" ]]; then
  if [[ -n "${CFCF_BASE_URL:-}" ]]; then
    CFCF_INSTALL_SOURCE="tarball"
  else
    CFCF_INSTALL_SOURCE="npm"
  fi
fi
case "$CFCF_INSTALL_SOURCE" in
  npm|tarball) ;;
  *)
    echo "[cfcf] Unknown CFCF_INSTALL_SOURCE: '$CFCF_INSTALL_SOURCE' (expected 'npm' or 'tarball')." >&2
    exit 1 ;;
esac

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  cfcf — Cerefox Code Factory installer"
echo "═══════════════════════════════════════════════════════════════"
echo "  install source : $CFCF_INSTALL_SOURCE"
echo "  version        : $CFCF_VERSION"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ── Helper: append a sentinel-marked block to a shell rc file ─────────
# Idempotent (skips if the sentinel is already present). Bash 3.x-
# compatible (macOS Catalina+ still ships bash 3.2). The user can
# remove the block cleanly by deleting the lines between `>>>` and `<<<`.
add_to_rc_idempotent() {
  local rc="$1"
  local label="$2"
  local content="$3"
  [[ -f "$rc" ]] || return 0
  if grep -qF "# >>> cfcf installer ($label) >>>" "$rc"; then
    return 0
  fi
  {
    echo ""
    echo "# >>> cfcf installer ($label) >>>"
    echo "# Added by cfcf installer (https://github.com/fstamatelopoulos/cfcf)."
    echo "# Removable: delete the block between '>>>' and '<<<'."
    echo "$content"
    echo "# <<< cfcf installer ($label) <<<"
  } >> "$rc"
  echo "[cfcf]   added '$label' block to $rc"
}

# ── 1/5. Ensure Bun is on PATH (cfcf RUNTIME requirement) ─────────────
echo "[cfcf] step 1/5: ensure Bun ≥ 1.3 is installed"
if command -v bun >/dev/null 2>&1; then
  echo "[cfcf]   Bun found: v$(bun --version)"
else
  echo "[cfcf]   Bun not found; installing via Bun's official installer..."
  curl -fsSL https://bun.sh/install | bash
  # Bun's installer adds ~/.bun/bin to ~/.zshrc/.bashrc itself; we still
  # update PATH for THIS shell session so the next steps see bun.
  export PATH="$HOME/.bun/bin:$PATH"
  if ! command -v bun >/dev/null 2>&1; then
    echo "[cfcf] Bun install failed -- ensure ~/.bun/bin is on PATH and re-run." >&2
    echo "[cfcf] Manual install: https://bun.sh/" >&2
    exit 1
  fi
  echo "[cfcf]   Bun installed: v$(bun --version)"
fi

# ── 2/5. Ensure npm is on PATH (cfcf INSTALL TOOL) ────────────────────
# We use npm to install cfcf (not bun) because Bun blocks postinstall
# scripts by default (oven-sh/bun#4959). cfcf depends on
# onnxruntime-node + protobufjs whose postinstalls download platform-
# specific .node binaries and run codegen; if those don't run, Clio's
# embedder breaks at runtime. npm runs postinstalls by default, so this
# is the smooth path. Bun stays the runtime; npm is just the install tool.
echo ""
echo "[cfcf] step 2/5: ensure npm is installed"
if command -v npm >/dev/null 2>&1; then
  echo "[cfcf]   npm found: v$(npm --version)"
else
  echo "[cfcf]   npm not found; bootstrapping via 'bun install -g npm'..."
  bun install -g npm
  # bun-installed npm lives at ~/.bun/bin/npm — already on PATH from step 1.
  if ! command -v npm >/dev/null 2>&1; then
    echo "[cfcf] npm install via bun failed -- you may need to install Node.js manually." >&2
    echo "[cfcf] Try one of:" >&2
    echo "[cfcf]   • brew install node    (macOS, homebrew users)" >&2
    echo "[cfcf]   • nvm install --lts    (with nvm)" >&2
    echo "[cfcf]   • download from https://nodejs.org/" >&2
    exit 1
  fi
  echo "[cfcf]   npm installed: v$(npm --version)"
fi

# ── 3/5. Ensure npm has a user-writable global prefix ─────────────────
# Stock Node installations (the official .pkg installer on macOS;
# system packages on Linux) point npm's global prefix at /usr/local/
# or /usr/lib/, which is root-owned. `npm install -g` then fails with
# EACCES unless run as root. The npm-documented fix is to redirect the
# prefix to a user-writable directory; ~/.npm-global is the convention.
# Reference:
#   https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally
#
# This fires:
#   • macOS w/ official-installer Node (most common: stock fresh Mac)
#   • Linux w/ apt/dnf/yum-installed Node
#
# This SKIPS:
#   • macOS w/ homebrew Node (homebrew makes /usr/local/ user-writable
#     on Intel; uses /opt/homebrew/ on Apple Silicon, also user-writable)
#   • macOS where the user manually chowned /usr/local/bin (Intel-Mac
#     "I did this once and forgot" case)
#   • nvm / fnm / asdf / volta installs (each tool uses its own
#     user-writable prefix)
#   • Linux w/ user-installed Node
#
# We don't touch the user's existing setup if it's already working.
echo ""
echo "[cfcf] step 3/5: verify npm prefix is user-writable"
npm_prefix="$(npm config get prefix 2>/dev/null || echo "")"
prefix_writable=0
if [[ -n "$npm_prefix" ]] && [[ -w "$npm_prefix" ]]; then
  if [[ -w "$npm_prefix/bin" ]] || [[ ! -e "$npm_prefix/bin" ]]; then
    prefix_writable=1
  fi
fi

if (( prefix_writable )); then
  echo "[cfcf]   npm prefix '$npm_prefix' is user-writable -- skipping prefix fix"
else
  echo "[cfcf]   npm prefix '$npm_prefix' is not writable by your user."
  echo "[cfcf]   Configuring '~/.npm-global' as a user-writable prefix"
  echo "[cfcf]   (npm's documented fix for EACCES errors:"
  echo "[cfcf]    https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally)"
  mkdir -p "$HOME/.npm-global"
  npm config set prefix "$HOME/.npm-global"
  export PATH="$HOME/.npm-global/bin:$PATH"
  add_to_rc_idempotent "$HOME/.zshrc"  "npm-global path" 'export PATH="$HOME/.npm-global/bin:$PATH"'
  add_to_rc_idempotent "$HOME/.bashrc" "npm-global path" 'export PATH="$HOME/.npm-global/bin:$PATH"'
  echo "[cfcf]   prefix set: $(npm config get prefix)"
fi

# ── 4/5. Install cfcf ─────────────────────────────────────────────────
echo ""
echo "[cfcf] step 4/5: install cfcf"

if [[ "$CFCF_INSTALL_SOURCE" == "npm" ]]; then
  if [[ "$CFCF_VERSION" == "latest" ]]; then
    pkg_spec="@cerefox/codefactory@latest"
  else
    v_no_prefix="${CFCF_VERSION#v}"
    pkg_spec="@cerefox/codefactory@${v_no_prefix}"
  fi
  echo "[cfcf]   npm install -g $pkg_spec"
  npm install -g "$pkg_spec"
  installed_version="$CFCF_VERSION"
else
  # ── tarball mode ──
  # Resolve base URL: explicit CFCF_BASE_URL > GitHub Release URL
  # built from CFCF_RELEASES_REPO + CFCF_VERSION.
  if [[ -z "${CFCF_BASE_URL:-}" ]]; then
    if [[ "$CFCF_VERSION" == "latest" ]]; then
      CFCF_BASE_URL="https://github.com/${CFCF_RELEASES_REPO}/releases/latest/download"
    else
      CFCF_BASE_URL="https://github.com/${CFCF_RELEASES_REPO}/releases/download/${CFCF_VERSION}"
    fi
  fi
  echo "[cfcf]   tarball base URL: $CFCF_BASE_URL"

  # Detect platform for native tarball name
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os-$arch" in
    darwin-arm64)  platform=darwin-arm64 ;;
    darwin-x86_64) platform=darwin-x64 ;;
    linux-x86_64)  platform=linux-x64 ;;
    *)
      echo "[cfcf] Unsupported platform: $os-$arch" >&2
      echo "[cfcf] Supported: darwin-arm64, darwin-x64, linux-x64." >&2
      exit 1 ;;
  esac

  # Resolve "latest" via GitHub's redirect convention
  if [[ "$CFCF_VERSION" == "latest" ]]; then
    case "$CFCF_BASE_URL" in
      file://*)
        echo "[cfcf] CFCF_VERSION=latest is not supported with file:// URLs." >&2
        echo "[cfcf] Set CFCF_VERSION explicitly, e.g. CFCF_VERSION=v0.16.4." >&2
        exit 1 ;;
    esac
    echo "[cfcf]   resolving latest version..."
    resolved="$(curl -fsSL -o /dev/null -w '%{url_effective}' "$CFCF_BASE_URL/MANIFEST.txt" || true)"
    version="$(echo "$resolved" | sed -nE 's|.*/releases/download/([^/]+)/.*|\1|p')"
    if [[ -z "$version" ]]; then
      echo "[cfcf] Could not resolve latest version. Set CFCF_VERSION=<tag> explicitly." >&2
      exit 1
    fi
    echo "[cfcf]   latest = $version"
  else
    version="$CFCF_VERSION"
  fi

  v_no_prefix="${version#v}"
  cli_url="$CFCF_BASE_URL/cfcf-${v_no_prefix}.tgz"
  native_url="$CFCF_BASE_URL/cerefox-codefactory-native-${platform}-${v_no_prefix}.tgz"

  # Native first, CLI second: the CLI's optionalDependencies entry will
  # try to resolve the native package by name from npm; pre-installing
  # by URL satisfies the runtime require regardless of npm visibility.
  echo "[cfcf]   npm install -g $native_url"
  npm install -g "$native_url"
  echo "[cfcf]   npm install -g $cli_url"
  npm install -g "$cli_url"
  installed_version="$version"
fi

# ── 5/5. Verify install + handoff ─────────────────────────────────────
echo ""
echo "[cfcf] step 5/5: verify + first-run setup"

if ! command -v cfcf >/dev/null 2>&1; then
  echo ""
  echo "[cfcf] cfcf was installed but is not on your PATH."
  echo "[cfcf] This usually means npm's prefix bin/ directory isn't on PATH."
  echo "[cfcf] Add this line to your ~/.zshrc or ~/.bashrc:"
  echo "[cfcf]   export PATH=\"$(npm config get prefix)/bin:\$PATH\""
  echo "[cfcf] Then open a new terminal and run: cfcf doctor"
  exit 0
fi

actual_version="$(cfcf --version 2>/dev/null | tr -d '\r' | tr -d '\n' || true)"
if [[ -n "$actual_version" ]]; then
  echo "[cfcf]   cfcf v$actual_version installed (requested: $installed_version)"
else
  echo "[cfcf]   cfcf $installed_version installed"
fi

# Run doctor for a quick health check (informative; non-blocking).
# This also surfaces the "Next steps" banner (printed by cfcf
# completion install during the npm postinstall hook).
echo ""
echo "[cfcf] running cfcf doctor for a quick health check..."
echo ""
cfcf doctor || echo "[cfcf] (cfcf doctor reported issues -- review above)"
echo ""

# Hand off to cfcf init (interactive). Skip in CI / non-interactive runs.
if [[ -z "${CFCF_SKIP_INIT:-}" ]] && [[ -t 0 || -e /dev/tty ]]; then
  echo "[cfcf] Press Enter to run 'cfcf init' now, or Ctrl-C to exit and run it later."
  read -r _ </dev/tty 2>/dev/null || true
  echo "[cfcf] Launching cfcf init..."
  exec cfcf init
else
  echo "[cfcf] Next steps:"
  echo "[cfcf]   cfcf init     (interactive first-run setup)"
  echo "[cfcf]   cfcf doctor   (rerun if anything was off above)"
  echo "[cfcf]   cfcf --help   (full command reference)"
fi
