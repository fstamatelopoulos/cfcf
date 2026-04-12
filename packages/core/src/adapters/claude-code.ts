/**
 * Claude Code agent adapter.
 *
 * Supports running Claude Code CLI in non-interactive mode
 * with --dangerously-skip-permissions for unattended execution.
 */

import type { AgentAdapter, AgentAvailability } from "../types.js";

export const claudeCodeAdapter: AgentAdapter = {
  name: "claude-code",
  displayName: "Claude Code",

  async checkAvailability(): Promise<AgentAvailability> {
    try {
      const proc = Bun.spawn(["claude", "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode === 0) {
        const stdout = await new Response(proc.stdout).text();
        const version = stdout.trim();
        return { available: true, version };
      }
      return { available: false, error: `claude exited with code ${exitCode}` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        available: false,
        error: `Claude Code CLI not found: ${message}`,
      };
    }
  },

  unattendedFlags(): string[] {
    return ["--dangerously-skip-permissions"];
  },

  buildCommand(
    workspacePath: string,
    prompt: string,
  ): { command: string; args: string[] } {
    return {
      command: "claude",
      args: ["--dangerously-skip-permissions", "-p", prompt],
    };
  },
};
