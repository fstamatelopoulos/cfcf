/**
 * Ollama detection (item 6.28).
 *
 * Probes the local `ollama` CLI for installation status + locally-pulled
 * models. Used by:
 *   - `cfcf init` / `cfcf config edit` to decide whether to surface the
 *     `claude-code-ollama` and `opencode-ollama` adapters in role pickers.
 *   - The model picker for `*-ollama` adapters (sourced from `ollama list`
 *     instead of the `seed-models.ts` registry).
 *   - `cfcf doctor` for diagnostic display.
 *   - **Boot-time + on-demand refresh** (item 6.33) of the persisted
 *     `availableOllamaModels` list, so newly-pulled ollama models show up
 *     in the role-picker dropdowns without re-running `cfcf init --force`.
 *
 * Independent of the `AgentAdapter` interface because ollama isn't itself
 * a coding agent — it's a model server that the `*-ollama` adapters wrap
 * via the `ollama launch <agent>` subcommand. Detection sits alongside
 * `git --version` checks rather than in the adapter registry.
 */

import { readConfig, writeConfig } from "./config.js";

export interface OllamaAvailability {
  available: boolean;
  version?: string;
  error?: string;
}

/**
 * Run `ollama --version` and report whether the CLI is installed.
 * Does NOT check whether the daemon is running or any models are pulled —
 * those are concerns of the launch flow + `listOllamaModels()`.
 */
export async function detectOllama(): Promise<OllamaAvailability> {
  try {
    const proc = Bun.spawn(["ollama", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      const stdout = await new Response(proc.stdout).text();
      // ollama prints e.g. "ollama version is 0.15.4" — keep the whole line
      // so callers can decide how to display it. Trimmed for log cleanliness.
      const version = stdout.trim();
      return { available: true, version };
    }
    return { available: false, error: `ollama exited with code ${exitCode}` };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { available: false, error: `Ollama CLI not found: ${message}` };
  }
}

/**
 * Run `ollama list` and parse out the model names (first column).
 * Returns an empty array if ollama is not installed or no models are
 * pulled. Caller is responsible for surfacing the empty case to the user.
 *
 * Output format (ollama 0.15+):
 *   NAME                ID              SIZE      MODIFIED
 *   gemma4:31b          abc123def       18 GB     2 days ago
 *   qwen2.5-coder:32b   abc123def       19 GB     1 week ago
 *
 * We skip the header row and split on whitespace to grab the first column.
 * Defensive against header-only output (no models pulled) and against
 * future ollama versions that may add columns or change column ordering
 * (we only read the first column, which has been stable since v0.1).
 */
export async function listOllamaModels(): Promise<string[]> {
  try {
    const proc = Bun.spawn(["ollama", "list"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) return [];
    const stdout = await new Response(proc.stdout).text();
    const lines = stdout.trim().split("\n");
    if (lines.length <= 1) return []; // header only or empty
    const models: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const firstToken = line.split(/\s+/)[0];
      if (firstToken && firstToken !== "NAME") models.push(firstToken);
    }
    return models;
  } catch {
    return [];
  }
}

/**
 * Result of a refresh-ollama-models pass (item 6.33).
 *
 * `models`  — the live list from `ollama list` (empty when ollama isn't
 *             installed or no models are pulled).
 * `updated` — true iff the saved `availableOllamaModels` list differed
 *             from the live list and was rewritten. False when nothing
 *             changed (no disk write happened) OR when there's no global
 *             config to update.
 * `error`   — set when ollama isn't installed; not a fatal condition,
 *             just a hint for the caller's UX. Never thrown.
 */
export interface OllamaRefreshResult {
  models: string[];
  updated: boolean;
  error?: string;
}

/**
 * Compare two ollama-model lists for equality. Order-insensitive: a list
 * `["a", "b"]` matches `["b", "a"]` because `ollama list` doesn't
 * guarantee stable ordering across calls (sort-by-modified-time
 * shuffles the order whenever a model is pulled / used).
 */
function modelListsEqual(a: string[] | undefined, b: string[]): boolean {
  if (!Array.isArray(a)) return b.length === 0;
  if (a.length !== b.length) return false;
  const aSorted = [...a].sort();
  const bSorted = [...b].sort();
  for (let i = 0; i < aSorted.length; i++) {
    if (aSorted[i] !== bSorted[i]) return false;
  }
  return true;
}

/**
 * Detect ollama, list its models, and persist them to the global config's
 * `availableOllamaModels` field if the live list differs from what's
 * saved (item 6.33).
 *
 * Used by:
 *   - `start.ts` boot-time refresh — runs on every server start so
 *     newly-pulled ollama models propagate to role-picker dropdowns
 *     after a server restart.
 *   - `POST /api/agents/refresh-ollama-models` — hand-triggered from a
 *     "Refresh ollama models" button in the web UI Settings + workspace
 *     Config Agent-roles section, for the impatient "I just pulled a
 *     model and don't want to bounce the server" path.
 *
 * Best-effort. Never throws — every failure mode is reported via the
 * returned `error` field (and the boot-time caller swallows it
 * regardless). Specifically:
 *   - ollama not installed → returns `{ models: [], updated: false,
 *     error: "ollama not detected" }` and does NOT write to config.
 *   - ollama installed but no models pulled → live list is empty;
 *     overwrites the saved list with `[]` if it had entries (cleanup),
 *     or no-ops if already empty.
 *   - no global config → returns `{ models, updated: false }` without
 *     writing (caller can read the live list anyway).
 */
export async function refreshOllamaModelsInConfig(): Promise<OllamaRefreshResult> {
  const detection = await detectOllama();
  if (!detection.available) {
    return { models: [], updated: false, error: detection.error ?? "ollama not detected" };
  }
  const models = await listOllamaModels();
  const config = await readConfig();
  if (!config) {
    // No global config to update (pre-init). Live list is still useful
    // to the caller — return it without persisting.
    return { models, updated: false };
  }
  if (modelListsEqual(config.availableOllamaModels, models)) {
    return { models, updated: false };
  }
  config.availableOllamaModels = models.length > 0 ? models : undefined;
  await writeConfig(config);
  return { models, updated: true };
}
