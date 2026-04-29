/**
 * Product-Architect launcher (v2; Pattern A).
 *
 * Spawns the configured agent CLI (claude-code / codex) in interactive
 * mode in the user's current shell. The agent's TUI takes over until
 * the user exits.
 *
 * **Pattern A** (same as the Help Assistant):
 *   - claude-code: `--append-system-prompt "<text>"` + `--model <name>`
 *   - codex:       `-c model_instructions_file="<tempfile-path>"` (tempfile
 *                  cleaned up after the agent exits)
 *
 * v2 abandoned Pattern B (which v1 used: durable
 * `<repo>/cfcf-docs/{AGENTS,CLAUDE}.md` written via sentinel-merge +
 * `--cd cfcf-docs/`). Durability is now provided by the disk + Clio
 * memory model (see `<repo>/.cfcf-pa/`); the system prompt itself can
 * be ephemeral. Pattern A keeps PA aligned with HA's launcher seam.
 *
 * The launcher's responsibilities:
 *   1. Resolve the agent CLI binary
 *   2. Ensure `<repo>/.cfcf-pa/` exists (mkdir -p; idempotent)
 *      (the agent will write its scratchpad + memory cache there)
 *   3. Build per-adapter argv (Pattern A)
 *   4. Spawn with `--cd <repo>` (cwd is the user's repo root, NOT
 *      `.cfcf-pa/`, so the agent's bash tool operates relative to the
 *      repo for `problem-pack/` edits, `cfcf` commands, etc.)
 *   5. Wait for exit; clean up tempfile (codex only)
 *
 * Plan item 5.14 (v2). Design: docs/research/product-architect-design.md
 * §"System-prompt injection: Pattern A".
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAdapter } from "../adapters/index.js";
import type { AgentConfig } from "../types.js";

export interface LaunchOptions {
  /** Resolved Product Architect agent config (already backfilled by validateConfig). */
  agent: AgentConfig;
  /**
   * Repo path to operate on. PA's agent runs cd'd here; PA's local
   * cache lives at `<repoPath>/.cfcf-pa/`.
   */
  repoPath: string;
  /**
   * Full assembled system prompt. Composed by `assembleProductArchitectPrompt()`.
   */
  systemPrompt: string;
}

export interface LaunchResult {
  /** The shell command that was actually invoked (for logging/debug). */
  command: string;
  /** Args passed to the command, with sensitive bits redacted. */
  argsRedacted: string[];
  /** Process exit code, or null if the process was signalled. */
  exitCode: number | null;
  /** Path to `<repoPath>/.cfcf-pa/` (created by the launcher if missing). */
  paCachePath: string;
}

/**
 * Per-adapter argv builder. Pattern A: prompt is ephemeral (inline
 * flag for claude-code; tempfile for codex).
 */
export interface LaunchArgs {
  command: string;
  args: string[];
  /** Tempfile path the launcher must rm after the agent exits. Null when not used. */
  tempPromptFile: string | null;
}

export function buildLaunchArgs(agent: AgentConfig, systemPrompt: string): LaunchArgs {
  switch (agent.adapter) {
    case "claude-code": {
      // Interactive mode (no `-p` / `--prompt`). `--append-system-prompt`
      // adds PA's briefing on top of Claude Code's default system prompt.
      // No `--dangerously-skip-permissions`: the agent will prompt the
      // user for tool/file/bash use, which is the v1 permission model.
      //
      // Default to **Sonnet** for PA. Spec iteration is multi-turn
      // reasoning + judgement calls — benefits from a stronger model
      // than HA's Q&A workload (where Haiku is fine).
      const args: string[] = ["--append-system-prompt", systemPrompt];
      args.push("--model", agent.model ?? "sonnet");
      return { command: "claude", args, tempPromptFile: null };
    }
    case "codex": {
      // codex uses the `-c <key>=<value>` config override accepting the
      // `model_instructions_file` key. We write the prompt to a tempfile,
      // pass the path, and clean up after exit.
      //
      // codex defaults to `untrusted` approval policy interactively,
      // which prompts before every tool use — matches PA's permission
      // model (mutations are user-gated).
      const dir = mkdtempSync(join(tmpdir(), "cfcf-pa-"));
      const promptFile = join(dir, "pa-instructions.md");
      writeFileSync(promptFile, systemPrompt, "utf-8");

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
        `Product Architect doesn't support adapter "${agent.adapter}" yet. ` +
        `Supported: claude-code, codex. ` +
        `Set productArchitectAgent in your config (cfcf config edit) to one of those.`,
      );
  }
}

/**
 * Launch PA. Resolves the agent CLI, ensures `<repoPath>/.cfcf-pa/`
 * exists, builds argv, spawns the agent (inherit stdio so the TUI
 * takes over the current shell), waits for exit, cleans up the
 * tempfile (codex only).
 */
export async function launchProductArchitect(opts: LaunchOptions): Promise<LaunchResult> {
  const adapter = getAdapter(opts.agent.adapter);
  if (!adapter) {
    throw new Error(
      `Unknown agent adapter: "${opts.agent.adapter}". ` +
      `Run \`cfcf doctor\` to verify your install + supported agents.`,
    );
  }

  // Ensure <repoPath>/.cfcf-pa/ exists. Idempotent. The agent uses this
  // dir for its session scratchpad + workspace-summary cache + meta.json.
  const paCachePath = join(opts.repoPath, ".cfcf-pa");
  await mkdir(paCachePath, { recursive: true });

  const { command, args, tempPromptFile } = buildLaunchArgs(opts.agent, opts.systemPrompt);

  try {
    // Bun.spawn with inherit stdio: the agent's TUI takes over the
    // current shell until the user exits.
    //
    // cwd is the REPO ROOT — NOT `.cfcf-pa/`. The agent's bash tool
    // operates relative to the repo so `problem-pack/` edits, `cfcf`
    // commands, etc. work with simple relative paths.
    const proc = Bun.spawn([command, ...args], {
      cwd: opts.repoPath,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;

    // Redact the system prompt + tempfile path in logged args (could
    // be surfaced to telemetry / `--print-prompt` debug output).
    const argsRedacted = args.map((a, i) => {
      const flag = i > 0 ? args[i - 1] : "";
      if (flag === "--append-system-prompt") {
        return `<${a.length}-char system prompt redacted>`;
      }
      if (flag === "-c" && a.startsWith("model_instructions_file=")) {
        return `model_instructions_file=<tempfile redacted>`;
      }
      return a;
    });

    return {
      command,
      argsRedacted,
      exitCode: exitCode ?? null,
      paCachePath,
    };
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
