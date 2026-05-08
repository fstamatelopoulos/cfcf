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
    // `--output-format stream-json --verbose` emits live JSONL events
    // for each turn (system init, assistant text, tool calls, tool
    // results, final result). Without `stream-json`, claude `-p` buffers
    // stdout until the agent exits — silent log file for the entire run.
    // The Apr-17 commit (bb92921) added `--verbose` alone claiming it
    // gave live progress, but dogfooding 2026-05-08 against a 30B local
    // model proved verbose-only mode still buffers; only `stream-json`
    // actually streams. (See docs/decisions-log.md 2026-05-08.) The log
    // file becomes JSONL (one event per line); a future log-viewer
    // formatter can render the stream as readable text.
    const args = [
      "--dangerously-skip-permissions",
      "--verbose",
      "--output-format", "stream-json",
    ];
    if (model) {
      args.push("--model", model);
    }
    args.push("-p", prompt);
    return { command: "claude", args };
  },
};
