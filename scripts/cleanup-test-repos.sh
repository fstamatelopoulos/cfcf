#!/usr/bin/env bash
#
# Cleanup cfcf TEST workspaces only.
#
# Deletes:
#   - Test repos under /tmp/cfcf-* (only paths matching this pattern)
#   - Workspaces whose repoPath is under /tmp/cfcf-* (from cfcf config)
#   - Logs for those specific workspaces
#
# PRESERVES:
#   - Your cfcf dev repo (~/src/cfcf)
#   - All OTHER cfcf workspaces (including ones with repoPath elsewhere)
#   - Global cfcf config (agents, models)
#   - Logs for workspaces that aren't being deleted
#
# If the cfcf server is running, workspaces are deleted via DELETE /api/workspaces/:id
# so the server can clean up in-memory state. Falls back to direct file removal.
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

WORKSPACES_DIR="${CONFIG_DIR}/workspaces"
LOGS_DIR="${HOME}/.cfcf/logs"
PORT="${CFCF_PORT:-7233}"

# Test repo prefix -- only repos/workspaces matching this pattern are touched
TEST_REPO_PREFIX="/tmp/cfcf-"

# --- Discovery ---

echo "cfcf test cleanup"
echo "================="
echo ""
echo "Scope: only workspaces whose repoPath starts with '${TEST_REPO_PREFIX}'"
echo ""

# Find test repos on disk
TEST_REPOS=()
for r in "${TEST_REPO_PREFIX}"*; do
  if [[ -d "${r}" ]]; then
    TEST_REPOS+=("${r}")
  fi
done

# Find test workspaces in cfcf config (those with repoPath under /tmp/cfcf-*)
TEST_WORKSPACE_IDS=()
TEST_WORKSPACE_NAMES=()
if [[ -d "${WORKSPACES_DIR}" ]]; then
  for wdir in "${WORKSPACES_DIR}"/*/; do
    [[ -d "${wdir}" ]] || continue
    config_file="${wdir}config.json"
    [[ -f "${config_file}" ]] || continue
    # Extract repoPath (naive but adequate for our JSON shape)
    repo_path=$(grep -oE '"repoPath":[[:space:]]*"[^"]*"' "${config_file}" | sed 's/.*"repoPath":[[:space:]]*"\([^"]*\)".*/\1/' || true)
    ws_id=$(basename "${wdir%/}")
    ws_name=$(grep -oE '"name":[[:space:]]*"[^"]*"' "${config_file}" | head -1 | sed 's/.*"name":[[:space:]]*"\([^"]*\)".*/\1/' || true)
    if [[ "${repo_path}" == ${TEST_REPO_PREFIX}* ]]; then
      TEST_WORKSPACE_IDS+=("${ws_id}")
      TEST_WORKSPACE_NAMES+=("${ws_name}")
    fi
  done
fi

# --- Report ---

if [[ ${#TEST_REPOS[@]} -eq 0 && ${#TEST_WORKSPACE_IDS[@]} -eq 0 ]]; then
  echo "Nothing to clean up -- no test repos or workspaces found."
  exit 0
fi

echo "Will delete the following:"
echo ""
if [[ ${#TEST_REPOS[@]} -gt 0 ]]; then
  echo "Test repos:"
  for r in "${TEST_REPOS[@]}"; do
    echo "  [repo] ${r}"
  done
  echo ""
fi
if [[ ${#TEST_WORKSPACE_IDS[@]} -gt 0 ]]; then
  echo "cfcf workspaces:"
  for i in "${!TEST_WORKSPACE_IDS[@]}"; do
    echo "  [workspace] ${TEST_WORKSPACE_NAMES[$i]} (${TEST_WORKSPACE_IDS[$i]})"
    if [[ -d "${LOGS_DIR}/${TEST_WORKSPACE_IDS[$i]}" ]]; then
      echo "  [logs]      ${LOGS_DIR}/${TEST_WORKSPACE_IDS[$i]}"
    fi
  done
  echo ""
fi

echo "Will PRESERVE:"
echo "  - Global cfcf config (${CONFIG_DIR}/config.json)"
echo "  - Any workspaces whose repoPath is NOT under ${TEST_REPO_PREFIX}"
echo "  - Logs for preserved workspaces"
echo ""

if [[ "${FORCE}" == "false" ]]; then
  read -p "Continue? [yes/no]: " answer
  if [[ "${answer}" != "yes" && "${answer}" != "y" ]]; then
    echo "Cancelled."
    exit 0
  fi
fi

# --- Cleanup ---

echo ""
echo "Cleaning up..."

# Check if server is up
server_up=false
if curl -s -f -o /dev/null --max-time 2 "http://localhost:${PORT}/api/health" 2>/dev/null; then
  server_up=true
fi

# Delete workspaces (via API if available, then file fallback)
for i in "${!TEST_WORKSPACE_IDS[@]}"; do
  wid="${TEST_WORKSPACE_IDS[$i]}"
  wname="${TEST_WORKSPACE_NAMES[$i]}"
  if [[ "${server_up}" == "true" ]]; then
    curl -s -X DELETE "http://localhost:${PORT}/api/workspaces/${wid}" >/dev/null 2>&1 || true
  fi
  # Safety net: direct removal of the workspace config dir
  rm -rf "${WORKSPACES_DIR}/${wid}"
  echo "  Deleted workspace: ${wname} (${wid})"

  # Delete this workspace's logs
  if [[ -d "${LOGS_DIR}/${wid}" ]]; then
    rm -rf "${LOGS_DIR}/${wid}"
    echo "    Removed logs for ${wid}"
  fi
done

# Delete test repos
for r in "${TEST_REPOS[@]}"; do
  rm -rf "${r}"
  echo "  Removed repo: ${r}"
done

echo ""
echo "Done."
echo ""
echo "Preserved global config at ${CONFIG_DIR}/config.json"
