/**
 * Help-Assistant launcher.
 *
 * Spawns the configured agent CLI (claude-code / codex) in interactive
 * mode in the user's current shell, with the assembled system prompt +
 * the agent's per-command permission mode enabled. Inherits stdio so
 * the agent's TUI takes over until the user exits.
 *
 * Per-agent system-prompt injection (researched empirically 2026-04-28):
 *
 *   claude-code -- has a direct CLI flag, --append-system-prompt <text>,
 *     that takes the prompt inline. Used directly.
 *
 *   codex -- doesn't have a system-prompt flag in `codex --help`, but
 *     the generic `-c <key>=<value>` config override accepts the
 *     `model_instructions_file` key (formerly `experimental_instructions_
 *     file`, still accepted with a deprecation warning). We write the
 *     prompt to a tempfile, pass the path via -c, and clean up the
 *     tempfile on exit.
 *
 *   Both agents also auto-load CLAUDE.md / AGENTS.md from the cwd, but
 *     using those as carriers would either pollute the user's repo or
 *     require running the agent from a tempdir (losing the user's actual
 *     cwd context for diagnostics). The path-via-config-override pattern
 *     is cleaner.
 *
 * Best-effort: failures (agent CLI missing, spawn errors, tempfile
 * cleanup) bubble up so the CLI command can print a clear error + a
 * actionable hint.
 *
 * Plan item 5.8 PR4. See `docs/research/help-assistant.md`.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAdapter } from "../adapters/index.js";
import type { AgentConfig } from "../types.js";

export interface LaunchOptions {
  /** Resolved Help Assistant agent config (already backfilled by validateConfig). */
  agent: AgentConfig;
  /** Full assembled system prompt (output of assembleHelpAssistantPrompt). */
  systemPrompt: string;
  /**
   * Working directory for the agent. Defaults to process.cwd() so the
   * agent sees whichever repo the user invoked from. Override only for
   * tests / alternate launch contexts.
   */
  cwd?: string;
}

export interface LaunchResult {
  /** The shell command that was actually invoked (for logging/debug). */
  command: string;
  /** Args passed to the command, with the system prompt redacted. */
  argsRedacted: string[];
  /** Process exit code, or null if the process was signalled. */
  exitCode: number | null;
}

/**
 * Build the argv that runs the configured agent CLI in HA mode:
 * interactive, with a system prompt, and with per-command permission
 * prompts enabled (no auto-approval).
 *
 * Returns the argv plus, when applicable, the tempfile path the
 * launcher should clean up after the session exits (codex path).
 * claude-code passes the prompt inline so there's no tempfile.
 *
 * Implemented per agent adapter rather than via the existing
 * AgentAdapter.buildCommand (which is shaped for non-interactive
 * iteration runs with --dangerously-skip-permissions). The HA needs
 * the OPPOSITE: interactive + always-prompt-for-mutations.
 */
export interface LaunchArgs {
  command: string;
  args: string[];
  /** Tempfile path the launcher must rm after the agent exits. Null if not used. */
  tempPromptFile: string | null;
}

export function buildLaunchArgs(agent: AgentConfig, systemPrompt: string): LaunchArgs {
  switch (agent.adapter) {
    case "claude-code": {
      // Interactive mode (no `-p` / `--prompt`); --append-system-prompt
      // adds our HA briefing on top of Claude Code's default system
      // prompt. NO --dangerously-skip-permissions: the agent will
      // prompt the user for tool/file/bash use, which is the v1
      // permission model we want.
      //
      // Default to Haiku for HA. The HA workload is interactive Q&A
      // ("how do I X?", "explain Y") -- doesn't benefit from a
      // top-tier model + Haiku is ~10x faster + ~12x cheaper than
      // Sonnet. Power users can override via config.helpAssistantAgent
      // or `--agent`-flow tweaks. (Codex has a similar concept via
      // its in-session `/fast` command; see codex case below.)
      const args: string[] = ["--append-system-prompt", systemPrompt];
      args.push("--model", agent.model ?? "haiku");
      return { command: "claude", args, tempPromptFile: null };
    }
    case "codex": {
      // codex doesn't expose a direct system-prompt CLI flag, but its
      // generic `-c <key>=<value>` config override accepts the
      // `model_instructions_file` key (replaces the deprecated
      // `experimental_instructions_file`; still works but warns). We
      // write the prompt to a tempfile and pass the path. The launcher
      // cleans up the tempfile after the agent exits.
      //
      // Why not use ~/.codex/AGENTS.md or cwd-AGENTS.md instead? Both
      // would either pollute the user's repo or require running the
      // agent from a tempdir (losing the user's cwd context for
      // diagnostics). Path-via-config-override is the cleanest.
      const dir = mkdtempSync(join(tmpdir(), "cfcf-ha-"));
      const promptFile = join(dir, "ha-instructions.md");
      writeFileSync(promptFile, systemPrompt, "utf-8");

      // Codex defaults to `untrusted` approval policy interactively,
      // which prompts before any tool use. That matches v1's HA
      // permission model (read-only by default, mutations gated).
      const args: string[] = [
        "-c", `model_instructions_file="${promptFile.replace(/"/g, '\\"')}"`,
      ];
      if (agent.model) {
        args.push("--model", agent.model);
      }
      return { command: "codex", args, tempPromptFile: promptFile };
    }
    default:
      throw new Error(
        `Help Assistant doesn't support adapter "${agent.adapter}" yet. ` +
        `Supported: claude-code, codex. ` +
        `Set helpAssistantAgent in your config (cfcf config edit) to one of those.`,
      );
  }
}

/**
 * Launch the HA. Resolves the agent CLI binary, builds argv (writing a
 * tempfile if the agent needs the system prompt as a file), spawns
 * the process with inherit stdio, and waits for exit. Returns the
 * exit code so the caller can propagate it.
 *
 * Tempfile (codex path) is cleaned up in a finally block, even if the
 * spawn throws or the user Ctrl-C's mid-session.
 *
 * Throws if the agent adapter is unknown. If the agent CLI is missing
 * from PATH, the spawn fails and the error message points the user at
 * `cfcf doctor` (where the HA-prerequisites check runs).
 */
export async function launchHelpAssistant(opts: LaunchOptions): Promise<LaunchResult> {
  const adapter = getAdapter(opts.agent.adapter);
  if (!adapter) {
    throw new Error(
      `Unknown agent adapter: "${opts.agent.adapter}". ` +
      `Run \`cfcf doctor\` to verify your install + supported agents.`,
    );
  }

  const { command, args, tempPromptFile } = buildLaunchArgs(opts.agent, opts.systemPrompt);

  try {
    // Bun.spawn with inherit stdio: the agent's TUI takes over the
    // current shell until the user exits.
    const proc = Bun.spawn([command, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;

    // Redact the system prompt in the logged args so the launch result
    // can be safely surfaced (e.g. to telemetry / `--print-prompt`
    // output) without leaking the full prompt. claude-code embeds the
    // full prompt inline; codex passes a tempfile path -- both get
    // redacted to avoid leaking the prompt OR the temp path.
    const argsRedacted = args.map((a, i) => {
      const flag = i > 0 ? args[i - 1] : "";
      if (flag === "--append-system-prompt" || flag === "--system-prompt") {
        return `<${a.length}-char system prompt redacted>`;
      }
      if (flag === "-c" && a.startsWith("model_instructions_file=")) {
        return `model_instructions_file=<tempfile redacted>`;
      }
      return a;
    });

    return { command, argsRedacted, exitCode: exitCode ?? null };
  } finally {
    // Best-effort tempfile cleanup. Done in finally so a Ctrl-C, spawn
    // error, or non-zero exit code doesn't leave state in /tmp.
    if (tempPromptFile) {
      try {
        const dir = tempPromptFile.replace(/\/[^/]+$/, "");
        rmSync(dir, { recursive: true, force: true });
      } catch { /* best-effort */ }
    }
  }
}
