#!/usr/bin/env bash
#
# cfcf curl-bash installer.
#
# Canonical one-liner:
#   curl -fsSL https://github.com/fstamatelopoulos/cfcf/releases/latest/download/install.sh | bash
#
# Designed to "just work" on a stock fresh Mac/Linux. No sudo. No
# trust prompts. No new directories on PATH that require shell rc
# edits beyond what Bun's own installer already does.
#
# Why bun + npm + cfcf?
#   Bun is cfcf's RUNTIME (uses bun:sqlite, Bun.spawn, Bun.serve,
#   Bun.file directly throughout the codebase -- required at runtime).
#   npm is cfcf's INSTALL TOOL: chosen over `bun install` because Bun
#   blocks postinstall scripts by default (oven-sh/bun#4959), which
#   would break onnxruntime-node + protobufjs at install time without
#   a manual `bun pm trust` workaround. npm runs postinstalls by
#   default; the install Just Works.
#
# Why install cfcf to ~/.bun (instead of npm's default global prefix)?
#   ~/.bun/bin is already on the user's PATH (Bun's installer adds it
#   when bun is installed). Using `npm install -g --prefix ~/.bun`
#   puts cfcf at ~/.bun/bin/cfcf, immediately reachable, with no
#   additional PATH entries or shell rc edits beyond what Bun itself
#   needs. This avoids the EACCES gotcha on stock-installer Node
#   (npm's default prefix is /usr/local/, root-owned) and the "open
#   a new terminal" friction that came with the ~/.npm-global
#   workaround. Cosmetic: cfcf lives in ~/.bun/lib/node_modules/...
#   alongside Bun's own globals; functionally fine, no namespace
#   conflicts (cfcf is the only binary).
#
# Two install paths share this script:
#
#   • registry mode (default):
#       npm install -g --prefix ~/.bun @cerefox/codefactory[@version]
#
#   • tarball mode (offline / airgapped / pinned-mirror):
#       npm install -g --prefix ~/.bun <native-tarball-URL>
#       npm install -g --prefix ~/.bun <cli-tarball-URL>
#     Auto-engages when CFCF_BASE_URL is set; force with
#     CFCF_INSTALL_SOURCE=tarball.
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
# install.sh writes nothing to your shell rc. Bun's installer (when
# called for first-time bun install) writes its own ~/.bun/bin entry.
# Beyond that, no rc edits.

set -euo pipefail

# Capture the parent shell's PATH at the start. Used at the end to
# detect whether the user's parent shell will find cfcf as-is.
ORIGINAL_PATH="$PATH"

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

# Where cfcf gets installed. Always under ~/.bun (which is on PATH
# thanks to Bun's installer); npm's default prefix is bypassed
# entirely via `--prefix`.
CFCF_INSTALL_PREFIX="$HOME/.bun"
CFCF_BIN="$CFCF_INSTALL_PREFIX/bin/cfcf"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  cfcf — Cerefox Code Factory installer"
echo "═══════════════════════════════════════════════════════════════"
echo "  install source : $CFCF_INSTALL_SOURCE"
echo "  version        : $CFCF_VERSION"
echo "  install prefix : $CFCF_INSTALL_PREFIX  (cfcf will land at $CFCF_BIN)"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ── 1/4. Ensure Bun is on PATH (cfcf RUNTIME requirement) ─────────────
# Also: ~/.bun/bin needs to be on PATH for cfcf to be reachable
# (since we install cfcf to ~/.bun via npm's --prefix). Bun's own
# installer handles the rc edit for new shells; we export PATH for
# THIS subshell so verify works.
echo "[cfcf] step 1/4: ensure Bun ≥ 1.3 is installed"
bun_was_just_installed=0
if command -v bun >/dev/null 2>&1; then
  echo "[cfcf]   Bun found: v$(bun --version)"
else
  echo "[cfcf]   Bun not found; installing via Bun's official installer..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  if ! command -v bun >/dev/null 2>&1; then
    echo "[cfcf] Bun install failed -- ensure ~/.bun/bin is on PATH and re-run." >&2
    echo "[cfcf] Manual install: https://bun.sh/" >&2
    exit 1
  fi
  echo "[cfcf]   Bun installed: v$(bun --version)"
  bun_was_just_installed=1
fi

# ── 2/4. Ensure npm is on PATH (cfcf INSTALL TOOL) ────────────────────
# We use npm to install cfcf (not bun) because Bun blocks postinstall
# scripts by default (oven-sh/bun#4959). cfcf depends on
# onnxruntime-node + protobufjs whose postinstalls download platform-
# specific .node binaries and run codegen; if those don't run, Clio's
# embedder breaks at runtime. npm runs postinstalls by default.
echo ""
echo "[cfcf] step 2/4: ensure npm is installed"
if command -v npm >/dev/null 2>&1; then
  echo "[cfcf]   npm found: v$(npm --version)"
else
  echo "[cfcf]   npm not found; bootstrapping via 'bun install -g npm'..."
  bun install -g npm
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

# ── 3/4. Install cfcf into ~/.bun via `npm install -g --prefix` ───────
# `--prefix ~/.bun` overrides npm's default global prefix for this
# command only -- doesn't touch the user's npm config. cfcf lands at:
#   $CFCF_INSTALL_PREFIX/lib/node_modules/@cerefox/codefactory/...
#   $CFCF_INSTALL_PREFIX/bin/cfcf  (symlink)
# ~/.bun/bin is on PATH because cfcf requires Bun + Bun's installer
# adds it -- so the binary is reachable immediately, no rc edits.
echo ""
echo "[cfcf] step 3/4: install cfcf"

# Make sure $CFCF_INSTALL_PREFIX/bin is on this subshell's PATH so
# the verify step finds cfcf. (It should already be from step 1, but
# be defensive in case bun was already installed but ~/.bun/bin
# somehow isn't on PATH.)
export PATH="$CFCF_INSTALL_PREFIX/bin:$PATH"

if [[ "$CFCF_INSTALL_SOURCE" == "registry" ]]; then
  if [[ "$CFCF_VERSION" == "latest" ]]; then
    pkg_spec="@cerefox/codefactory@latest"
  else
    v_no_prefix="${CFCF_VERSION#v}"
    pkg_spec="@cerefox/codefactory@${v_no_prefix}"
  fi
  echo "[cfcf]   npm install -g --prefix $CFCF_INSTALL_PREFIX $pkg_spec"
  npm install -g --prefix "$CFCF_INSTALL_PREFIX" "$pkg_spec"
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
  echo "[cfcf]   npm install -g --prefix $CFCF_INSTALL_PREFIX $native_url"
  npm install -g --prefix "$CFCF_INSTALL_PREFIX" "$native_url"
  echo "[cfcf]   npm install -g --prefix $CFCF_INSTALL_PREFIX $cli_url"
  npm install -g --prefix "$CFCF_INSTALL_PREFIX" "$cli_url"
  installed_version="$version"
fi

# ── 4/4. Verify install + print next-steps banner ─────────────────────
echo ""
echo "[cfcf] step 4/4: verify install"

if ! command -v cfcf >/dev/null 2>&1; then
  echo ""
  echo "[cfcf] cfcf was installed but is not on your PATH yet."
  echo "[cfcf] This usually means ~/.bun/bin isn't on your PATH yet"
  echo "[cfcf] (e.g. Bun was just installed by this script + your"
  echo "[cfcf] current shell hasn't sourced the rc edit)."
  echo "[cfcf] Open a new terminal, OR run:"
  echo "[cfcf]   export PATH=\"\$HOME/.bun/bin:\$PATH\""
  echo "[cfcf] Then run: cfcf doctor"
  exit 0
fi

actual_version="$(cfcf --version 2>/dev/null | tr -d '\r' | tr -d '\n' || true)"
if [[ -n "$actual_version" ]]; then
  echo "[cfcf]   cfcf v$actual_version installed at $CFCF_BIN (requested: $installed_version)"
else
  echo "[cfcf]   cfcf $installed_version installed at $CFCF_BIN"
fi

# Detect whether ~/.bun/bin is on the parent shell's PATH. If not,
# the user needs to source rc / open new terminal before cfcf works
# in their parent shell. The most common cause: Bun was just installed
# by this script, so its installer-added rc edit hasn't been sourced
# in the user's current shell.
parent_shell_will_find_cfcf=0
case ":$ORIGINAL_PATH:" in
  *":$CFCF_INSTALL_PREFIX/bin:"*) parent_shell_will_find_cfcf=1 ;;
esac

# Detect whether a cfcf server was running before this install. If
# there's a PID file under ~/.cfcf/, the running server still has the
# OLD bundled JS in memory; the user needs to restart it.
server_was_running=0
if [[ -f "$HOME/.cfcf/server.pid" ]]; then
  pid="$(cat "$HOME/.cfcf/server.pid" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    server_was_running=1
  fi
fi

# Print the canonical next-steps banner.
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Installation complete!"
echo "═══════════════════════════════════════════════════════════════"
echo ""
if (( ! parent_shell_will_find_cfcf )); then
  # ~/.bun/bin not on parent shell PATH. Most common cause: bun was
  # just installed by this script. Bun's installer added ~/.bun/bin
  # to ~/.zshrc/.bashrc but the user's CURRENT shell hasn't sourced
  # the rc update -- they need to open a new terminal or source the
  # rc file before cfcf is reachable. (install.sh's PATH export only
  # affects its own subshell, not the user's parent shell.)
  echo "  IMPORTANT — ~/.bun/bin is not on your CURRENT terminal's PATH."
  if (( bun_was_just_installed )); then
    echo "  Bun was just installed by this script; Bun's installer added"
    echo "  ~/.bun/bin to ~/.zshrc/.bashrc but your current shell hasn't"
    echo "  picked it up yet. For your CURRENT terminal:"
  else
    echo "  ~/.bun/bin should be on your PATH (Bun's installer adds it)."
    echo "  If it's missing, your shell rc may have been modified. For"
    echo "  your CURRENT terminal:"
  fi
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
echo "    cfcf server start          # start the cfcf background server"
echo "                               # (hosts API + web UI; stays up until"
echo "                               # you run 'cfcf server stop')"
echo ""
echo "    cfcf workspace init --repo <path> --name <name>"
echo "                               # register a git repo as a workspace"
echo "                               # so cfcf can track loops + iterations"
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
