# cfcf Scripts

Development and testing utility scripts.

## setup-test-repos.sh

Creates two test repos at `/tmp/cfcf-calc` and `/tmp/cfcf-tracker` with problem-pack files copied from `problem-packs/`. Each repo has an initial commit with a README.

```bash
./scripts/setup-test-repos.sh
```

After running, register the projects with cfcf:
```bash
bun run dev:cli -- project init --repo /tmp/cfcf-calc --name calc
bun run dev:cli -- project init --repo /tmp/cfcf-tracker --name tracker
```

## cleanup-test-repos.sh

Removes all cfcf test state: test repos, project configs, loop state, and agent logs. Preserves the global cfcf config (`config.json` with agent/model settings).

```bash
./scripts/cleanup-test-repos.sh             # interactive (prompts for confirmation)
./scripts/cleanup-test-repos.sh --force     # skip confirmation
```
