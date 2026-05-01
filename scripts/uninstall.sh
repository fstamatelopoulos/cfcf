#!/usr/bin/env bash
#
# Uninstall cfcf.
#
# Removes the cfcf CLI from Bun's global node_modules. User data
# (`~/.cfcf/clio.db`, `~/.cfcf/logs/`, platform config dir, workspace
# `cfcf-docs/`) is intentionally NOT touched -- removing those is a
# separate manual decision.
#
# Detects npm-installed cfcf too (some users may have installed via
# `npm install -g` between v0.16.4-rc and the bun-only redesign).
#
# Usage:  uninstall.sh             (interactive, prints what stays + asks)
#         CFCF_FORCE=1 uninstall.sh   (no prompt; runs the remove command)

set -euo pipefail

# Detect which package manager has cfcf installed. Try bun first
# (canonical install path), then npm (alternative path).
detect_install_method() {
  if command -v bun >/dev/null 2>&1; then
    if [[ -d "$HOME/.bun/install/global/node_modules/@cerefox/codefactory" ]]; then
      echo "bun"
      return 0
    fi
  fi
  if command -v npm >/dev/null 2>&1; then
    if npm ls -g --depth=0 --json 2>/dev/null | grep -q '"@cerefox/codefactory"'; then
      echo "npm"
      return 0
    fi
  fi
  echo ""
}

method="$(detect_install_method)"
if [[ -z "$method" ]]; then
  echo "[cfcf-uninstall] cfcf doesn't appear to be installed via bun or npm."
  echo "[cfcf-uninstall] If you installed via another mechanism, remove it manually:"
  echo "  bun pm -g ls          # list bun's global packages"
  echo "  npm root -g           # find npm's global node_modules"
  exit 1
fi

cat <<EOF
[cfcf-uninstall] cfcf is installed via $method.
[cfcf-uninstall] About to run: $(if [[ "$method" == "bun" ]]; then echo "bun remove -g @cerefox/codefactory"; else echo "npm remove -g @cerefox/codefactory"; fi)

What this removes:
  - the cfcf CLI + its bundled JS
  - the per-platform @cerefox/codefactory-native-<platform> package
  - the runtime deps (@huggingface/transformers, onnxruntime-node, sharp)

What this does NOT remove (preserved on purpose):
  - ~/.cfcf/clio.db    -- your cross-workspace memory
  - ~/.cfcf/logs/      -- agent stdout/stderr archives
  - the cfcf config file (run \`cfcf config show --path\` BEFORE uninstall to find it)
  - cfcf-docs/ directories inside any workspace -- those are committed git artifacts

EOF

if [[ -z "${CFCF_FORCE:-}" ]]; then
  read -r -p "Proceed? [y/N] " ans </dev/tty
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "[cfcf-uninstall] aborted."; exit 0 ;;
  esac
fi

if [[ "$method" == "bun" ]]; then
  bun remove -g @cerefox/codefactory
else
  npm remove -g @cerefox/codefactory
fi

echo "[cfcf-uninstall] done."
echo "[cfcf-uninstall] If you also want to delete your data: rm -rf ~/.cfcf"
