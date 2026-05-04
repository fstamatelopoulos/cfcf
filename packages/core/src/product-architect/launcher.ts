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
import { mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { getAdapter } from "../adapters/index.js";
import type { AgentConfig } from "../types.js";
import {
  appendHistoryEvent,
  updateHistoryEvent,
  type PaSessionHistoryEvent,
} from "../workspace-history.js";
import type { AssessedState } from "./state-assessor.js";
import { listWorkspaces } from "../workspaces.js";
import { ensurePaClioProjects } from "./memory.js";
import { getClioBackend } from "../clio/index.js";

export interface LaunchOptions {
  /** Resolved Product Architect agent config (already backfilled by validateConfig). */
  agent: AgentConfig;
  /**
   * The state assessment computed by `assessState()`. Provides
   * repoPath, sessionId, workspace registration, git status, etc.
   * The launcher uses this to write the workspace-history start +
   * completion entries.
   */
  state: AssessedState;
  /**
   * Full assembled system prompt. Composed by `assembleProductArchitectPrompt()`.
   */
  systemPrompt: string;
  /**
   * First user message to send to the agent on launch (Flavour A).
   *
   * Both `claude` and `codex` accept a positional `[PROMPT]` argument
   * that becomes the user's opening message in interactive mode --
   * the agent responds to it immediately, then yields to the TUI.
   */
  firstUserMessage: string;
  /**
   * When true, fall back to the agent CLI's per-command permission
   * prompts (claude's default permission mode; codex's `untrusted`
   * approval policy + workspace-write sandbox).
   *
   * Default behaviour (when false / unset): full permissions, mirroring
   * the iteration-time agents (dev/judge/SA/reflection/documenter).
   * The user accepted the trust contract at `cfcf init` (via the
   * `permissionsAcknowledged` flag); PA inherits it. claude-code gets
   * `--dangerously-skip-permissions`; codex gets `approval_policy=never`
   * AND `sandbox_mode=danger-full-access` so localhost-targeting
   * cfcf CLI commands work too.
   *
   * Pass `--safe` on the CLI (`cfcf spec --safe`) to opt back into
   * prompts for a single session.
   */
  safe?: boolean;
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

export function buildLaunchArgs(
  agent: AgentConfig,
  systemPrompt: string,
  firstUserMessage: string,
  safe: boolean = false,
): LaunchArgs {
  switch (agent.adapter) {
    case "claude-code": {
      // Interactive mode (no `-p` / `--print`). `--append-system-prompt`
      // adds PA's briefing on top of Claude Code's default system prompt.
      //
      // Default to **Sonnet** for PA. Spec iteration is multi-turn
      // reasoning + judgement calls — benefits from a stronger model
      // than HA's Q&A workload (where Haiku is fine).
      //
      // **Permissions**: PA defaults to `--dangerously-skip-permissions`,
      // mirroring the iteration-time agents (dev/judge/SA/reflection/
      // documenter). The user accepted the trust contract at
      // `cfcf init`; PA inherits it. Pass `--safe` to opt back into the
      // default permission mode for a single session.
      //
      // The positional argument at the end is the user's opening message
      // in interactive mode (per `claude --help`: "Arguments: prompt --
      // Your prompt"). Flavour A.
      const args: string[] = ["--append-system-prompt", systemPrompt];
      args.push("--model", agent.model ?? "sonnet");
      if (!safe) {
        args.push("--dangerously-skip-permissions");
      }
      args.push(firstUserMessage); // positional [prompt]
      return { command: "claude", args, tempPromptFile: null };
    }
    case "codex": {
      // codex uses the `-c <key>=<value>` config override accepting the
      // `model_instructions_file` key. We write the prompt to a tempfile,
      // pass the path, and clean up after exit.
      //
      // **Permissions + sandbox** (default; pass `--safe` to opt back):
      //   approval_policy=never  — skip per-command prompts
      //   sandbox_mode=danger-full-access — full filesystem + network
      //     access, mirroring the iteration agents AND fixing codex's
      //     loopback-blocked sandbox issue (cfcf CLI commands that hit
      //     localhost like `cfcf server status` will work).
      //
      // In safe mode we leave both keys at codex's defaults
      // (`untrusted` approval + `workspace-write` sandbox) — friendly
      // but means localhost-targeting commands may report wrong info.
      //
      // The positional [PROMPT] at the end is the user's opening message
      // (per `codex --help`: "Optional user prompt to start the
      // session"). Flavour A.
      const dir = mkdtempSync(join(tmpdir(), "cfcf-pa-"));
      const promptFile = join(dir, "pa-instructions.md");
      writeFileSync(promptFile, systemPrompt, "utf-8");

      const args: string[] = [
        "-c", `model_instructions_file="${promptFile.replace(/"/g, '\\"')}"`,
      ];
      if (!safe) {
        args.push("-c", "approval_policy=\"never\"");
        args.push("-c", "sandbox_mode=\"danger-full-access\"");
      }
      if (agent.model) {
        args.push("--model", agent.model);
      }
      args.push(firstUserMessage); // positional [PROMPT]
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
  const paCachePath = join(opts.state.repoPath, ".cfcf-pa");
  await mkdir(paCachePath, { recursive: true });

  // Pre-create the PA + global Clio Projects so the agent's
  // `cfcf clio docs ingest --project cf-system-pa-memory` command lands in
  // the right place. Without this the auto-route-on-missing semantics
  // would push the doc into the `default` Project, which produces the
  // "Clio says no memory but disk has memory" discrepancy users hit
  // in dogfood. Idempotent + best-effort.
  try {
    const backend = getClioBackend();
    await ensurePaClioProjects(backend);
  } catch { /* best-effort */ }

  // ── History: write the start entry (best-effort) ──────────────────
  // If the workspace is registered, log a "running" entry now so the
  // web UI can show the live session in the History tab. If not, we'll
  // try to log a single completed entry post-spawn (in case PA drove
  // `cfcf workspace init` mid-session).
  const startedAt = new Date().toISOString();
  const sessionFileRel = join(".cfcf-pa", `session-${opts.state.sessionId}.md`);
  const problemPackFilesAtStart = opts.state.problemPack.exists
    ? opts.state.problemPack.files.filter((f) => f.exists).length
    : 0;
  const eventBase: Omit<PaSessionHistoryEvent, "id" | "status"> = {
    type: "pa-session",
    startedAt,
    logFile: sessionFileRel, // points at the session scratchpad
    agent: opts.agent.adapter,
    model: opts.agent.model,
    sessionId: opts.state.sessionId,
    sessionFilePath: sessionFileRel,
    workspaceRegisteredAtStart: opts.state.workspace.registered,
    gitInitializedAtStart: opts.state.git.isGitRepo,
    problemPackFilesAtStart,
  };

  let historyEventId: string | null = null;
  let historyWorkspaceId: string | null = opts.state.workspace.workspaceId;
  if (historyWorkspaceId !== null) {
    historyEventId = `pa-${opts.state.sessionId}`;
    try {
      await appendHistoryEvent(historyWorkspaceId, {
        ...eventBase,
        id: historyEventId,
        status: "running",
      });
    } catch (err) {
      // Best-effort: don't block the launch on history-write failures.
      console.error(
        `[pa] note: couldn't write history start event (${err instanceof Error ? err.message : String(err)}). ` +
        `Session will still run; completion entry may also fail.`,
      );
      historyEventId = null;
    }
  }

  const { command, args, tempPromptFile } = buildLaunchArgs(
    opts.agent,
    opts.systemPrompt,
    opts.firstUserMessage,
    opts.safe ?? false,
  );

  let exitCode: number | null = null;
  let argsRedacted: string[] = [];
  try {
    // Bun.spawn with inherit stdio: the agent's TUI takes over the
    // current shell until the user exits.
    //
    // cwd is the REPO ROOT — NOT `.cfcf-pa/`. The agent's bash tool
    // operates relative to the repo so `problem-pack/` edits, `cfcf`
    // commands, etc. work with simple relative paths.
    const proc = Bun.spawn([command, ...args], {
      cwd: opts.state.repoPath,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    exitCode = code ?? null;

    // Redact the system prompt + tempfile path in logged args.
    argsRedacted = args.map((a, i) => {
      const flag = i > 0 ? args[i - 1] : "";
      if (flag === "--append-system-prompt") {
        return `<${a.length}-char system prompt redacted>`;
      }
      if (flag === "-c" && a.startsWith("model_instructions_file=")) {
        return `model_instructions_file=<tempfile redacted>`;
      }
      return a;
    });
  } finally {
    // Best-effort tempfile cleanup.
    if (tempPromptFile) {
      try {
        const dir = tempPromptFile.replace(/\/[^/]+$/, "");
        rmSync(dir, { recursive: true, force: true });
      } catch { /* best-effort */ }
    }

    // ── History: write/update the completion entry ─────────────────
    await finaliseHistoryEvent({
      workspaceIdAtStart: opts.state.workspace.workspaceId,
      historyEventId,
      paCachePath,
      eventBase,
      repoPath: opts.state.repoPath,
      exitCode,
    });
  }

  return {
    command,
    argsRedacted,
    exitCode,
    paCachePath,
  };
}

/**
 * After PA exits, finalise the workspace-history entry. Three cases:
 *   1. Workspace was registered at start AND we logged a `running`
 *      entry → update it with completion data.
 *   2. Workspace was NOT registered at start, but PA drove
 *      `cfcf workspace init` mid-session → look up the workspace
 *      now (post-hoc) + write a single completed entry.
 *   3. Still no workspace → skip (nothing to do; the .cfcf-pa/ files
 *      are preserved on disk for next time).
 *
 * Reads `<repo>/.cfcf-pa/meta.json` for the agent-provided
 * `lastSession` block (outcomeSummary, decisionsCount,
 * clioWorkspaceMemoryDocId). Best-effort: missing/malformed JSON is
 * silently skipped.
 */
async function finaliseHistoryEvent(opts: {
  workspaceIdAtStart: string | null;
  historyEventId: string | null;
  paCachePath: string;
  eventBase: Omit<PaSessionHistoryEvent, "id" | "status">;
  repoPath: string;
  exitCode: number | null;
}): Promise<void> {
  const completedAt = new Date().toISOString();
  const status = opts.exitCode === 0 ? "completed" : "failed";

  // Try to read meta.json for agent-provided session outcome.
  const meta = await readMetaJsonLastSession(opts.paCachePath);

  // Re-resolve workspace registration in case PA registered it
  // mid-session. Use realpath-aware comparison to handle macOS's
  // symlinked /tmp → /private/tmp (process.cwd() returns the realpath
  // form; cfcf workspace init stores what the user typed, which
  // doesn't follow symlinks — a plain string compare misses).
  let workspaceId = opts.workspaceIdAtStart;
  if (workspaceId === null) {
    try {
      const { realpathSync } = await import("node:fs");
      const safeRealpath = (p: string): string => {
        try { return realpathSync(p); } catch { return p; }
      };
      const target = safeRealpath(opts.repoPath);
      const all = await listWorkspaces();
      const match = all.find((w) => safeRealpath(w.repoPath) === target);
      if (match) workspaceId = match.id;
    } catch { /* best-effort */ }
  }

  if (workspaceId === null) {
    // Nothing to log against. The .cfcf-pa/ files are still preserved.
    return;
  }

  const completionPatch: Partial<PaSessionHistoryEvent> = {
    status,
    completedAt,
    exitCode: opts.exitCode ?? undefined,
    outcomeSummary: meta?.outcomeSummary,
    decisionsCount: meta?.decisionsCount,
    clioWorkspaceMemoryDocId: meta?.clioWorkspaceMemoryDocId,
  };

  if (opts.historyEventId !== null) {
    // Update the existing `running` entry → `completed` / `failed`.
    try {
      await updateHistoryEvent(workspaceId, opts.historyEventId, completionPatch);
    } catch (err) {
      console.error(
        `[pa] note: couldn't update history completion entry (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
    return;
  }

  // Workspace registered mid-session — append a single completed entry.
  const eventId = `pa-${opts.eventBase.sessionId}`;
  try {
    await appendHistoryEvent(workspaceId, {
      ...opts.eventBase,
      id: eventId,
      status,
      ...completionPatch,
      // Update workspaceRegisteredAtStart=false stays accurate; this
      // entry just has both bracket info + completion in one shot.
    } as PaSessionHistoryEvent);
  } catch (err) {
    console.error(
      `[pa] note: couldn't append post-hoc history entry (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
}

/**
 * Schema of the `lastSession` block PA writes to `.cfcf-pa/meta.json`
 * on session save. cfcf reads this on exit to enrich the
 * workspace-history entry. All fields optional — the agent may not
 * have saved (Ctrl-D without a "save before you go?" yes).
 */
interface MetaJsonLastSession {
  sessionId?: string;
  endedAt?: string;
  outcomeSummary?: string;
  decisionsCount?: number;
  clioWorkspaceMemoryDocId?: string;
}

async function readMetaJsonLastSession(paCachePath: string): Promise<MetaJsonLastSession | null> {
  try {
    const raw = await readFile(join(paCachePath, "meta.json"), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "lastSession" in parsed) {
      const ls = (parsed as { lastSession?: unknown }).lastSession;
      if (ls && typeof ls === "object") return ls as MetaJsonLastSession;
    }
    return null;
  } catch {
    return null;
  }
}

// `relative` is unused in this file but kept exported elsewhere; suppress lint.
void relative;
