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
 *
 * Independent of the `AgentAdapter` interface because ollama isn't itself
 * a coding agent — it's a model server that the `*-ollama` adapters wrap
 * via the `ollama launch <agent>` subcommand. Detection sits alongside
 * `git --version` checks rather than in the adapter registry.
 */

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
