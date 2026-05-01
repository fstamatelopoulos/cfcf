#!/usr/bin/env bash
#
# Uninstall cfcf.
#
# Removes the cfcf CLI + the per-platform native package from
# wherever they're installed. As of v0.16.4, install.sh installs cfcf
# to ~/.bun (via `npm install -g --prefix ~/.bun`); older versions
# may have installed to ~/.npm-global, /usr/local, or via `bun install
# -g`. This script detects all known install locations + cleans them
# up.
#
# User data (~/.cfcf/clio.db, ~/.cfcf/logs/, platform config dir,
# workspace cfcf-docs/) is intentionally NOT touched -- removing
# those is a separate manual decision.
#
# Usage:  uninstall.sh             (interactive, prints what stays + asks)
#         CFCF_FORCE=1 uninstall.sh   (no prompt; runs the remove commands)
#
# Or curl-bash:
#   curl -fsSL https://raw.githubusercontent.com/fstamatelopoulos/cfcf/main/scripts/uninstall.sh | bash
#   curl -fsSL https://github.com/fstamatelopoulos/cfcf/releases/latest/download/uninstall.sh | bash

set -euo pipefail

# Detect platform tag for the native package.
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$os-$arch" in
  darwin-arm64)  platform=darwin-arm64 ;;
  darwin-x86_64) platform=darwin-x64 ;;
  linux-x86_64)  platform=linux-x64 ;;
  *) platform="" ;;
esac

# Build the list of (location, removal_command) pairs to check. Each
# entry is "<lib_node_modules_path>|<remove_command_template>".
# The lib path is checked for existence; if present, the remove
# command is run with each package name interpolated as $pkg.
locations=()
# v0.16.4+ canonical: npm-installed under ~/.bun
locations+=("$HOME/.bun/lib/node_modules|npm remove -g --prefix $HOME/.bun")
# v0.16.4 earlier draft: npm-installed under ~/.npm-global
locations+=("$HOME/.npm-global/lib/node_modules|npm remove -g --prefix $HOME/.npm-global")
# Pre-prefix-fix npm install: system default prefix
sys_prefix="$(command -v npm >/dev/null 2>&1 && npm config get prefix 2>/dev/null || echo "")"
if [[ -n "$sys_prefix" ]] \
   && [[ "$sys_prefix" != "$HOME/.bun" ]] \
   && [[ "$sys_prefix" != "$HOME/.npm-global" ]]; then
  locations+=("$sys_prefix/lib/node_modules|npm remove -g --prefix $sys_prefix")
fi
# Pre-v0.16.4 bun-installed cfcf
if command -v bun >/dev/null 2>&1; then
  locations+=("$HOME/.bun/install/global/node_modules|bun remove -g")
fi

# For each location, check if cfcf is there + record what we'd run.
declare -a actions=()
declare -a action_descriptions=()
packages=("@cerefox/codefactory")
if [[ -n "$platform" ]]; then
  packages+=("@cerefox/codefactory-native-$platform")
fi

for entry in "${locations[@]}"; do
  lib_path="${entry%|*}"
  remove_cmd="${entry##*|}"
  if [[ -d "$lib_path/@cerefox/codefactory" ]]; then
    desc="$(echo "$lib_path" | sed "s|$HOME|~|")"
    action_descriptions+=("$desc → $remove_cmd ${packages[*]}")
    for pkg in "${packages[@]}"; do
      actions+=("$remove_cmd|$pkg")
    done
  fi
done

if [[ ${#actions[@]} -eq 0 ]]; then
  echo "[cfcf-uninstall] cfcf doesn't appear to be installed at any of the known locations:"
  echo "  • ~/.bun/lib/node_modules/@cerefox/codefactory          (v0.16.4+ canonical)"
  echo "  • ~/.npm-global/lib/node_modules/@cerefox/codefactory   (v0.16.4 earlier draft)"
  echo "  • npm system prefix /lib/node_modules/@cerefox/codefactory"
  echo "  • ~/.bun/install/global/node_modules/@cerefox/codefactory  (pre-v0.16.4 bun-install)"
  echo ""
  echo "If cfcf is installed elsewhere, remove it manually:"
  echo "  npm root -g           # find npm's global node_modules"
  echo "  bun pm -g ls          # list bun's global packages"
  exit 1
fi

cat <<EOF
[cfcf-uninstall] Found cfcf installed at:

EOF
for desc in "${action_descriptions[@]}"; do
  echo "  • $desc"
done

cat <<EOF

What this removes:
  - the cfcf CLI + its bundled JS (from each location above)
  - the per-platform @cerefox/codefactory-native-$platform package
  - transitive runtime deps not shared with another global package

What this does NOT remove (preserved on purpose):
  - ~/.cfcf/clio.db    -- your cross-workspace memory
  - ~/.cfcf/logs/      -- agent stdout/stderr archives
  - the cfcf config file (run \`cfcf config show --path\` BEFORE uninstall to find it)
  - cfcf-docs/ directories inside any workspace -- those are committed git artifacts
  - any sentinel-marked blocks in your shell rc; these are inert if cfcf is gone

EOF

if [[ -z "${CFCF_FORCE:-}" ]]; then
  read -r -p "Proceed? [y/N] " ans </dev/tty
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "[cfcf-uninstall] aborted."; exit 0 ;;
  esac
fi

# Run each remove. Failures are reported but don't abort.
for action in "${actions[@]}"; do
  cmd="${action%|*}"
  pkg="${action##*|}"
  echo "[cfcf-uninstall] $cmd $pkg"
  $cmd "$pkg" || echo "[cfcf-uninstall]   ($pkg wasn't installed at that location; continuing)"
done

echo ""
echo "[cfcf-uninstall] done."
echo "[cfcf-uninstall] If you also want to delete your data: rm -rf ~/.cfcf"
