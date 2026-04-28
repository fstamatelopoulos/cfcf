# cfcf Troubleshooting

This page covers common cfcf issues and how to fix them. **First stop**: run `cfcf doctor` — it checks your install across 13+ dimensions (Bun runtime, native libs, agent CLIs, Clio DB, shell completion wiring, …) and emits an actionable hint for anything that's off.

When in doubt, the install can usually be repaired by running the installer again — it's idempotent and dedups its own state.

---

## Tab completion doesn't work

Symptoms: `cfcf <TAB>` does nothing, or completes file/folder names instead of cfcf verbs.

### Diagnosis

```bash
cfcf doctor | grep -A 1 "Shell tab completion"
```

`✓ Shell tab completion` means everything's wired; the issue is shell-side caching (jump to fix #3).

`⚠ Shell tab completion` with a hint tells you which check failed. Three common cases:

### Fix #1: rc-file edit missing

```bash
grep "cfcf shell completion" ~/.zshrc      # zsh
grep "cfcf-completion.bash" ~/.bashrc       # bash
```

If empty → the `cfcf completion install` step didn't run (or ran with `--no-rc-edit`). Re-run:

```bash
cfcf completion install
exec zsh    # or `exec bash`
```

This appends a sentinel-marked block to your rc file. cfcf only modifies content **between** the `# >>> cfcf shell completion` and `# <<< cfcf shell completion` markers; the rest is untouched.

### Fix #2: completion script missing

```bash
ls -la ~/.zsh/completions/_cfcf       # zsh
ls -la ~/.cfcf-completion.bash         # bash
```

If missing → run `cfcf completion install` (writes the script + the rc-file edit in one go).

### Fix #3: stale compinit cache (zsh only)

zsh caches its completion table in `~/.zcompdump*`. After a cfcf upgrade adds new verbs, the cache may serve the old verb tree until you invalidate it.

```bash
rm -f ~/.zcompdump*
exec zsh
```

This is the standard "shells got weird, force-reload" dance — same fix as for `brew upgrade git` etc. Not cfcf-specific.

### Fix #4: shell isn't bash or zsh

cfcf ships completion for bash + zsh only. fish is tracked as a future addition; PowerShell isn't planned.

If `echo $SHELL` reports `/usr/bin/fish` or similar, `cfcf completion install` is a no-op and `cfcf doctor` reports `unsupported shell`. You can still use cfcf, just without tab-complete.

---

## `cfcf server` won't start

### Symptom: "address already in use"

Something else is on port `7233`:

```bash
lsof -i :7233               # what's listening
cfcf server stop            # if it's an old cfcf instance
cfcf server start
```

If a non-cfcf process is on `7233`, change the port:

```bash
CFCF_PORT=7234 cfcf server start
```

(Any subsequent CLI commands need the same env var, or you can edit `~/.cfcf/config.json`'s `port` key.)

### Symptom: stops responding mid-run

`cfcf server status` and confirm it's reporting healthy. Long-running iterations can keep the server's main loop busy; the API stays responsive but the **iteration phase indicator** in the web UI may lag. Wait for the current iteration to commit, then check again.

If it's genuinely hung:

```bash
cfcf server stop
cfcf server start
```

The server is stateless across restarts — workspaces, iterations, Clio, history are all on disk. You won't lose progress.

### Symptom: server starts but `cfcf init` says "already configured"

That's expected if you've run `cfcf init` before. Use `cfcf init --force` to reconfigure. Existing config is read as the base; per-role agent picks default to your previous selections, embedder picker defaults to your previous preferred embedder.

---

## `cfcf init` fails

### "Bun not found" / "command not found: bun"

cfcf requires Bun ≥ 1.3. The installer should have set this up; if it didn't:

```bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun --version       # should report >= 1.3
```

Then re-run `cfcf init`.

### "agent CLI not found: claude-code" (or codex)

You picked an agent during init that isn't on your `$PATH`. Two options:

**Install the agent CLI** (Anthropic's `claude-code` or OpenAI's `codex`):

```bash
# claude-code
npm install -g @anthropic-ai/claude-code   # or follow Anthropic's installer
which claude-code

# codex
npm install -g @openai/codex                # or follow OpenAI's installer
which codex
```

**Or pick the other one** — re-run `cfcf init --force` and choose differently.

### `cfcf init` fails to download the embedder

`cfcf init` downloads the default embedder (`nomic-embed-text-v1.5`, ~280 MB) from HuggingFace. If the download fails:

- **Network issue.** Retry: `cfcf clio embedder install`. The download resumes; partial files are cleaned up automatically.
- **Disk full.** The embedder caches to `~/.cfcf/models/<embedder-name>/`. `df -h ~` to check.
- **Behind a corporate proxy.** Set `HTTPS_PROXY` and `HTTP_PROXY` env vars before `cfcf clio embedder install`.

**You don't have to pick the default.** During `cfcf init` you can press Enter to skip the embedder; cfcf falls back to FTS-only search (no semantic / hybrid). Install one later via `cfcf clio embedder install` when you're ready, or pick a different one from the catalogue (`cfcf clio embedder list`).

---

## Iteration stuck or agent timeout

### Symptom: `cfcf run` is paused at "iteration N: dev" for a long time

Each iteration has a per-role timeout (default: 30 minutes for dev). Check what the agent is doing:

- **Web UI**: `http://127.0.0.1:7233/#/workspaces/<id>` shows the current phase + elapsed time.
- **Live logs**: `tail -f ~/.cfcf/logs/<workspace-name>/<latest>/dev.stdout`.

If the agent is producing output, it's working — wait. If the log has been silent for >5 min, the agent may be stuck:

```bash
cfcf stop --workspace <name>      # graceful: signal current iteration to abort
cfcf resume --workspace <name>    # pick up at the next iteration
```

`cfcf stop` waits up to 30 seconds for a clean shutdown. The killed iteration's git changes are reset (the iteration's commit doesn't land); the next iteration starts fresh.

### Symptom: iteration commits but judge says FAILURE every time

Three things to check:

1. **Re-read your `success.md`.** Are the success criteria objectively measurable? Vague criteria ("the code is clean") are hard for the judge.
2. **Run `cfcf reflect --workspace <name> --prompt "what's blocking SUCCESS?"`.** Reflection's job is exactly this — it'll either spot the gap or recommend stopping.
3. **Run `cfcf review --workspace <name>`** to put the Solution Architect on it. The architect can rewrite `cfcf-docs/plan.md` (within the non-destructive-rewrite rules) to course-correct.

### Symptom: `recommend_stop` from reflection

That's reflection saying it doesn't think more iterations will help. Don't override it without thought — it's usually right. Read the latest `cfcf-docs/reflection-reviews/reflection-N.md` for the analysis. Then either:

- Refine the Problem Pack (often the actual problem)
- Run `cfcf review` to get the architect's assessment
- Accept the partial result and stop the loop

---

## Clio issues

### Clio search returns nothing

```bash
cfcf clio stats
```

Check `documentCount`. If zero, nothing's been ingested yet. cfcf auto-ingests reflection analyses + decision-log entries + iteration summaries during the loop, so a fresh workspace won't have searchable content until it's run a few iterations.

If documentCount > 0 but search still returns nothing:

- **Wrong project scope?** `cfcf clio search "<query>" --project <name>` — without `--project`, search defaults to all Projects, but if you set `clio.defaultSearchMode` per-project that may filter. `cfcf clio docs list` shows which Projects have docs.
- **Wrong mode?** Try `cfcf clio search "<query>" --mode fts` — falls back to keyword-only if the embedder is misbehaving.
- **Min-score too high?** `--min-score 0` to disable the cosine-similarity floor.

### `cfcf clio search` is slow

The default backend is brute-force cosine scan in TypeScript. For corpora >50k chunks, latency starts to matter. Tracked in [plan item 6.15](../plan.md) — sqlite-vec HNSW integration. Until then:

- Filter by `--project <name>` to narrow the candidate pool
- Use `--mode fts` (FTS5 is sub-millisecond regardless of corpus size)

### "Embedder switched, search broken"

You used `cfcf clio embedder set <new>` without `--reindex` and the existing chunks were embedded under the old model. Vector search now scores against incompatible embeddings.

```bash
cfcf clio reindex          # re-embeds every chunk under the active embedder
```

This is idempotent and safe to run anytime. cfcf doctor reports this as a `chunksOverNewCeiling` warning when relevant.

To prevent: always pass `--reindex` to `embedder set` (the prompt reminds you).

---

## `bun install -g` warnings

### "warn: Duplicate key '@cerefox/cfcf-cli' in object literal"

Known Bun bug: `bun install -g <local-tarball>` appends duplicate keys to `~/.bun/install/global/{package.json,bun.lock}` instead of overwriting. Functionally harmless (last-occurrence wins on parse) but produces screens of warnings.

cfcf's installer (`scripts/install.sh` and `cfcf self-update`) auto-dedups these files before AND after each `bun install -g`. If you're seeing accumulated dups from before this fix landed, run the installer once and the dedup will clean them up:

```bash
cfcf self-update
```

You can verify:
```bash
cfcf doctor | grep "Bun global"
```

### "Node.js 20 is deprecated. … forced to run on Node.js 24"

Expected, harmless. cfcf sets `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true` in its GitHub Actions workflows so third-party actions (which still declare `using: 'node20'`) run on Node 24. The warning is GitHub's reminder to those action authors to update their declarations; it doesn't affect cfcf's behaviour.

This warning will go away when `actions/upload-artifact@v6` etc. ship with `using: 'node24'` natively. Out of cfcf's control.

---

## Shell-framework interactions

### oh-my-zsh / prezto / starship

These frameworks generally play nicely with cfcf's completion. Both `oh-my-zsh` and `prezto` set up `compinit` for you, and they expand `$fpath` automatically. cfcf's sentinel block (which adds `~/.zsh/completions` to `fpath` and runs `compinit`) is appended at the end of your `~/.zshrc`, so it runs **after** the framework's setup — same `fpath` array, just with cfcf's path added.

If completion still doesn't fire after `cfcf completion install` + `exec zsh`:

1. **Order of fpath**: `print -l $fpath | head` — does `~/.zsh/completions` appear? If not, the framework may be resetting fpath after cfcf's block. Move cfcf's block above the framework's source line in `~/.zshrc` (delete + re-create with `cfcf completion install`).
2. **Framework's compinit was already cached**: same fix as the standalone case — `rm ~/.zcompdump*; exec zsh`.
3. **Framework rebuilds compinit on a custom schedule**: prezto's `zstyle ':prezto:module:completion' 'sync' 'yes'` forces a refresh on every shell start; without it, the framework caches harder than vanilla zsh.

### Shell-managed package versions (asdf / mise / fnm)

If you use one of these to manage Bun, make sure the cfcf-installed `bun` is the same as the one cfcf uses to install itself. `which bun` should match `cfcf doctor`'s "Bun runtime" line. Mismatches usually surface as "command not found: cfcf" after install (cfcf was installed under a different Bun's prefix).

---

## Worst case: clean reinstall

If something's broken in a way none of the above fixes, you can fully reset cfcf without losing your workspaces or Clio data (those live outside the install):

```bash
# 1. Stop the server
cfcf server stop

# 2. Uninstall completion (optional)
cfcf completion uninstall

# 3. Remove the global package
bun remove -g @cerefox/cfcf-cli
bun remove -g @cerefox/cfcf-native-darwin-arm64    # or your platform

# 4. (optional) wipe the install state -- leaves your data alone
rm -rf ~/.bun/install/global/{package.json,bun.lock,node_modules}

# 5. Reinstall
curl -fsSL https://github.com/fstamatelopoulos/cfcf-releases/releases/latest/download/install.sh | bash
```

Your data stays:
- `~/.cfcf/config.json` — global config
- `~/.cfcf/clio.db` — Clio knowledge base (preserve this!)
- `~/.cfcf/models/` — downloaded embedders
- `~/.cfcf/logs/` — iteration logs (size grows; safe to clean periodically)
- `~/.cfcf/workspaces/<id>/` — per-workspace state

Per-repo state is in your git repo's `cfcf-docs/` directory and survives anything you do at the install layer.

---

## Still stuck?

1. **Check the plan**: [`../plan.md`](../plan.md) — your issue may be a known limitation tracked there
2. **Check decisions log**: [`../decisions-log.md`](../decisions-log.md) — explanations of non-obvious choices
3. **GitHub issues**: file one with the output of `cfcf doctor --json` attached. The doctor output contains everything we need for triage and is sanitised (no secrets, no PII).
