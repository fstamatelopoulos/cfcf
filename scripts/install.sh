#!/usr/bin/env bash
#
# cfcf curl-bash installer.
#
# Per docs/research/installer-design.md §4 + 5.5b decisions
# (docs/research/npm-publish-5.5b-audit.md, 2026-04-29).
#
# Two install paths share this script:
#
#   • npm mode (default, post-5.5b):
#       bun install -g @cerefox/codefactory[@version]
#     Bun's package manager fetches the CLI + the matching per-platform
#     @cerefox/codefactory-native-<platform> via the optionalDependencies
#     entry in the published package.json (selected by `os`/`cpu`).
#
#   • tarball mode (offline / airgapped / pinned-mirror / pre-publish):
#       fetch cfcf-X.Y.Z.tgz + cerefox-codefactory-native-<plat>-X.Y.Z.tgz
#       from CFCF_BASE_URL, then `bun install -g <tarball-URL>` each.
#     Tarball mode auto-engages when CFCF_BASE_URL is set, or you can
#     force it with CFCF_INSTALL_SOURCE=tarball.
#
# Both paths:
#   1. Bootstrap Bun ≥ 1.3 if missing.
#   2. Run the matching `bun install -g …`.
#   3. Run `cfcf completion install` (best-effort; respects the user's
#      shell rc convention; never edits files cfcf doesn't own).
#   4. Hand off to `cfcf init` interactively unless CFCF_SKIP_INIT is set.
#
# Note: once cfcf is published on npmjs.com (5.5b step 8), this script
# is *optional* for users who already have Bun + npm on their machine
# -- they can run `bun install -g @cerefox/codefactory` directly. The
# wrapper exists for the Bun-bootstrap + cfcf-init handoff convenience.
#
# Env vars (all optional):
#   CFCF_INSTALL_SOURCE  "npm" or "tarball" (auto: tarball if
#                        CFCF_BASE_URL is set, else npm)
#   CFCF_VERSION         tag to install ("latest" or e.g. "v0.16.1")
#   CFCF_BASE_URL        where to fetch tarballs from (http/https/file://);
#                        only used in tarball mode. Default points at the
#                        cfcf-releases GitHub repo's release assets.
#   CFCF_RELEASES_REPO   override the github.com/<owner>/<repo> path used
#                        to build the default CFCF_BASE_URL
#   CFCF_SKIP_INIT       skip the press-Enter handoff to cfcf init at the
#                        end (useful for non-interactive runs)

set -euo pipefail

: "${CFCF_VERSION:=latest}"
: "${CFCF_RELEASES_REPO:=fstamatelopoulos/cfcf-releases}"

# ── Resolve install source ─────────────────────────────────────────────
# Auto-detect tarball mode when the user supplied a base URL: the only
# reason to set CFCF_BASE_URL is to point us at a tarball mirror, and
# silently ignoring it in npm mode would be confusing. CFCF_INSTALL_SOURCE
# overrides the auto-detection either way.
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
echo "[cfcf] Install source: $CFCF_INSTALL_SOURCE"

# ── Ensure Bun is on PATH ──────────────────────────────────────────────
# Same bootstrap regardless of install source: both modes drive Bun's
# global package manager.
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

# ── Bun-global dedup workaround ────────────────────────────────────────
# Workaround for Bun bug: every `bun install -g <local-tarball>` (and at
# least some non-registry URL forms) APPENDS a duplicate key to
# ~/.bun/install/global/package.json AND ~/.bun/install/global/bun.lock
# (Bun 1.3+ ships a JSON-shaped bun.lock instead of the older binary
# bun.lockb) instead of overwriting the existing entry. The dup is
# created by bun DURING the install, not on subsequent reads. After a
# few install/upgrade cycles the lockfile accumulates dozens of duplicate
# keys and bun spams `warn: Duplicate key` on every read. Functionally
# harmless (last-occurrence wins on parse) but unprofessional UX.
#
# Fix: dedup BOTH files BEFORE and AFTER each `bun install -g` call. We
# run dedup in BOTH modes (npm + tarball) since registry installs aren't
# fully exempt from the bug either, and dedup is cheap + best-effort.
# Same fix mirrored in cfcf self-update.
dedup_bun_global() {
  # Approach: process "runs" of consecutive object-entry lines. Within
  # each run, keep only the LAST occurrence of each key (matches
  # JSON.parse last-wins semantics). Runs are delimited by any non-entry
  # line (`{`, `}`, blank, etc.), so dedup is naturally scoped to a
  # single object literal -- the same key in different sections of
  # bun.lock (e.g. workspaces."".dependencies vs packages) is preserved.
  #
  # Works on both files. bun.lock isn't strict JSON (has JSON5-style
  # trailing commas + non-quoted forms) so JSON.parse would fail; this
  # text-based approach handles both.
  for f in "$HOME/.bun/install/global/package.json" "$HOME/.bun/install/global/bun.lock"; do
    [[ -f "$f" ]] || continue
    tmp="${f}.cfcf-dedup.$$"
    if awk '
      function flush_run(    i, k) {
        for (i = 1; i <= run_len; i++) {
          k = run_keys[i]
          if (k == "" || i == last_idx_for_key[k]) print run_lines[i]
        }
        delete last_idx_for_key
        run_len = 0
      }
      /^[[:space:]]*"[^"]+"[[:space:]]*:/ {
        s = $0; sub(/^[[:space:]]*"/, "", s); sub(/".*$/, "", s); k = s
        run_len++
        run_lines[run_len] = $0
        run_keys[run_len] = k
        last_idx_for_key[k] = run_len
        next
      }
      {
        if (run_len > 0) flush_run()
        print
      }
      END { if (run_len > 0) flush_run() }
    ' "$f" > "$tmp" 2>/dev/null; then
      mv "$tmp" "$f" 2>/dev/null || rm -f "$tmp"
    else
      rm -f "$tmp"
    fi
  done
}

# ── Install ────────────────────────────────────────────────────────────
if [[ "$CFCF_INSTALL_SOURCE" == "npm" ]]; then
  # npm mode: a single `bun install -g @cerefox/codefactory[@version]`.
  # Bun resolves the CLI + the optionalDependencies-listed
  # @cerefox/codefactory-native-<platform> in one shot using the os/cpu
  # filters declared in the published package.json -- no manual platform
  # detection on our side. Runtime deps (transformers, ORT, sharp) come
  # along the same way.
  if [[ "$CFCF_VERSION" == "latest" ]]; then
    pkg_spec="@cerefox/codefactory@latest"
  else
    v_no_prefix="${CFCF_VERSION#v}"
    pkg_spec="@cerefox/codefactory@${v_no_prefix}"
  fi

  dedup_bun_global    # clean any accumulated mess from prior installs
  echo "[cfcf] Installing $pkg_spec from npmjs.com..."
  bun install -g "$pkg_spec"
  dedup_bun_global    # bun re-introduced a dup during its install
  installed_version="$CFCF_VERSION"
else
  # tarball mode: fetch CLI + matching per-platform native package from
  # CFCF_BASE_URL and `bun install -g` each. Used for offline /
  # airgapped installs, pinned-mirror corporate setups, and pre-publish
  # smoke testing (steps 7 + 8).
  if [[ -z "${CFCF_BASE_URL:-}" ]]; then
    if [[ "$CFCF_VERSION" == "latest" ]]; then
      CFCF_BASE_URL="https://github.com/${CFCF_RELEASES_REPO}/releases/latest/download"
    else
      CFCF_BASE_URL="https://github.com/${CFCF_RELEASES_REPO}/releases/download/${CFCF_VERSION}"
    fi
  fi
  echo "[cfcf] Tarball base URL: $CFCF_BASE_URL"

  # Platform detection: tarball mode installs the native package
  # explicitly (the CLI tarball's optionalDependencies references
  # @cerefox/codefactory-native-* on the npm registry, which may not be
  # populated in this install context — installing the matching native
  # tarball directly satisfies the runtime require regardless).
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

  # Resolve "latest" via GitHub's redirect convention. file:// URLs
  # don't have a "latest" symlink convention, so callers must pin the
  # version explicitly.
  if [[ "$CFCF_VERSION" == "latest" ]]; then
    case "$CFCF_BASE_URL" in
      file://*)
        echo "[cfcf] CFCF_VERSION=latest is not supported with file:// URLs." >&2
        echo "[cfcf] Set CFCF_VERSION explicitly, e.g. CFCF_VERSION=v0.16.1." >&2
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
  cli_url="$CFCF_BASE_URL/cfcf-${v_no_prefix}.tgz"
  native_url="$CFCF_BASE_URL/cerefox-codefactory-native-${platform}-${v_no_prefix}.tgz"

  # Native package first, CLI second. Order matters: when bun installs
  # the CLI, its optionalDependencies entry tries the npm registry; if
  # the package isn't there yet (pre-publish or private mirror), bun
  # emits a soft 404 warning. Having the native package already
  # globally installed satisfies the require at runtime regardless of
  # npm visibility.
  dedup_bun_global    # clean any accumulated mess from prior installs
  echo "[cfcf] Installing @cerefox/codefactory-native-$platform from $native_url"
  bun install -g "$native_url"
  dedup_bun_global    # bun re-introduced a dup during its install
  echo "[cfcf] Installing @cerefox/codefactory from $cli_url"
  bun install -g "$cli_url"
  dedup_bun_global    # again
  installed_version="$version"
fi

# ── Post-install verification ─────────────────────────────────────────
if ! command -v cfcf >/dev/null 2>&1; then
  echo "[cfcf] cfcf installed but not on PATH."
  echo "[cfcf] Add Bun's global bin to your shell rc:"
  echo "         export PATH=\"$HOME/.bun/bin:\$PATH\""
  exit 0
fi
# Resolve the installed version verbatim from `cfcf --version`. More
# accurate than echoing the requested spec — handles the npm@latest case
# (where the spec is the literal string "latest") and any version that
# bun's resolver picked transitively. Best-effort; fall back to the
# requested label if the binary isn't introspectable for any reason.
actual_version="$(cfcf --version 2>/dev/null | tr -d '\r' | tr -d '\n' || true)"
if [[ -n "$actual_version" ]]; then
  echo "[cfcf] cfcf $actual_version installed (requested: $installed_version)."
else
  echo "[cfcf] cfcf $installed_version installed."
fi

# ── Install shell completion (best-effort) ────────────────────────────
# Same regeneration `cfcf self-update` does post-upgrade and that the
# published package's postinstall hook runs on `bun install -g`. Keeps
# the user's shell completion in lock-step with the verb tree they
# actually have. Trust principle: cfcf only touches files it owns
# (~/.cfcf-completion.bash, ~/.zsh/completions/_cfcf); it does NOT
# edit user rc files. Failure here doesn't fail the install.
echo "[cfcf] Installing shell completion..."
cfcf completion install || echo "[cfcf] (completion install skipped/failed -- run 'cfcf completion install' manually)"

# ── Hand off to cfcf init (interactive) ───────────────────────────────
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
