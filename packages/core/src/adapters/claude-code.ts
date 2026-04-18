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
  instructionFilename: "CLAUDE.md",

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
    model?: string,
  ): { command: string; args: string[] } {
    // --verbose gives live turn-by-turn text output (so the user can watch
    // progress in the log). Without it, Claude Code in print mode is silent
    // until the final response. Matches Codex's verbose-by-default behavior
    // for consistency across agents.
    const args = ["--dangerously-skip-permissions", "--verbose"];
    if (model) {
      args.push("--model", model);
    }
    args.push("-p", prompt);
    return { command: "claude", args };
  },
};
