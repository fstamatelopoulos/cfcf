#!/usr/bin/env bash
#
# Cleanup ALL cfcf test state.
#
# This removes:
#   - Test repos at /tmp/cfcf-calc, /tmp/cfcf-tracker (and legacy /tmp/cfcf-test-repo, /tmp/cfcf-task-tracker, /tmp/cfcf-web-test)
#   - cfcf project configs and loop state (~/Library/Application Support/cfcf/projects/)
#   - cfcf agent logs (~/.cfcf/logs/)
#
# This does NOT touch:
#   - Your cfcf dev repo (~/src/cfcf)
#   - The global cfcf config file (agents, models, etc.) at ~/Library/Application Support/cfcf/config.json
#
# Prompts for confirmation before deleting anything.
#
# Usage:
#   ./scripts/cleanup-test-repos.sh            # interactive
#   ./scripts/cleanup-test-repos.sh --force    # skip confirmation

set -euo pipefail

FORCE=false
if [[ "${1:-}" == "--force" ]]; then
  FORCE=true
fi

# Platform-specific config dir
if [[ "$(uname)" == "Darwin" ]]; then
  CONFIG_DIR="${HOME}/Library/Application Support/cfcf"
else
  CONFIG_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/cfcf"
fi

PROJECTS_DIR="${CONFIG_DIR}/projects"
LOGS_DIR="${HOME}/.cfcf/logs"

# Test repo locations (current + legacy)
REPOS=(
  "/tmp/cfcf-calc"
  "/tmp/cfcf-tracker"
  "/tmp/cfcf-test-repo"
  "/tmp/cfcf-task-tracker"
  "/tmp/cfcf-web-test"
)

echo "cfcf test cleanup"
echo "================="
echo ""
echo "This will delete the following (if they exist):"
echo ""
for r in "${REPOS[@]}"; do
  if [[ -d "${r}" ]]; then
    echo "  [repo]    ${r}"
  fi
done
if [[ -d "${PROJECTS_DIR}" ]] && [[ -n "$(ls -A "${PROJECTS_DIR}" 2>/dev/null)" ]]; then
  echo "  [configs] ${PROJECTS_DIR}/*"
fi
if [[ -d "${LOGS_DIR}" ]] && [[ -n "$(ls -A "${LOGS_DIR}" 2>/dev/null)" ]]; then
  echo "  [logs]    ${LOGS_DIR}/*"
fi
echo ""
echo "Will PRESERVE:"
echo "  ${CONFIG_DIR}/config.json (global cfcf config)"
echo ""

if [[ "${FORCE}" == "false" ]]; then
  read -p "Continue? [yes/no]: " answer
  if [[ "${answer}" != "yes" && "${answer}" != "y" ]]; then
    echo "Cancelled."
    exit 0
  fi
fi

echo ""
echo "Cleaning up..."

# Delete test repos
for r in "${REPOS[@]}"; do
  if [[ -d "${r}" ]]; then
    rm -rf "${r}"
    echo "  Removed ${r}"
  fi
done

# Delete project configs/state
if [[ -d "${PROJECTS_DIR}" ]]; then
  rm -rf "${PROJECTS_DIR}"
  mkdir -p "${PROJECTS_DIR}"
  echo "  Cleared ${PROJECTS_DIR}"
fi

# Delete logs
if [[ -d "${LOGS_DIR}" ]]; then
  rm -rf "${LOGS_DIR}"
  mkdir -p "${LOGS_DIR}"
  echo "  Cleared ${LOGS_DIR}"
fi

echo ""
echo "Done."
echo ""
echo "The global cfcf config (agents, models) at ${CONFIG_DIR}/config.json"
echo "was preserved. If you want to reset that too, run 'cfcf init --force'."
