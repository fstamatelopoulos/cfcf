/**
 * Opencode CLI agent adapter (item 6.28).
 *
 * Opencode (sst.dev) is a Claude-Code-style terminal coding agent that
 * is provider-agnostic — it talks to whatever the user has authenticated
 * via `opencode auth login` (Anthropic API, OpenAI, OpenRouter, ollama,
 * etc.). cfcf doesn't see opencode's provider config, so the model
 * picker for this adapter shows just the "(adapter default)" + custom
 * sentinel options from 6.26 — the user types `provider/model`
 * (e.g. `anthropic/claude-3-5-sonnet`, `ollama/gemma4:31b`) per
 * opencode's CLI convention.
 *
 * Non-interactive mode: `opencode run [message..]`. There is no `-p` /
 * `--print` flag; that's a known incompatibility with the Claude Code
 * convention. Instruction filename is `AGENTS.md` (matches codex; opencode
 * also reads `CLAUDE.md` as a fallback per its docs).
 *
 * Why this adapter exists: Anthropic's harness policy (item 6.28
 * background; see `docs/decisions-log.md` 2026-05-07) makes Claude Code
 * subscription OAuth a poor fit for unattended cfcf roles. Opencode +
 * the user's own provider auth is one of the compliant paths.
 */

import type { AgentAdapter, AgentAvailability } from "../types.js";

export const opencodeAdapter: AgentAdapter = {
  name: "opencode",
  displayName: "Opencode",
  instructionFilename: "AGENTS.md",
  modelSource: "custom",

  async checkAvailability(): Promise<AgentAvailability> {
    try {
      const proc = Bun.spawn(["opencode", "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode === 0) {
        const stdout = await new Response(proc.stdout).text();
        const version = stdout.trim();
        return { available: true, version };
      }
      return { available: false, error: `opencode exited with code ${exitCode}` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { available: false, error: `Opencode CLI not found: ${message}` };
    }
  },

  unattendedFlags(): string[] {
    // `run` is the non-interactive subcommand; opencode doesn't ship a
    // dedicated "skip permissions" flag (its prompt-trust model is
    // upfront via `opencode auth login`).
    return ["run"];
  },

  buildCommand(
    workspacePath: string,
    prompt: string,
    model?: string,
  ): { command: string; args: string[] } {
    // opencode run [--model provider/model] "<prompt>"
    // Model expects the `provider/model` shape per opencode docs; cfcf
    // doesn't validate the shape (the user owns the provider auth side).
    const args: string[] = ["run"];
    if (model) {
      args.push("--model", model);
    }
    args.push(prompt);
    return { command: "opencode", args };
  },
};
