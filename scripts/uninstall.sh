#!/usr/bin/env bash
#
# Uninstall cfcf.
#
# Removes the cfcf CLI + the per-platform native package from Bun's
# global node_modules (or npm's, if cfcf was installed via `npm install
# -g`). User data (`~/.cfcf/clio.db`, `~/.cfcf/logs/`, platform config
# dir, workspace `cfcf-docs/`) is intentionally NOT touched -- removing
# those is a separate manual decision.
#
# Usage:  uninstall.sh             (interactive, prints what stays + asks)
#         CFCF_FORCE=1 uninstall.sh   (no prompt; runs the remove commands)
#
# Or curl-bash:
#   curl -fsSL https://raw.githubusercontent.com/fstamatelopoulos/cfcf/main/scripts/uninstall.sh | bash
#   curl -fsSL https://github.com/fstamatelopoulos/cfcf/releases/latest/download/uninstall.sh | bash

set -euo pipefail

# Detect platform tag for the native package (so we can remove it too;
# `bun remove -g <main>` doesn't cascade to optionalDependencies that
# were installed alongside as separate top-level entries).
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$os-$arch" in
  darwin-arm64)  platform=darwin-arm64 ;;
  darwin-x86_64) platform=darwin-x64 ;;
  linux-x86_64)  platform=linux-x64 ;;
  *) platform="" ;;   # unsupported -- shouldn't happen post-install but handle gracefully
esac

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

# Build the list of packages to remove. The native package is detected
# by platform; if the platform isn't recognised we just skip it (the
# user can clean it up manually if needed).
packages=("@cerefox/codefactory")
if [[ -n "$platform" ]]; then
  packages+=("@cerefox/codefactory-native-$platform")
fi

# Build the command preview for the confirmation message.
if [[ "$method" == "bun" ]]; then
  cmd_preview="bun remove -g ${packages[*]}"
else
  cmd_preview="npm remove -g ${packages[*]}"
fi

cat <<EOF
[cfcf-uninstall] cfcf is installed via $method.
[cfcf-uninstall] About to run:
  $cmd_preview

What this removes:
  - the cfcf CLI + its bundled JS
  - the per-platform @cerefox/codefactory-native-$platform package
  - transitive runtime deps (@huggingface/transformers, onnxruntime-node, sharp, protobufjs)
    that aren't shared with another global package

What this does NOT remove (preserved on purpose):
  - ~/.cfcf/clio.db    -- your cross-workspace memory
  - ~/.cfcf/logs/      -- agent stdout/stderr archives
  - the cfcf config file (run \`cfcf config show --path\` BEFORE uninstall to find it)
  - cfcf-docs/ directories inside any workspace -- those are committed git artifacts
  - any sentinel-marked blocks the cfcf installer added to your shell rc
    (~/.bun/bin or ~/.npm-global/bin lines); these are inert if cfcf is gone

EOF

if [[ -z "${CFCF_FORCE:-}" ]]; then
  read -r -p "Proceed? [y/N] " ans </dev/tty
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "[cfcf-uninstall] aborted."; exit 0 ;;
  esac
fi

# Remove each package. If one fails (e.g. native package was already
# manually removed), we keep going so the others still get removed.
for pkg in "${packages[@]}"; do
  echo "[cfcf-uninstall] removing $pkg..."
  if [[ "$method" == "bun" ]]; then
    bun remove -g "$pkg" || echo "[cfcf-uninstall]   ($pkg wasn't installed; continuing)"
  else
    npm remove -g "$pkg" || echo "[cfcf-uninstall]   ($pkg wasn't installed; continuing)"
  fi
done

echo ""
echo "[cfcf-uninstall] done."
echo "[cfcf-uninstall] If you also want to delete your data: rm -rf ~/.cfcf"
