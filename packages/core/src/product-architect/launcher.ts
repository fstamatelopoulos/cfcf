/**
 * Product-Architect launcher (Pattern B).
 *
 * Spawns the configured agent CLI (claude-code / codex) in interactive
 * mode in the user's current shell. Where HA uses Pattern A (system
 * prompt as ephemeral CLI flag / tempfile), PA uses Pattern B:
 *
 *   1. Resolve `<repo>/cfcf-docs/` (PA requires it to exist; if not,
 *      the caller should either run `cfcf workspace init` first or
 *      pass through `--bootstrap` -- v1 just errors with a hint).
 *   2. Write/refresh sentinel-marked `cfcf-docs/AGENTS.md` (codex)
 *      + `cfcf-docs/CLAUDE.md` (claude-code) carrying the PA briefing.
 *   3. Spawn the agent with `--cd <repo>/cfcf-docs/` so each CLI
 *      auto-loads its respective briefing as the deepest-scope file.
 *
 * Why Pattern B for PA?
 *   - PA writes to the user's repo (the four Problem Pack files), so
 *     it can't be permission-gated like HA. Mutation is its job.
 *   - PA's context is durable across sessions (multi-day spec
 *     iteration). Pattern A's tempfile would lose continuity.
 *   - Both agent CLIs auto-load AGENTS.md/CLAUDE.md from cwd, so
 *     `--cd cfcf-docs/` is the natural seam.
 *
 * Plan item 5.14. See `docs/research/product-architect.md`
 * §"Architecture".
 */
import { rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { getAdapter } from "../adapters/index.js";
import type { AgentConfig } from "../types.js";
import { writeBriefingFiles } from "./briefing-files.js";

export interface LaunchOptions {
  /**
   * Resolved Product Architect agent config (already backfilled by
   * validateConfig).
   */
  agent: AgentConfig;
  /**
   * Repo path to operate on. PA writes its briefing to
   * `<repoPath>/cfcf-docs/{AGENTS,CLAUDE}.md` and cd's the agent into
   * that subdir so the auto-load picks the briefing up.
   */
  repoPath: string;
  /**
   * Full assembled system prompt (output of
   * assembleProductArchitectPrompt). Becomes the cf²-owned body of the
   * AGENTS.md/CLAUDE.md briefing files.
   */
  systemPrompt: string;
  /**
   * Optional positional task hint -- if the user invoked
   * `cfcf help architect "Refactor the success criteria for the auth
   * flow"`, that string flows here. Some agents accept a positional
   * `[PROMPT]` arg as the opening message; for v1 we surface it INSIDE
   * the system prompt (assembled before this launcher runs) rather than
   * relying on adapter-specific positional plumbing.
   */
  initialTask?: string;
  /**
   * Version stamp recorded in the briefing files (visible to humans
   * inspecting the cf²-owned block). Defaults to a UTC ISO string at
   * launch time.
   */
  versionStamp?: string;
}

export interface LaunchResult {
  /** The shell command that was actually invoked (for logging/debug). */
  command: string;
  /** Args passed to the command, with sensitive bits redacted. */
  argsRedacted: string[];
  /** Process exit code, or null if the process was signalled. */
  exitCode: number | null;
  /** Briefing files written this launch. */
  briefingFilesWritten: string[];
}

/**
 * Result of preparing argv for the configured adapter (no spawn, no
 * tempfile cleanup -- just the bytes that go to Bun.spawn).
 *
 * Pattern B doesn't need a tempfile (the briefing lives in the repo's
 * cfcf-docs/, not in /tmp), so this is simpler than HA's LaunchArgs.
 */
export interface LaunchArgs {
  command: string;
  args: string[];
  /** Working directory for the spawn -- always `<repo>/cfcf-docs/`. */
  cwd: string;
}

/**
 * Build argv that runs the configured agent CLI in PA mode:
 * interactive, cd'd to `<repo>/cfcf-docs/` so the auto-loaded
 * AGENTS.md/CLAUDE.md is the PA briefing, and with per-command
 * permission prompts enabled (no auto-approval).
 */
export function buildLaunchArgs(agent: AgentConfig, repoPath: string): LaunchArgs {
  const cwd = join(repoPath, "cfcf-docs");
  switch (agent.adapter) {
    case "claude-code": {
      // No --append-system-prompt this time: the briefing comes from
      // CLAUDE.md auto-load. NO --dangerously-skip-permissions: PA
      // mutates the user's repo, so per-command permission prompts
      // are the v1 safety story.
      //
      // Default to Sonnet for PA. Spec iteration is multi-turn
      // reasoning + judgement calls -- benefits from a stronger model
      // than HA's Q&A workload (where Haiku is fine). Codex is
      // account-tied so we don't force a model on it; users can
      // switch mid-session via /fast or /full.
      const args: string[] = [];
      args.push("--model", agent.model ?? "sonnet");
      return { command: "claude", args, cwd };
    }
    case "codex": {
      // Codex reads AGENTS.md from cwd at session start. Default
      // approval mode is `untrusted`, which prompts before every tool
      // use -- the v1 PA permission story.
      const args: string[] = [];
      if (agent.model) {
        args.push("--model", agent.model);
      }
      return { command: "codex", args, cwd };
    }
    default:
      throw new Error(
        `Product Architect doesn't support adapter "${agent.adapter}" yet. ` +
        `Supported: claude-code, codex. ` +
        `Set helpArchitectAgent in your config (cfcf config edit) to one of those.`,
      );
  }
}

/**
 * Verify that `<repoPath>/cfcf-docs/` exists. If not, throw with a
 * hint pointing at `cfcf workspace init`. v1 doesn't ship --bootstrap
 * mode, so the error nudges the user to run init themselves.
 *
 * Future iteration: --bootstrap can branch here to Pattern A (no
 * cfcf-docs/ yet, fall back to a tempfile briefing) until the user
 * agrees to create the workspace.
 */
async function ensureCfcfDocsExists(repoPath: string): Promise<string> {
  const cfcfDocsPath = join(repoPath, "cfcf-docs");
  try {
    const s = await stat(cfcfDocsPath);
    if (!s.isDirectory()) {
      throw new Error(
        `${cfcfDocsPath} exists but is not a directory. ` +
        `Move it aside, then run \`cfcf workspace init\` to bootstrap a clean cfcf-docs/.`,
      );
    }
    return cfcfDocsPath;
  } catch (err) {
    if (err instanceof Error && /exists but is not a directory/.test(err.message)) {
      throw err;
    }
    throw new Error(
      `${cfcfDocsPath} doesn't exist yet. The Product Architect needs cfcf-docs/ ` +
      `to anchor its briefing files (Pattern B). To bootstrap a fresh project, run ` +
      `\`cfcf workspace init\` first, then re-run \`cfcf help architect\`. ` +
      `(--bootstrap mode that lets PA do this for you is on the v2 roadmap.)`,
    );
  }
}

/**
 * Launch the PA. Verifies cfcf-docs/ exists, writes the briefing
 * files, builds argv, spawns the agent CLI with inherit stdio, and
 * waits for exit.
 *
 * The briefing files are NOT cleaned up after the session -- they're
 * durable per the Pattern B design. Re-running PA refreshes them
 * inside the sentinel block; user content outside the markers is
 * preserved.
 *
 * Throws if the agent adapter is unknown or cfcf-docs/ doesn't exist.
 */
export async function launchProductArchitect(opts: LaunchOptions): Promise<LaunchResult> {
  const adapter = getAdapter(opts.agent.adapter);
  if (!adapter) {
    throw new Error(
      `Unknown agent adapter: "${opts.agent.adapter}". ` +
      `Run \`cfcf doctor\` to verify your install + supported agents.`,
    );
  }

  const cfcfDocsPath = await ensureCfcfDocsExists(opts.repoPath);

  // Write/refresh the briefing files BEFORE spawning so the auto-load
  // picks up the latest. The merge logic preserves user content outside
  // the cf² sentinel block.
  const briefingFilesWritten = await writeBriefingFiles(cfcfDocsPath, {
    systemPrompt: opts.systemPrompt,
    versionStamp: opts.versionStamp ?? new Date().toISOString(),
  });

  const { command, args, cwd } = buildLaunchArgs(opts.agent, opts.repoPath);

  // Bun.spawn with inherit stdio: the agent's TUI takes over the
  // current shell until the user exits. We don't wrap with a try/
  // finally to clean up briefing files -- they're durable.
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;

  // No sensitive args in PA's argv (no system prompt inline, no
  // tempfile path). Pass through verbatim so debug/telemetry can show
  // exactly what was run.
  const argsRedacted = [...args];

  return {
    command,
    argsRedacted,
    exitCode: exitCode ?? null,
    briefingFilesWritten,
  };
}

/**
 * Internal helper: tests use this to remove briefing files between
 * runs. NOT exported from the package index -- production code should
 * not delete briefing files (they're durable by design).
 */
export function _removeBriefingFilesForTests(cfcfDocsPath: string): void {
  for (const filename of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      rmSync(join(cfcfDocsPath, filename), { force: true });
    } catch { /* best-effort */ }
  }
}
