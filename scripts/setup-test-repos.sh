#!/usr/bin/env bash
#
# Setup test repos for cfcf experimentation.
#
# Creates two test repos with problem-packs copied from problem-packs/:
#   - /tmp/cfcf-calc       (calculator example, single iteration)
#   - /tmp/cfcf-tracker    (task-tracker example, multi-iteration)
#
# Each repo is initialized as a git repo with an initial commit containing
# a README. The problem-pack files are copied but NOT committed -- the user
# can decide whether to commit them before running cfcf.
#
# Usage:
#   ./scripts/setup-test-repos.sh
#
# After setup, register with cfcf:
#   bun run dev:cli -- project init --repo /tmp/cfcf-calc --name calc
#   bun run dev:cli -- project init --repo /tmp/cfcf-tracker --name tracker

set -euo pipefail

# Resolve script location so we can find problem-packs/ regardless of cwd
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PACKS_DIR="${REPO_ROOT}/problem-packs"

if [[ ! -d "${PACKS_DIR}" ]]; then
  echo "ERROR: problem-packs/ not found at ${PACKS_DIR}"
  exit 1
fi

create_repo() {
  local repo_path="$1"
  local pack_name="$2"
  local display_name="$3"

  if [[ -d "${repo_path}" ]]; then
    echo "WARN: ${repo_path} already exists. Skipping. Delete it first with cleanup-test-repos.sh"
    return
  fi

  if [[ ! -d "${PACKS_DIR}/${pack_name}" ]]; then
    echo "ERROR: problem-pack ${pack_name} not found at ${PACKS_DIR}/${pack_name}"
    return 1
  fi

  echo "=== Creating ${display_name} at ${repo_path} ==="
  mkdir -p "${repo_path}"
  cd "${repo_path}"

  git init -q
  git config user.email "test@cfcf.dev"
  git config user.name "cfcf test"

  cat > README.md <<EOF
# ${display_name}

Test repo for cfcf experimentation. Problem definition is in \`problem-pack/\`.

Created by \`scripts/setup-test-repos.sh\`.
EOF

  git add README.md
  git commit -q -m "initial"

  # Copy the problem-pack (into problem-pack/, the default cfcf expects)
  mkdir -p problem-pack
  cp "${PACKS_DIR}/${pack_name}/"*.md problem-pack/

  echo "  Repo: ${repo_path}"
  echo "  Initial commit created"
  echo "  Problem-pack files copied to ${repo_path}/problem-pack/"
  echo "  (not committed -- inspect and customize before running cfcf)"
  echo ""
}

echo "Setting up test repos for cfcf..."
echo ""

create_repo "/tmp/cfcf-calc" "calculator" "cfcf-calc"
create_repo "/tmp/cfcf-tracker" "task-tracker" "cfcf-tracker"

echo "Done."
echo ""
echo "Next steps:"
echo "  1. Make sure the cfcf server is running:"
echo "     bun run dev:server"
echo ""
echo "  2. Register the projects:"
echo "     bun run dev:cli -- project init --repo /tmp/cfcf-calc --name calc"
echo "     bun run dev:cli -- project init --repo /tmp/cfcf-tracker --name tracker"
echo ""
echo "  3. Open the web UI at http://localhost:7233"
