# cf² Troubleshooting

This page covers common cf² issues and how to fix them. **First stop**: run `cfcf doctor` — it checks your install across 13+ dimensions (Bun runtime, native libs, agent CLIs, Clio DB, shell completion wiring, …) and emits an actionable hint for anything that's off.

When in doubt, the install can usually be repaired by running the installer again — it's idempotent and dedups its own state.

---

## Tab completion doesn't work

Symptoms: `cfcf <TAB>` does nothing, or completes file/folder names instead of cf² verbs.

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

This appends a sentinel-marked block to your rc file. cf² only modifies content **between** the `# >>> cfcf shell completion` and `# <<< cfcf shell completion` markers; the rest is untouched.

### Fix #2: completion script missing

```bash
ls -la ~/.zsh/completions/_cfcf       # zsh
ls -la ~/.cfcf-completion.bash         # bash
```

If missing → run `cfcf completion install` (writes the script + the rc-file edit in one go).

### Fix #3: stale compinit cache (zsh only)

zsh caches its completion table in `~/.zcompdump*`. After a cf² upgrade adds new verbs, the cache may serve the old verb tree until you invalidate it.

```bash
rm -f ~/.zcompdump*
exec zsh
```

This is the standard "shells got weird, force-reload" dance — same fix as for `brew upgrade git` etc. Not cf²-specific.

### Fix #4: shell isn't bash or zsh

cf² ships completion for bash + zsh only. fish is tracked as a future addition; PowerShell isn't planned.

If `echo $SHELL` reports `/usr/bin/fish` or similar, `cfcf completion install` is a no-op and `cfcf doctor` reports `unsupported shell`. You can still use cf², just without tab-complete.

---

## `cfcf server` won't start

### Symptom: "address already in use"

Something else is on port `7233`:

```bash
lsof -i :7233               # what's listening
cfcf server stop            # if it's an old cfcf instance
cfcf server start
```

If a non-cf² process is on `7233`, change the port:

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

cf² requires Bun ≥ 1.3. The installer should have set this up; if it didn't:

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

Check `documentCount`. If zero, nothing's been ingested yet. cf² auto-ingests reflection analyses + decision-log entries + iteration summaries during the loop, so a fresh workspace won't have searchable content until it's run a few iterations.

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

## Product Architect (`cfcf spec`) issues

### PA reports "cfcf server is not running" but it IS running

Symptom: in the PA session the agent reports the server is down, but `cfcf server status` from another terminal shows it running.

Cause: you're in `--safe` mode AND you're using codex. Codex's default sandbox (`workspace-write`) blocks loopback/`127.0.0.1` in many configurations, so `cfcf server status` from inside the agent's bash tool can't reach the server.

Fix:
- Drop `--safe` for normal sessions. PA's default mode (no flag) uses `sandbox_mode=danger-full-access`, which lifts the loopback restriction. Localhost-targeting cfcf CLI commands work from inside the agent.
- Or trust the State Assessment in PA's prompt — cfcf computed it from outside any sandbox before launching the agent, so it's authoritative. PA should defer to that when there's a conflict.

### PA's Memory Inventory says "no workspace memory" but I had a session yesterday

Symptom: you ran PA before, decisions were made, but the new session's prompt shows the per-workspace memory section as empty.

Cause: pre-fix, the agent's `cfcf clio docs ingest` may have auto-routed to the `default` Clio Project (because `cfcf-memory-pa` didn't exist). cfcf's reader was project-scoped to `cfcf-memory-pa`, so it missed the orphaned doc.

Fix: this should resolve on its own with cfcf v0.x.x and later — the launcher pre-creates `cfcf-memory-pa` + `cfcf-memory-global` Clio Projects, and the reader now searches by metadata (project-agnostic). If you have an old orphaned doc, find it:

```bash
cfcf clio metadata search --filter '{"role":"pa","artifact_type":"workspace-memory"}'
```

If a doc shows up under `project: default`, the next PA session will find it via metadata search regardless of project, and you can ask PA to resync it to the right project. Or migrate it manually:

```bash
cfcf clio docs edit <id> --project cfcf-memory-pa
```

### Session ended without saving (Ctrl-D)

Symptom: PA was helpful but you closed the terminal without responding to the "save before you go?" prompt.

Don't worry — disk session log at `<repo>/.cfcf-pa/session-<id>.md` is preserved (PA writes turn-by-turn, not just on save). On the next `cfcf spec` launch:

- The State Assessment will detect the unsaved disk file
- PA will offer to push it to Clio as a `pa-session-<id>` archive doc + update the digest
- No data loss

If you want to manually inspect what's there: `cat <repo>/.cfcf-pa/session-<id>.md`.

### PA opens to an empty TUI / doesn't introduce itself

Expected behavior is for PA to greet you immediately on launch (Flavour A: agent CLI's positional `[PROMPT]` is set to a self-introduce message). If you instead see a blank prompt waiting for input:

- Make sure you're on the latest cfcf — `cfcf --version`
- Some agent CLI versions may not honour positional prompts in interactive mode. Type "Please run your session-start protocol" or just "hello" — PA will pick up from there.

### "I see local PA memory not synced to Clio — want me to push it now?"

This is intentional behavior, not a bug. PA detected a discrepancy between the Clio digest and your local `.cfcf-pa/workspace-summary.md`. Most often it's the Ctrl-D recovery path (last session wrote disk but didn't push to Clio). Just say yes — PA will sync them and you're caught up.

---

## Install issues

### `cfcf` not found after running `install.sh`

If you ran `install.sh` and it completed successfully but `cfcf init` returns "command not found", your shell hasn't picked up the new PATH yet. cfcf installs to `~/.bun/bin/cfcf`, and `~/.bun/bin` is added to your shell rc by Bun's installer — but rc files only re-source on new shell startup. Fix:

```bash
source ~/.zshrc       # or 'source ~/.bashrc'
# OR open a new terminal window/tab
cfcf init
```

This is a one-time step (the same one Bun's official `curl bun.sh/install | bash` requires). It only happens if Bun was just installed by `install.sh` for the first time on this machine.

### `npm install -g @cerefox/codefactory` (without `--prefix ~/.bun`) fails with `EACCES`

The direct command in our docs uses `--prefix ~/.bun` specifically to avoid this. If you ran the bare `npm install -g @cerefox/codefactory` (no `--prefix`), npm tries to install to its default global prefix (often `/usr/local/`, root-owned on stock Node installations) and fails with `EACCES`. Two fixes:

```bash
# Option A (recommended): use the --prefix ~/.bun flag (matches install.sh)
npm install -g --prefix ~/.bun @cerefox/codefactory

# Option B: configure a user-writable npm prefix once + retry
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
exec $SHELL
npm install -g @cerefox/codefactory
```

Option A is simpler + doesn't touch your global npm config. Option B is the npm-documented fix ([Resolving EACCES permissions errors](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally)) if you want a permanent user-writable prefix for all your `npm install -g` operations.

### "Blocked N postinstalls" after `bun install -g`

If you used `bun install -g @cerefox/codefactory` instead of npm, Bun blocks the postinstall scripts of three packages by default:

- `@cerefox/codefactory` (runs `cfcf completion install`)
- `onnxruntime-node` (downloads platform-specific `.node` runtime binaries)
- `protobufjs` (generates serializer stubs onnxruntime depends on)

Without those running, Clio's embedder breaks at runtime. cfcf's published `package.json` declares `trustedDependencies: ["onnxruntime-node", "protobufjs"]`, but Bun's transitive-trust handling is incomplete ([oven-sh/bun#4959](https://github.com/oven-sh/bun/issues/4959)) so it doesn't fully take effect for global installs yet. Two paths forward:

**Recommended**: switch to the npm path (no postinstall blocking):

```bash
bun remove -g @cerefox/codefactory
npm install -g @cerefox/codefactory
```

**If you genuinely prefer bun-only**: grant explicit, named trust to the three packages (no `--all` — you're inspecting + consenting per-package):

```bash
bun pm -g trust @cerefox/codefactory onnxruntime-node protobufjs
cfcf completion install   # the now-allowed postinstall content
cfcf doctor               # verify everything wired up
```

This will become unnecessary once oven-sh/bun#4959 lands upstream; cfcf's manifest is already declaring the right dependencies.

## `bun install -g` warnings

### "warn: Duplicate key '@cerefox/codefactory' in object literal"

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

Expected, harmless. cf² sets `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true` in its GitHub Actions workflows so third-party actions (which still declare `using: 'node20'`) run on Node 24. The warning is GitHub's reminder to those action authors to update their declarations; it doesn't affect cf²'s behaviour.

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

If something's broken in a way none of the above fixes, you can fully reset cf² without losing your workspaces or Clio data (those live outside the install):

```bash
# 1. Stop the server
cfcf server stop

# 2. Uninstall completion (optional)
cfcf completion uninstall

# 3. Remove the global package
bun remove -g @cerefox/codefactory
bun remove -g @cerefox/codefactory-native-darwin-arm64    # or your platform

# 4. (optional) wipe the install state -- leaves your data alone
rm -rf ~/.bun/install/global/{package.json,bun.lock,node_modules}

# 5. Reinstall
bun install -g @cerefox/codefactory
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
