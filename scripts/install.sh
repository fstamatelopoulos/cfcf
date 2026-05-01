#!/usr/bin/env bash
#
# cfcf curl-bash installer.
#
# Canonical one-liner:
#   curl -fsSL https://github.com/fstamatelopoulos/cfcf/releases/latest/download/install.sh | bash
#
# Single-tool design (2026-05-01): Bun is both cfcf's RUNTIME (uses
# bun:sqlite, Bun.spawn, Bun.serve, Bun.file directly) and its install
# tool. No Node.js / npm requirement.
#
# To work around oven-sh/bun#4959 ("Fix postinstall and finish
# trustedDependencies") -- Bun blocks postinstall scripts of transitive
# deps even when the manifest declares trustedDependencies -- this
# script explicitly grants trust to the 3 specific packages whose
# postinstalls cfcf needs:
#
#   • @cerefox/codefactory -- runs `cfcf completion install` to wire
#     up shell tab completion + print the post-install banner
#   • onnxruntime-node     -- downloads platform-specific .node runtime
#                            binaries (required for Clio's embedder)
#   • protobufjs           -- generates serializer stubs onnxruntime
#                            depends on
#
# Named packages only; never `--all`. The trust grant is scripted, not
# user-typed, so the user never sees a prompt -- but the install.sh
# output is verbose enough that the trust step is auditable. cfcf's
# published package.json declares `trustedDependencies: [
# "onnxruntime-node", "protobufjs"]`, so once oven-sh/bun#4959 lands
# upstream, the explicit `bun pm trust` step here becomes a no-op
# (Bun will honor the manifest declaration directly).
#
# Two install paths share this script:
#
#   • registry mode (default):
#       bun install -g @cerefox/codefactory[@version]
#
#   • tarball mode (offline / airgapped / pinned-mirror):
#       bun install -g <native-tarball-URL>
#       bun install -g <cli-tarball-URL>
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
#   CFCF_SKIP_INIT       skip the press-Enter handoff to cfcf init
#                        (useful for non-interactive runs / CI)

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

# ── 1/4. Ensure Bun is on PATH ────────────────────────────────────────
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

# ── 2/4. Install cfcf via bun ─────────────────────────────────────────
# Note: `bun install -g` blocks postinstall scripts of cfcf's
# dependencies by default. This is fine here because step 3 explicitly
# grants trust + runs them.
echo ""
echo "[cfcf] step 2/4: install cfcf"

if [[ "$CFCF_INSTALL_SOURCE" == "registry" ]]; then
  if [[ "$CFCF_VERSION" == "latest" ]]; then
    pkg_spec="@cerefox/codefactory@latest"
  else
    v_no_prefix="${CFCF_VERSION#v}"
    pkg_spec="@cerefox/codefactory@${v_no_prefix}"
  fi
  echo "[cfcf]   bun install -g $pkg_spec"
  bun install -g "$pkg_spec"
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
  echo "[cfcf]   bun install -g $native_url"
  bun install -g "$native_url"
  echo "[cfcf]   bun install -g $cli_url"
  bun install -g "$cli_url"
  installed_version="$version"
fi

# ── 3/4. Grant trust + run blocked postinstalls ───────────────────────
# Workaround for oven-sh/bun#4959: Bun blocks postinstall scripts of
# transitive dependencies even when the manifest declares
# trustedDependencies. cfcf's published package.json declares
# `trustedDependencies: ["onnxruntime-node", "protobufjs"]`, but Bun
# doesn't currently honor that for global installs of transitive deps.
#
# Without this step, three blocked postinstalls would leave cfcf in a
# broken state:
#   • @cerefox/codefactory's own `cfcf completion install` doesn't run
#     → tab-complete + post-install banner missing
#   • onnxruntime-node's `node ./script/install` doesn't run
#     → platform-specific .node binaries missing → embedder fails at runtime
#   • protobufjs's `node scripts/postinstall` doesn't run
#     → onnxruntime-dependent codegen missing
#
# We grant trust to NAMED, SPECIFIC packages -- never `--all`. The trust
# is auditable here (visible in the verbose output) + scoped to the
# minimum needed. Once #4959 lands upstream, this step becomes a no-op
# (Bun will honor the manifest declaration directly).
echo ""
echo "[cfcf] step 3/4: run blocked postinstall scripts"
echo "[cfcf]   bun pm -g trust @cerefox/codefactory onnxruntime-node protobufjs"
echo "[cfcf]   (these 3 packages have postinstalls that download platform-"
echo "[cfcf]    specific runtime binaries + generate codegen; auditable on:"
echo "[cfcf]    https://github.com/oven-sh/bun/issues/4959)"
bun pm -g trust @cerefox/codefactory onnxruntime-node protobufjs || {
  echo "[cfcf] Warning: bun pm trust step had non-zero exit." >&2
  echo "[cfcf] cfcf may still work; run 'cfcf doctor' below to verify." >&2
}

# ── 4/4. Verify install + handoff ─────────────────────────────────────
echo ""
echo "[cfcf] step 4/4: verify + first-run setup"

if ! command -v cfcf >/dev/null 2>&1; then
  echo ""
  echo "[cfcf] cfcf was installed but is not on your PATH."
  echo "[cfcf] This usually means ~/.bun/bin isn't on your PATH yet."
  echo "[cfcf] Open a new terminal (Bun's installer added the line to your"
  echo "[cfcf] shell rc), or for THIS shell:"
  echo "[cfcf]   export PATH=\"\$HOME/.bun/bin:\$PATH\""
  echo "[cfcf] Then run: cfcf doctor"
  exit 0
fi

actual_version="$(cfcf --version 2>/dev/null | tr -d '\r' | tr -d '\n' || true)"
if [[ -n "$actual_version" ]]; then
  echo "[cfcf]   cfcf v$actual_version installed (requested: $installed_version)"
else
  echo "[cfcf]   cfcf $installed_version installed"
fi

# Run doctor for a quick health check (informative; non-blocking).
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
