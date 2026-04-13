/**
 * Codex CLI agent adapter.
 *
 * Supports running OpenAI Codex CLI in non-interactive mode using `codex exec`.
 * Uses --full-auto for unattended execution (workspace-write sandbox + on-request approvals).
 *
 * Codex exec is the headless/non-interactive mode designed for CI and automation.
 * See: https://developers.openai.com/codex/noninteractive
 */

import type { AgentAdapter, AgentAvailability } from "../types.js";

export const codexAdapter: AgentAdapter = {
  name: "codex",
  displayName: "Codex CLI",
  instructionFilename: "AGENTS.md",

  async checkAvailability(): Promise<AgentAvailability> {
    try {
      const proc = Bun.spawn(["codex", "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode === 0) {
        const stdout = await new Response(proc.stdout).text();
        const version = stdout.trim();
        return { available: true, version };
      }
      return { available: false, error: `codex exited with code ${exitCode}` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        available: false,
        error: `Codex CLI not found: ${message}`,
      };
    }
  },

  unattendedFlags(): string[] {
    return ["-a", "never", "exec", "--full-auto"];
  },

  buildCommand(
    workspacePath: string,
    prompt: string,
    model?: string,
  ): { command: string; args: string[] } {
    // codex -a never exec --full-auto [--model <model>] "prompt"
    // -a never is a GLOBAL flag (must precede the subcommand)
    // --full-auto sets workspace-write sandbox
    const args = ["-a", "never", "exec", "--full-auto"];
    if (model) {
      args.push("--model", model);
    }
    args.push(prompt);
    return { command: "codex", args };
  },
};
