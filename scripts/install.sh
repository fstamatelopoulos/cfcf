#!/usr/bin/env bash
#
# cfcf curl-bash installer.
#
# Canonical one-liner:
#   curl -fsSL https://github.com/fstamatelopoulos/cfcf/releases/latest/download/install.sh | bash
#
# Designed to "just work" on a stock fresh Mac/Linux. Bootstraps the
# whole toolchain (Bun + npm + npm-prefix-fix-if-needed), installs
# cfcf via npm, prints a clear "next steps" banner. No sudo. No
# package-trust prompts. Verbose enough that the user can audit
# every step.
#
# Why bun + npm + cfcf?
#   Bun is cfcf's RUNTIME (bun:sqlite, Bun.spawn, Bun.serve,
#   Bun.file used directly throughout the codebase -- required at
#   runtime). npm is cfcf's INSTALL TOOL: chosen over `bun install`
#   because Bun blocks postinstall scripts by default
#   (oven-sh/bun#4959), which would break onnxruntime-node +
#   protobufjs at install time without a manual `bun pm trust`
#   workaround. npm runs postinstalls by default; the install Just
#   Works.
#
# Two install paths share this script:
#
#   • registry mode (default):
#       npm install -g @cerefox/codefactory[@version]
#
#   • tarball mode (offline / airgapped / pinned-mirror):
#       npm install -g <native-tarball-URL>
#       npm install -g <cli-tarball-URL>
#     Auto-engages when CFCF_BASE_URL is set, or force with
#     CFCF_INSTALL_SOURCE=tarball.
#
# Once installed, users with their own setup (homebrew Node,
# nvm/fnm/asdf with a user-writable npm prefix) can also run
# `npm install -g @cerefox/codefactory` directly without this wrapper.
# The wrapper exists for the Bun + npm + prefix-fix bootstrap path.
#
# Env vars (all optional):
#   CFCF_INSTALL_SOURCE  "registry" or "tarball" (auto: tarball if
#                        CFCF_BASE_URL is set, else registry)
#   CFCF_VERSION         tag to install ("latest" or e.g. "v0.16.4")
#   CFCF_BASE_URL        where to fetch tarballs from (http/https/file://);
#                        only used in tarball mode
#   CFCF_RELEASES_REPO   override github.com/<owner>/<repo> for the
#                        default tarball URL builder
#                        (default: fstamatelopoulos/cfcf)
#
# All shell-rc edits go inside sentinel-marked blocks
# (`# >>> cfcf installer (npm-global path) >>>` ... `<<<`) so they can
# be cleanly removed by the user later.

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
    CFCF_INSTALL_SOURCE="registry"
  fi
fi
case "$CFCF_INSTALL_SOURCE" in
  registry|tarball) ;;
  npm)
    # Tolerated alias from older docs/scripts; treat as registry.
    CFCF_INSTALL_SOURCE="registry" ;;
  *)
    echo "[cfcf] Unknown CFCF_INSTALL_SOURCE: '$CFCF_INSTALL_SOURCE' (expected 'registry' or 'tarball')." >&2
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

# ── 1/4. Ensure Bun is on PATH (cfcf RUNTIME requirement) ─────────────
echo "[cfcf] step 1/4: ensure Bun ≥ 1.3 is installed"
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

# ── 2/4. Ensure npm is on PATH (cfcf INSTALL TOOL) ────────────────────
# We use npm to install cfcf (not bun) because Bun blocks postinstall
# scripts by default (oven-sh/bun#4959). cfcf depends on
# onnxruntime-node + protobufjs whose postinstalls download platform-
# specific .node binaries and run codegen; if those don't run, Clio's
# embedder breaks at runtime. npm runs postinstalls by default, so this
# is the smooth path. Bun stays the runtime; npm is just the install tool.
echo ""
echo "[cfcf] step 2/4: ensure npm is installed"
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

# ── 3/4. Ensure npm has a user-writable global prefix ─────────────────
# Stock Node installations (the official .pkg installer on macOS;
# system packages on Linux) point npm's global prefix at /usr/local/
# or /usr/lib/, which is root-owned. `npm install -g` then fails with
# EACCES unless run as root. The npm-documented fix is to redirect the
# prefix to a user-writable directory; ~/.npm-global is the convention.
# This is what nvm/fnm/asdf/volta all do automatically.
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
echo "[cfcf] step 3/4: install cfcf"

# Test if npm's existing prefix is usable for `npm install -g`:
# specifically, can we write into prefix/lib/node_modules + prefix/bin?
# Those are the only two directories npm actually touches for global
# installs. Some setups (including Intel Macs where the user manually
# chowned /usr/local/{bin,lib/node_modules}) have the prefix root as
# root-owned BUT the relevant subdirectories user-writable -- npm
# install -g works fine in that case. Earlier versions of this script
# tested `[[ -w "$npm_prefix" ]]` which incorrectly rejected the
# chowned-Intel-Mac case + reconfigured to ~/.npm-global unnecessarily.
npm_prefix="$(npm config get prefix 2>/dev/null || echo "")"
prefix_writable=0
prefix_was_modified=0
if [[ -n "$npm_prefix" ]]; then
  lib_dir="$npm_prefix/lib/node_modules"
  bin_dir="$npm_prefix/bin"
  # If a target dir doesn't exist yet, npm would create it during
  # install. We test whether its parent is writable (would-create-OK)
  # in addition to direct -w checks.
  lib_ok=0
  if [[ -w "$lib_dir" ]]; then
    lib_ok=1
  elif [[ ! -e "$lib_dir" ]] && [[ -w "$(dirname "$lib_dir")" ]] 2>/dev/null; then
    lib_ok=1
  fi
  bin_ok=0
  if [[ -w "$bin_dir" ]]; then
    bin_ok=1
  elif [[ ! -e "$bin_dir" ]] && [[ -w "$(dirname "$bin_dir")" ]] 2>/dev/null; then
    bin_ok=1
  fi
  if (( lib_ok && bin_ok )); then
    prefix_writable=1
  fi
fi

if (( prefix_writable )); then
  echo "[cfcf]   npm prefix '$npm_prefix' has writable lib/node_modules + bin -- skipping prefix fix"
else
  echo "[cfcf]   npm prefix '$npm_prefix' has root-owned lib/node_modules or bin."
  echo "[cfcf]   Configuring '~/.npm-global' as a user-writable prefix"
  echo "[cfcf]   (npm's documented fix for EACCES errors:"
  echo "[cfcf]    https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally)"
  mkdir -p "$HOME/.npm-global"
  npm config set prefix "$HOME/.npm-global"
  export PATH="$HOME/.npm-global/bin:$PATH"
  add_to_rc_idempotent "$HOME/.zshrc"  "npm-global path" 'export PATH="$HOME/.npm-global/bin:$PATH"'
  add_to_rc_idempotent "$HOME/.bashrc" "npm-global path" 'export PATH="$HOME/.npm-global/bin:$PATH"'
  echo "[cfcf]   prefix set: $(npm config get prefix)"
  prefix_was_modified=1
fi

if [[ "$CFCF_INSTALL_SOURCE" == "registry" ]]; then
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
  if [[ -z "${CFCF_BASE_URL:-}" ]]; then
    if [[ "$CFCF_VERSION" == "latest" ]]; then
      CFCF_BASE_URL="https://github.com/${CFCF_RELEASES_REPO}/releases/latest/download"
    else
      CFCF_BASE_URL="https://github.com/${CFCF_RELEASES_REPO}/releases/download/${CFCF_VERSION}"
    fi
  fi
  echo "[cfcf]   tarball base URL: $CFCF_BASE_URL"

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

  # Native first, CLI second.
  echo "[cfcf]   npm install -g $native_url"
  npm install -g "$native_url"
  echo "[cfcf]   npm install -g $cli_url"
  npm install -g "$cli_url"
  installed_version="$version"
fi

# ── 4/4. Verify install + print next-steps banner ─────────────────────
echo ""
echo "[cfcf] step 4/4: verify install"

if ! command -v cfcf >/dev/null 2>&1; then
  echo ""
  echo "[cfcf] cfcf was installed but is not on your PATH yet."
  echo "[cfcf] Open a new terminal (the npm-global path was added to your"
  echo "[cfcf] shell rc), or for THIS shell:"
  echo "[cfcf]   export PATH=\"$(npm config get prefix)/bin:\$PATH\""
  echo "[cfcf] Then run: cfcf doctor"
  exit 0
fi

actual_version="$(cfcf --version 2>/dev/null | tr -d '\r' | tr -d '\n' || true)"
if [[ -n "$actual_version" ]]; then
  echo "[cfcf]   cfcf v$actual_version installed (requested: $installed_version)"
else
  echo "[cfcf]   cfcf $installed_version installed"
fi

# Detect whether a cfcf server was running before this install. If
# there's a PID file under ~/.cfcf/, the running server still has the
# OLD bundled JS in memory; the user needs to restart it. Used to
# customise the next-steps banner.
server_was_running=0
if [[ -f "$HOME/.cfcf/server.pid" ]]; then
  pid="$(cat "$HOME/.cfcf/server.pid" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    server_was_running=1
  fi
fi

# Print the canonical next-steps banner. Earlier drafts tried to
# auto-launch `cfcf init` via `exec cfcf init </dev/tty`, but
# interactive terminal handling is unreliable when the parent is a
# `curl | bash` pipe (input frozen, Ctrl-C dead). Bun's installer
# doesn't try to auto-launch a follow-up tool for the same reason --
# we print + exit, user runs the commands in their normal shell.
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Installation complete!"
echo "═══════════════════════════════════════════════════════════════"
echo ""
if (( prefix_was_modified )); then
  # We just added ~/.npm-global/bin to ~/.zshrc/.bashrc. The user's
  # PARENT shell (the one that ran `curl | bash`) hasn't sourced the
  # rc update -- they need to either open a new terminal or source
  # the rc file before cfcf is on PATH. install.sh's PATH export
  # only affected its own subshell, which exits with this banner.
  echo "  IMPORTANT — npm prefix was reconfigured to ~/.npm-global,"
  echo "  so '~/.npm-global/bin' was added to your shell's PATH (in"
  echo "  ~/.zshrc and/or ~/.bashrc). For your CURRENT terminal:"
  echo ""
  echo "    • Open a new terminal window/tab, OR"
  echo "    • Run:  source ~/.zshrc     (or 'source ~/.bashrc')"
  echo ""
  echo "  Then continue with the next steps below."
  echo ""
  echo "  ─────────────────────────────────────────────────────────────"
  echo ""
fi
echo "  Next steps:"
echo ""
echo "    cfcf init                  # interactive first-run setup"
echo "                               # picks dev/judge/architect agents"
echo "                               # + chooses an embedder (or skip)"
echo ""
echo "    cfcf doctor                # re-verify install (rerun anytime)"
echo ""
echo "    cfcf --help                # full command reference"
echo "    cfcf help <topic>          # focused guides (manual, workflow,"
echo "                               # cli, clio, spec, installing, ...)"
echo ""
if (( server_was_running )); then
  echo "  Server restart needed:"
  echo ""
  echo "    cfcf server stop && cfcf server start"
  echo "                               # ↑ a cfcf server was running BEFORE"
  echo "                               # this install; it still has the OLD"
  echo "                               # bundled JS in memory. Restart it"
  echo "                               # to pick up v$actual_version."
  echo ""
fi
echo "  Documentation:"
echo "    https://github.com/fstamatelopoulos/cfcf#readme"
echo ""
echo "═══════════════════════════════════════════════════════════════"
