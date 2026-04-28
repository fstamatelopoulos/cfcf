/**
 * Help-Assistant launcher.
 *
 * Spawns the configured agent CLI (claude-code / codex) in interactive
 * mode in the user's current shell, with the assembled system prompt +
 * the agent's per-command permission mode enabled. Inherits stdio so
 * the agent's TUI takes over until the user exits.
 *
 * Best-effort: failures (agent CLI missing, spawn errors, etc.) bubble
 * up so the CLI command can print a clear error + actionable hint.
 *
 * Plan item 5.8 PR4. See `docs/research/help-assistant.md`.
 */

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
 * Implemented per agent adapter rather than via the existing
 * AgentAdapter.buildCommand (which is shaped for non-interactive
 * iteration runs with --dangerously-skip-permissions). The HA needs
 * the OPPOSITE: interactive + always-prompt-for-mutations.
 */
export function buildLaunchArgs(agent: AgentConfig, systemPrompt: string): { command: string; args: string[] } {
  switch (agent.adapter) {
    case "claude-code": {
      // Interactive mode (no `-p` / `--prompt`); --append-system-prompt
      // adds our HA briefing on top of Claude Code's default system
      // prompt. NO --dangerously-skip-permissions: the agent will
      // prompt the user for tool/file/bash use, which is the v1
      // permission model we want.
      const args: string[] = ["--append-system-prompt", systemPrompt];
      if (agent.model) {
        args.push("--model", agent.model);
      }
      return { command: "claude", args };
    }
    case "codex": {
      // codex v1 doesn't expose a system-prompt CLI flag. The path to
      // inject one is via ~/.codex/config.toml's
      // `experimental_instructions_file` -- a config-file mutation,
      // not a one-line CLI flag like claude-code's
      // `--append-system-prompt`. For HA v1 we bail with a clear
      // hint: configure HA to use claude-code (or wait for codex HA
      // support in iter-6 once we've worked out the config-file
      // approach + cleanup-on-exit semantics).
      throw new Error(
        "Help Assistant doesn't yet support the codex agent (codex's CLI " +
        "has no --system-prompt flag; injecting via ~/.codex/config.toml " +
        "is iter-6 work). Workaround: configure HA to use claude-code " +
        "via `cfcf config edit` (look for 'Help Assistant agent'), " +
        "or pass `--agent claude-code` per-call.",
      );
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
 * Launch the HA. Resolves the agent CLI binary, builds argv, spawns
 * the process with inherit stdio, and waits for exit. Returns the
 * exit code so the caller can propagate it.
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

  const { command, args } = buildLaunchArgs(opts.agent, opts.systemPrompt);

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
  // output) without leaking the full prompt.
  const argsRedacted = args.map((a, i) => {
    const flag = i > 0 ? args[i - 1] : "";
    if (flag === "--append-system-prompt" || flag === "--system-prompt") {
      return `<${a.length}-char system prompt redacted>`;
    }
    return a;
  });

  return { command, argsRedacted, exitCode: exitCode ?? null };
}
