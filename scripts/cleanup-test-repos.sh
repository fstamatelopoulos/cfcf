#!/usr/bin/env bash
#
# Cleanup cfcf TEST projects only.
#
# Deletes:
#   - Test repos under /tmp/cfcf-* (only paths matching this pattern)
#   - Projects whose repoPath is under /tmp/cfcf-* (from cfcf config)
#   - Logs for those specific projects
#
# PRESERVES:
#   - Your cfcf dev repo (~/src/cfcf)
#   - All OTHER cfcf projects (including ones with repoPath elsewhere)
#   - Global cfcf config (agents, models)
#   - Logs for projects that aren't being deleted
#
# If the cfcf server is running, projects are deleted via DELETE /api/projects/:id
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

PROJECTS_DIR="${CONFIG_DIR}/projects"
LOGS_DIR="${HOME}/.cfcf/logs"
PORT="${CFCF_PORT:-7233}"

# Test repo prefix -- only repos/projects matching this pattern are touched
TEST_REPO_PREFIX="/tmp/cfcf-"

# --- Discovery ---

echo "cfcf test cleanup"
echo "================="
echo ""
echo "Scope: only projects whose repoPath starts with '${TEST_REPO_PREFIX}'"
echo ""

# Find test repos on disk
TEST_REPOS=()
for r in "${TEST_REPO_PREFIX}"*; do
  if [[ -d "${r}" ]]; then
    TEST_REPOS+=("${r}")
  fi
done

# Find test projects in cfcf config (those with repoPath under /tmp/cfcf-*)
TEST_PROJECT_IDS=()
TEST_PROJECT_NAMES=()
if [[ -d "${PROJECTS_DIR}" ]]; then
  for pdir in "${PROJECTS_DIR}"/*/; do
    [[ -d "${pdir}" ]] || continue
    config_file="${pdir}config.json"
    [[ -f "${config_file}" ]] || continue
    # Extract repoPath (naive but adequate for our JSON shape)
    repo_path=$(grep -oE '"repoPath":[[:space:]]*"[^"]*"' "${config_file}" | sed 's/.*"repoPath":[[:space:]]*"\([^"]*\)".*/\1/' || true)
    proj_id=$(basename "${pdir%/}")
    proj_name=$(grep -oE '"name":[[:space:]]*"[^"]*"' "${config_file}" | head -1 | sed 's/.*"name":[[:space:]]*"\([^"]*\)".*/\1/' || true)
    if [[ "${repo_path}" == ${TEST_REPO_PREFIX}* ]]; then
      TEST_PROJECT_IDS+=("${proj_id}")
      TEST_PROJECT_NAMES+=("${proj_name}")
    fi
  done
fi

# --- Report ---

if [[ ${#TEST_REPOS[@]} -eq 0 && ${#TEST_PROJECT_IDS[@]} -eq 0 ]]; then
  echo "Nothing to clean up -- no test repos or projects found."
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
if [[ ${#TEST_PROJECT_IDS[@]} -gt 0 ]]; then
  echo "cfcf projects:"
  for i in "${!TEST_PROJECT_IDS[@]}"; do
    echo "  [project] ${TEST_PROJECT_NAMES[$i]} (${TEST_PROJECT_IDS[$i]})"
    if [[ -d "${LOGS_DIR}/${TEST_PROJECT_IDS[$i]}" ]]; then
      echo "  [logs]    ${LOGS_DIR}/${TEST_PROJECT_IDS[$i]}"
    fi
  done
  echo ""
fi

echo "Will PRESERVE:"
echo "  - Global cfcf config (${CONFIG_DIR}/config.json)"
echo "  - Any projects whose repoPath is NOT under ${TEST_REPO_PREFIX}"
echo "  - Logs for preserved projects"
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

# Delete projects (via API if available, then file fallback)
for i in "${!TEST_PROJECT_IDS[@]}"; do
  pid="${TEST_PROJECT_IDS[$i]}"
  pname="${TEST_PROJECT_NAMES[$i]}"
  if [[ "${server_up}" == "true" ]]; then
    curl -s -X DELETE "http://localhost:${PORT}/api/projects/${pid}" >/dev/null 2>&1 || true
  fi
  # Safety net: direct removal of the project config dir
  rm -rf "${PROJECTS_DIR}/${pid}"
  echo "  Deleted project: ${pname} (${pid})"

  # Delete this project's logs
  if [[ -d "${LOGS_DIR}/${pid}" ]]; then
    rm -rf "${LOGS_DIR}/${pid}"
    echo "    Removed logs for ${pid}"
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
