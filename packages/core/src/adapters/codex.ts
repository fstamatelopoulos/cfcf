/**
 * Codex CLI agent adapter.
 *
 * Supports running OpenAI Codex CLI in non-interactive mode
 * with --approval-mode full-auto for unattended execution.
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
    return ["--approval-mode", "full-auto"];
  },

  buildCommand(
    workspacePath: string,
    prompt: string,
  ): { command: string; args: string[] } {
    return {
      command: "codex",
      args: ["--approval-mode", "full-auto", "-q", prompt],
    };
  },
};
