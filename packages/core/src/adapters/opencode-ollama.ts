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

type ProbeResult = { ok: true; version: string } | { ok: false };

async function probeBinary(bin: string): Promise<ProbeResult> {
  // Pre-check with Bun.which to avoid the noisy ENOENT message Bun
  // prints to its own stderr when spawn is given a missing binary
  // (see claude-code-ollama.ts for context).
  if (!Bun.which(bin)) return { ok: false };
  try {
    const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
    const exit = await proc.exited;
    if (exit !== 0) return { ok: false };
    const out = await new Response(proc.stdout).text();
    return { ok: true, version: out.trim() };
  } catch {
    return { ok: false };
  }
}

export const opencodeOllamaAdapter: AgentAdapter = {
  name: "opencode-ollama",
  displayName: "Opencode (via ollama)",
  instructionFilename: "AGENTS.md",
  modelSource: "ollama",

  async checkAvailability(): Promise<AgentAvailability> {
    // `Bun.spawn` throws synchronously on missing binaries — must wrap
    // each probe individually (see claude-code-ollama.ts for context).
    const ollamaProbe = await probeBinary("ollama");
    const opencodeProbe = await probeBinary("opencode");

    if (!ollamaProbe.ok && !opencodeProbe.ok) {
      return { available: false, error: "neither ollama nor opencode CLI found on PATH" };
    }
    if (!ollamaProbe.ok) {
      return { available: false, error: "ollama CLI not found on PATH" };
    }
    if (!opencodeProbe.ok) {
      return { available: false, error: "opencode CLI not found on PATH" };
    }

    const version = `${ollamaProbe.version} + ${opencodeProbe.version}`;
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
