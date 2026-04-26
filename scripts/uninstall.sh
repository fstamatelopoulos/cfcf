#!/usr/bin/env bash
#
# Uninstall cfcf.
#
# Per docs/research/installer-design.md §3.3 + §4. The npm-format install
# shape means uninstalling cfcf itself is a one-liner: `bun remove -g
# @cerefox/cfcf-cli`. Per-platform native package + transitive runtime
# deps come along for free. User data (`~/.cfcf/clio.db`, `~/.cfcf/logs/`,
# platform config dir, workspace `cfcf-docs/`) is intentionally NOT
# touched -- removing those is a separate manual decision.
#
# Usage:  uninstall.sh             (interactive, prints what stays + asks)
#         CFCF_FORCE=1 uninstall.sh   (no prompt; just runs bun remove)

set -euo pipefail

if ! command -v bun >/dev/null 2>&1; then
  echo "[cfcf-uninstall] Bun not found on PATH. cfcf is installed via Bun's"
  echo "[cfcf-uninstall] global package manager; install Bun to remove it,"
  echo "[cfcf-uninstall] or run: rm -rf \"\$HOME/.bun/install/global/node_modules/@cerefox/cfcf-cli\""
  exit 1
fi

cat <<'EOF'
[cfcf-uninstall] About to run: bun remove -g @cerefox/cfcf-cli

What this removes:
  - the cfcf CLI + its bundled JS
  - the per-platform @cerefox/cfcf-native-<platform> package
  - the runtime deps (@huggingface/transformers, onnxruntime-node, sharp)

What this does NOT remove (preserved on purpose):
  - ~/.cfcf/clio.db    -- your cross-workspace memory
  - ~/.cfcf/logs/      -- agent stdout/stderr archives
  - the cfcf config file (run `cfcf config show --path` BEFORE uninstall to find it)
  - cfcf-docs/ directories inside any workspace -- those are committed git artifacts

EOF

if [[ -z "${CFCF_FORCE:-}" ]]; then
  read -r -p "Proceed? [y/N] " ans </dev/tty
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "[cfcf-uninstall] aborted."; exit 0 ;;
  esac
fi

bun remove -g @cerefox/cfcf-cli
echo "[cfcf-uninstall] done."
echo "[cfcf-uninstall] If you also want to delete your data: rm -rf ~/.cfcf"
