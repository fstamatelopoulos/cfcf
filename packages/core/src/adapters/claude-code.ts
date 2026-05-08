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
    // Plain `claude -p "<prompt>"` — claude buffers stdout and emits
    // the final response when the agent finishes. No live progress in
    // the log file during the run.
    //
    // History: Apr-17 commit `bb92921` added `--verbose` claiming it
    // gave live progress; dogfooding 2026-05-08 disproved that claim
    // (verbose-only still buffers). Then 2026-05-08 added
    // `--output-format stream-json` which DOES stream live events as
    // JSONL — but the JSONL log file was unreadable in the web UI
    // log panel + hard to scan with `tail`. User feedback: revert to
    // plain `-p` and accept the silence-during-run trade-off until
    // we have a proper JSONL→text formatter for the log viewer.
    // See docs/decisions-log.md 2026-05-08.
    const args = ["--dangerously-skip-permissions"];
    if (model) {
      args.push("--model", model);
    }
    args.push("-p", prompt);
    return { command: "claude", args };
  },
};
