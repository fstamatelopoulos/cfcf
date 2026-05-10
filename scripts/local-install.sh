#!/usr/bin/env bash
#
# local-install.sh — build cfcf from this checkout and install it on
# your machine, mimicking what an end user gets via the curl-bash
# install.sh + GitHub Release path. Use this for end-to-end UX testing
# of changes that touch the install pipeline (install.sh, build-cli.sh,
# self-update, banners, etc.) before triggering a real release.
#
# What it does:
#   1. Cleans any existing cfcf install (uninstall.sh).
#      Skip with --keep if you want to test an upgrade-in-place path.
#   2. Runs scripts/stage-dist.sh to build dist/ (CLI + native + install.sh).
#   3. Runs the local install.sh against `file://$(pwd)/dist`.
#   4. Verifies the install with `cfcf --version` and `cfcf doctor`.
#   5. Prints how to restore the published version when you're done.
#
# Result: `cfcf` on your PATH points at the locally-built version,
# installed at the same canonical location an end user gets
# (~/.bun/lib/node_modules/...) with the same banner/doctor experience.
#
# Usage:
#   ./scripts/local-install.sh                      # auto-version: v<root.version>-local
#   ./scripts/local-install.sh v0.16.5-rc           # custom label
#   ./scripts/local-install.sh --keep               # don't uninstall first
#   ./scripts/local-install.sh --keep v0.16.5-rc    # both
#
# To restore the published version when you're done:
#   cfcf self-update --yes
#   # or just re-run the canonical curl-bash installer:
#   curl -fsSL https://github.com/fstamatelopoulos/cfcf/releases/latest/download/install.sh | bash

set -euo pipefail

# ── Args ───────────────────────────────────────────────────────────────

VERSION_INPUT=""    # empty = auto-derive from root package.json
DO_CLEAN=1          # default: clean before install (the common case)

for arg in "$@"; do
  case "$arg" in
    --keep)
      DO_CLEAN=0
      ;;
    --clean)
      # Backwards-compat / explicit. Already the default; harmless to pass.
      DO_CLEAN=1
      ;;
    -h|--help)
      sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "[local-install] unknown flag: $arg" >&2
      exit 1
      ;;
    *)
      # Normalise: strip leading "v", then re-add (so v0.16.5 and 0.16.5 both work).
      VERSION_INPUT="v${arg#v}"
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Auto-derive version from root package.json ─────────────────────────

if [[ -z "$VERSION_INPUT" ]]; then
  # Read the root version with a tiny portable JS so we don't depend on
  # `jq` being installed. node + bun both expose the same Node API here.
  root_version="$(
    cd "$REPO_DIR" && \
    node -e 'console.log(require("./package.json").version)' 2>/dev/null \
    || bun --silent -e 'console.log(JSON.parse(await Bun.file("package.json").text()).version)' 2>/dev/null
  )"
  if [[ -z "$root_version" ]]; then
    echo "[local-install] ✗ could not read version from $REPO_DIR/package.json" >&2
    echo "[local-install]   pass an explicit version: ./scripts/local-install.sh v0.16.5-rc" >&2
    exit 1
  fi
  VERSION_INPUT="v${root_version}-local"
fi

echo "[local-install] checkout: $REPO_DIR"
echo "[local-install] version label: $VERSION_INPUT"
if (( DO_CLEAN )); then
  echo "[local-install] mode: clean install (use --keep to skip the uninstall step)"
else
  echo "[local-install] mode: keep existing install (--keep)"
fi
echo

# ── Pre-flight: dev tree must be installed ─────────────────────────────
#
# The build pipeline (stage-dist → build-cli → packages/web's
# `tsc -b && vite build`) needs `tsc`, `vite`, and the rest of the
# workspace dev tooling on PATH via `node_modules/.bin/`. On a fresh
# clone the workspace tree is empty, so the build crashes ~200 lines
# deep with `tsc: command not found`. Detecting it up front gives the
# user a clean, actionable error instead of a confusing crash.
#
# Two reasons we don't auto-run `bun install` here:
#   (1) Implicit network calls in a build script are surprising —
#       contributors should be able to predict what happens.
#   (2) `bun install` may pick a different lockfile resolution than
#       the user expects on first run; explicit is safer.
if [[ ! -d "$REPO_DIR/node_modules" ]]; then
  echo "[local-install] ✗ workspace dependencies not installed (no node_modules at $REPO_DIR)" >&2
  echo "[local-install]" >&2
  echo "[local-install]   This script needs the dev tree to be set up first. Run:" >&2
  echo "[local-install]" >&2
  echo "[local-install]     bun install" >&2
  echo "[local-install]" >&2
  echo "[local-install]   (Use bun, not npm — cfcf workspaces use Bun's workspace:* protocol" >&2
  echo "[local-install]    which npm doesn't understand. See README.md → For developers.)" >&2
  exit 1
fi

# ── Pre-flight: warn if a server is running with a live loop ───────────
#
# Item 6.35 follow-up #2 (2026-05-10). The `npm remove` step temporarily
# breaks the cfcf package tree on disk. Externalized lazy imports
# (notably `@huggingface/transformers` via the Clio ONNX embedder) will
# resolve to a missing module if the running server tries to load them
# during the install window — that surfaces as an `unhandledRejection`,
# triggers `gracefulShutdown`, kills active agents, and corrupts history
# events with stale "Server restarted" messages on the next boot.
#
# Detecting an active loop here lets us warn the user BEFORE the damage,
# with a one-liner to stop the server first.
#
# Implementation: use `cfcf server status` + `cfcf status` rather than
# probing the PID file directly — the PID file path is platform-
# dependent (macOS: ~/Library/Application Support/cfcf/server.pid;
# Linux: ~/.config/cfcf/server.pid; the user-visible ~/.cfcf is the
# DATA dir, not the config dir, on macOS — earlier versions of this
# script and install.sh both got this wrong + silently no-op'd on Mac).
# `cfcf` already has the correct per-platform logic baked in.
#
# Best-effort: needs `cfcf` on PATH (true in the upgrade scenario this
# is meant for). If the check itself fails for any reason, we continue
# silently — the warning is a courtesy, not a hard gate.
if command -v cfcf >/dev/null 2>&1; then
  # Probe the server. `cfcf server status` prints "cfcf server v..."
  # when running, "cfcf server is not running." otherwise. We grep on
  # the running marker so a config-dir mismatch doesn't false-positive.
  server_status="$(cfcf server status 2>/dev/null || true)"
  if echo "$server_status" | grep -q "^cfcf server v"; then
    # Server is running. Check `cfcf status` for any workspace whose
    # status is "running" or "paused" (i.e. has a live or paused loop
    # we don't want to disturb). Output looks like:
    #   Workspaces:
    #     testgame: running (iteration 3)
    #     other: idle
    has_active_loop=0
    active_workspaces=""
    if status_output="$(cfcf status 2>/dev/null)"; then
      # Strip the leading 2-space indent + extract `<name>: <status>`
      # lines whose status is running or paused.
      active_workspaces="$(echo "$status_output" \
        | grep -E '^[[:space:]]+[^[:space:]]+:[[:space:]]+(running|paused)' \
        || true)"
      if [[ -n "$active_workspaces" ]]; then
        has_active_loop=1
      fi
    fi
    if (( has_active_loop )); then
      echo "[local-install] ⚠️  WARNING: cfcf server is running with an active or paused loop:" >&2
      while IFS= read -r line; do
        [[ -n "$line" ]] && echo "[local-install]    $line" >&2
      done <<< "$active_workspaces"
      echo "[local-install]" >&2
      echo "[local-install]   Re-installing now will break the running server's externalized" >&2
      echo "[local-install]   dependencies (@huggingface/transformers, etc.) for a few seconds" >&2
      echo "[local-install]   while npm remove + npm install run. Any Clio operation hitting" >&2
      echo "[local-install]   a lazy import in that window will throw, triggering gracefulShutdown." >&2
      echo "[local-install]   Active history events get marked failed with a stale error." >&2
      echo "[local-install]" >&2
      echo "[local-install]   Recommended:" >&2
      echo "[local-install]     cfcf server stop      # if you want to resume the loop, do" >&2
      echo "[local-install]                           # 'cfcf resume <workspace>' AFTER the new" >&2
      echo "[local-install]                           # server starts" >&2
      echo "[local-install]     ./scripts/local-install.sh" >&2
      echo "[local-install]     cfcf server start" >&2
      echo "[local-install]     cfcf resume <workspace>   # if the loop was paused" >&2
      echo "[local-install]" >&2
      printf "[local-install]   Continue anyway? [y/N] " >&2
      read -r answer
      case "$answer" in
        [Yy]|[Yy][Ee][Ss]) echo "[local-install]   continuing at user request" >&2 ;;
        *) echo "[local-install]   aborted" >&2; exit 1 ;;
      esac
      echo
    fi
  fi
fi

# ── Step 1: clean (default) ────────────────────────────────────────────

if (( DO_CLEAN )); then
  echo "[local-install] step 1/4: cleaning existing cfcf install"
  if [[ -x "$SCRIPT_DIR/uninstall.sh" ]]; then
    bash "$SCRIPT_DIR/uninstall.sh" || true
  else
    # uninstall.sh missing for some reason; do the canonical removal inline.
    npm remove -g --prefix "$HOME/.bun" \
      @cerefox/codefactory \
      @cerefox/codefactory-native-darwin-arm64 \
      @cerefox/codefactory-native-darwin-x64 \
      @cerefox/codefactory-native-linux-x64 \
      2>/dev/null || true
  fi
  echo
else
  echo "[local-install] step 1/4: skipping clean (--keep)"
  echo
fi

# ── Step 2: stage dist/ ────────────────────────────────────────────────

echo "[local-install] step 2/4: building dist/ via stage-dist.sh"
"$SCRIPT_DIR/stage-dist.sh" "$VERSION_INPUT"
echo

# ── Step 3: run install.sh against the local dist ──────────────────────

echo "[local-install] step 3/4: running install.sh against file://$REPO_DIR/dist"
echo
CFCF_BASE_URL="file://$REPO_DIR/dist" \
CFCF_VERSION="$VERSION_INPUT" \
  bash "$REPO_DIR/dist/install.sh"

# ── Step 4: verify ─────────────────────────────────────────────────────

echo
echo "[local-install] step 4/4: verifying install"

# Make sure the freshly-installed cfcf is what we run, not a stale shell
# alias / hashed path. `command -v` returns the resolved path; we shell out
# to it explicitly.
cfcf_path="$(command -v cfcf || true)"
if [[ -z "$cfcf_path" ]]; then
  echo "[local-install] ✗ cfcf not on PATH after install. Check install.sh output above."
  exit 1
fi

actual_version="$("$cfcf_path" --version 2>&1 || echo unknown)"
echo "[local-install]   binary: $cfcf_path"
echo "[local-install]   version: $actual_version"
echo

echo "[local-install] running cfcf doctor:"
echo
"$cfcf_path" doctor || {
  echo
  echo "[local-install] ✗ doctor reported issues (above). Local install may be broken."
  exit 1
}

# ── Done ───────────────────────────────────────────────────────────────

echo
echo "[local-install] ✓ done. Local install of $VERSION_INPUT is live."
echo
echo "  To restore the published version when you're finished testing:"
echo "    cfcf self-update --yes"
echo "    # or, equivalently, re-run the canonical curl-bash installer:"
echo "    curl -fsSL https://github.com/fstamatelopoulos/cfcf/releases/latest/download/install.sh | bash"
echo
