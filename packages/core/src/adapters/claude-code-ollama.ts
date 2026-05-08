/**
 * Claude Code via `ollama launch` adapter (item 6.28).
 *
 * Wraps Claude Code's CLI through ollama's `launch` subcommand so the
 * user's local ollama-served model drives the agent — bypassing
 * Anthropic's subscription OAuth flow entirely. This is the recommended
 * compliant path for unattended cfcf roles (dev / judge / reflection /
 * documenter) when the user prefers Claude Code's UX over opencode's.
 *
 * Command shape (per ollama 0.15+ docs):
 *   ollama launch claude --model <local-model> --yes -- <claude-flags>
 *
 * The `--` separator is mandatory: arguments before it are parsed by
 * ollama, arguments after it are passed through to claude unchanged.
 * `--yes` skips ollama's interactive selectors (auto-pulls the model if
 * needed) — required for unattended execution.
 *
 * Auth: ollama implements the Anthropic Messages API surface locally
 * (via env vars `ANTHROPIC_AUTH_TOKEN=ollama` + `ANTHROPIC_BASE_URL=
 * http://localhost:11434` set by the launch wrapper), so no real
 * Anthropic API key or subscription OAuth is involved. cfcf doesn't
 * need to set those env vars itself — the launch subcommand handles it.
 *
 * Availability requires BOTH `ollama` AND `claude` on PATH. `ollama list`
 * also needs to return at least one local model for the picker to show
 * anything useful, but that's a UX gate at picker time, not an
 * adapter-level availability gate (a user might pull a model after
 * adapter detection ran).
 */

import type { AgentAdapter, AgentAvailability } from "../types.js";

type ProbeResult = { ok: true; version: string } | { ok: false };

async function probeBinary(bin: string): Promise<ProbeResult> {
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

export const claudeCodeOllamaAdapter: AgentAdapter = {
  name: "claude-code-ollama",
  displayName: "Claude Code (via ollama)",
  instructionFilename: "CLAUDE.md",
  modelSource: "ollama",

  async checkAvailability(): Promise<AgentAvailability> {
    // Both binaries must be present. We report the failure of whichever
    // is missing (or both), so the user sees a useful message.
    //
    // Note: `Bun.spawn` throws synchronously when the binary isn't on
    // PATH (ENOENT before the subprocess handle returns), so each probe
    // must be wrapped individually — `.exited.catch(...)` does not catch
    // that throw.
    const ollamaProbe = await probeBinary("ollama");
    const claudeProbe = await probeBinary("claude");

    if (!ollamaProbe.ok && !claudeProbe.ok) {
      return { available: false, error: "neither ollama nor claude CLI found on PATH" };
    }
    if (!ollamaProbe.ok) {
      return { available: false, error: "ollama CLI not found on PATH" };
    }
    if (!claudeProbe.ok) {
      return { available: false, error: "claude CLI not found on PATH" };
    }

    const version = `${ollamaProbe.version} + ${claudeProbe.version}`;
    return { available: true, version };
  },

  unattendedFlags(): string[] {
    // The flags ollama parses + the flags after `--` (passed to claude).
    // Surfaced for the permission-acknowledgement display in `cfcf init`.
    return ["launch", "claude", "--yes", "--", "--dangerously-skip-permissions"];
  },

  buildCommand(
    workspacePath: string,
    prompt: string,
    model?: string,
  ): { command: string; args: string[] } {
    // ollama launch claude --model <local-model> --yes -- \
    //   --dangerously-skip-permissions -p "<prompt>"
    //
    // The `--yes` is mandatory for unattended runs (skips interactive
    // selector prompts ollama would otherwise show). The `--` separator
    // is mandatory per ollama docs. `model` here is an ollama-side model
    // (e.g. `gemma4:31b`), NOT an Anthropic model name — claude itself
    // doesn't see this; it's how ollama picks which local model to load
    // and translate Anthropic-shape requests against.
    //
    // Pass-through flags mirror `claude-code.ts` (kept in sync). See
    // that adapter's docstring for the history of `--verbose` /
    // `--output-format stream-json` experiments; both reverted
    // 2026-05-08 in favour of plain `-p` for the readable-log UX
    // (decisions-log 2026-05-08).
    const ollamaArgs: string[] = ["launch", "claude"];
    if (model) {
      ollamaArgs.push("--model", model);
    }
    ollamaArgs.push("--yes", "--");

    const claudeArgs: string[] = ["--dangerously-skip-permissions"];
    claudeArgs.push("-p", prompt);

    return { command: "ollama", args: [...ollamaArgs, ...claudeArgs] };
  },
};
