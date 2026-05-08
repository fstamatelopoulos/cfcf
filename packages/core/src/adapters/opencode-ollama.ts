/**
 * Opencode via `ollama launch` adapter (item 6.28).
 *
 * Wraps opencode through ollama's `launch` subcommand so a local
 * ollama-served model drives the agent. Same compliance angle as
 * `claude-code-ollama.ts` — bypasses any provider's hosted API
 * entirely, runs against the user's local model server.
 *
 * Command shape:
 *   ollama launch opencode --model <local-model> --yes -- run "<prompt>"
 *
 * The `run` after `--` is opencode's non-interactive subcommand. The
 * model is configured by the launch wrapper (via opencode's provider
 * config files), so we do NOT pass a `--model provider/model` to
 * opencode after the `--` — ollama has already pointed opencode at
 * itself.
 *
 * Availability requires BOTH `ollama` AND `opencode` on PATH. Like
 * `claude-code-ollama`, the model picker is sourced from `ollama list`
 * at picker time (not from opencode's own provider config).
 */

import type { AgentAdapter, AgentAvailability } from "../types.js";

export const opencodeOllamaAdapter: AgentAdapter = {
  name: "opencode-ollama",
  displayName: "Opencode (via ollama)",
  instructionFilename: "AGENTS.md",
  modelSource: "ollama",

  async checkAvailability(): Promise<AgentAvailability> {
    const probeOllama = Bun.spawn(["ollama", "--version"], { stdout: "pipe", stderr: "pipe" });
    const probeOpencode = Bun.spawn(["opencode", "--version"], { stdout: "pipe", stderr: "pipe" });
    const [ollamaExit, opencodeExit] = await Promise.all([
      probeOllama.exited.catch(() => -1),
      probeOpencode.exited.catch(() => -1),
    ]);

    if (ollamaExit !== 0 && opencodeExit !== 0) {
      return { available: false, error: "neither ollama nor opencode CLI found on PATH" };
    }
    if (ollamaExit !== 0) {
      return { available: false, error: "ollama CLI not found on PATH" };
    }
    if (opencodeExit !== 0) {
      return { available: false, error: "opencode CLI not found on PATH" };
    }

    const [ollamaOut, opencodeOut] = await Promise.all([
      new Response(probeOllama.stdout).text(),
      new Response(probeOpencode.stdout).text(),
    ]);
    const version = `${ollamaOut.trim()} + ${opencodeOut.trim()}`;
    return { available: true, version };
  },

  unattendedFlags(): string[] {
    return ["launch", "opencode", "--yes", "--", "run", "--dangerously-skip-permissions"];
  },

  buildCommand(
    workspacePath: string,
    prompt: string,
    model?: string,
  ): { command: string; args: string[] } {
    // ollama launch opencode --model <local-model> --yes -- \
    //   run --dangerously-skip-permissions "<prompt>"
    // No --model passed to opencode after `--` — the launch wrapper has
    // configured the model side. `--dangerously-skip-permissions` is
    // required for the same reason as in `opencode.ts` (avoid the
    // permission-preset cancel-state in CI / harness contexts).
    const ollamaArgs: string[] = ["launch", "opencode"];
    if (model) {
      ollamaArgs.push("--model", model);
    }
    ollamaArgs.push("--yes", "--");

    const opencodeArgs: string[] = ["run", "--dangerously-skip-permissions", prompt];

    return { command: "ollama", args: [...ollamaArgs, ...opencodeArgs] };
  },
};
