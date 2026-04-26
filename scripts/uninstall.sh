#!/usr/bin/env bash
#
# Remove a cfcf install.
#
# Usage:  uninstall.sh             (interactive, asks before deleting user data)
#         CFCF_FORCE=1 uninstall.sh   (no prompt; rm -rf and exit)
#
# Env:
#   CFCF_INSTALL_DIR   default: ~/.cfcf  (where the tarball was extracted)
#   CFCF_SYMLINK_DIR   default: /usr/local/bin (where the symlink lives)
#   CFCF_FORCE         if set, skip the interactive confirmation
#
# What gets removed:
#   - the symlink at $CFCF_SYMLINK_DIR/cfcf
#   - the entire $CFCF_INSTALL_DIR (binary, native libs, models cache,
#     clio.db, logs)
#
# What does NOT get removed:
#   - the platform-specific config dir (~/Library/Application Support/cfcf
#     on macOS, $XDG_CONFIG_HOME/cfcf on Linux). Run
#     `cfcf config show --path` BEFORE uninstall to find it; remove
#     manually if desired.
#   - any cfcf-docs/ inside your workspaces. Those are committed git
#     artifacts and are explicitly preserved.

set -euo pipefail

INSTALL_DIR="${CFCF_INSTALL_DIR:-$HOME/.cfcf}"
SYMLINK_DIR="${CFCF_SYMLINK_DIR:-/usr/local/bin}"
SYMLINK="$SYMLINK_DIR/cfcf"

# Refuse to delete obviously-wrong targets so a misset env var doesn't
# rm -rf $HOME or similar.
case "$INSTALL_DIR" in
  ""|"/"|"$HOME") echo "[cfcf-uninstall] refusing to operate on '$INSTALL_DIR'"; exit 1 ;;
esac

echo "[cfcf-uninstall] would remove:"
echo "  - $SYMLINK  (symlink, if present)"
echo "  - $INSTALL_DIR  (binary, native libs, embedder models, clio.db, logs)"
echo

if [[ -z "${CFCF_FORCE:-}" ]]; then
  read -r -p "Proceed? This deletes your local Clio DB + agent logs. [y/N] " ans </dev/tty
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "[cfcf-uninstall] aborted."; exit 0 ;;
  esac
fi

if [[ -L "$SYMLINK" || -e "$SYMLINK" ]]; then
  rm -f "$SYMLINK" 2>/dev/null || sudo rm -f "$SYMLINK"
  echo "[cfcf-uninstall] removed symlink $SYMLINK"
fi

if [[ -d "$INSTALL_DIR" ]]; then
  rm -rf "$INSTALL_DIR"
  echo "[cfcf-uninstall] removed $INSTALL_DIR"
fi

echo "[cfcf-uninstall] done."
echo "[cfcf-uninstall] Note: cfcf's config file at the platform-specific config dir was NOT removed."
echo "[cfcf-uninstall] Run 'cfcf config show --path' (before uninstalling) to find it; rm manually if desired."
