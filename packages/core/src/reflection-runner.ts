/**
 * Reflection runner for cfcf (item 5.6 Tier 3 Strategic Reflection).
 *
 * Spawns a reflection agent that reads the full run history (decision log,
 * all prior judge assessments + reflection analyses, iteration logs, compact
 * git log, latest dev log tail) and produces:
 *
 *   - cfcf-docs/reflection-analysis.md  -- human-readable cross-iteration review
 *   - cfcf-docs/cfcf-reflection-signals.json -- machine-readable signals
 *   - (optional) rewrites to the pending portion of cfcf-docs/plan.md
 *   - (optional) a tagged entry appended to cfcf-docs/decision-log.md
 *
 * This module exposes both a sync runner (used inside the iteration loop)
 * and an async one (used by `cfcf reflect` + the `/reflect` API endpoint).
 * Loop integration lives in iteration-loop.ts -- see PR 3.
 */

import { join } from "path";
import { readFile, writeFile, mkdir, readdir, access, copyFile } from "fs/promises";
import { randomBytes } from "crypto";
import type {
  ProjectConfig,
  ReflectionSignals,
  AgentConfig,
} from "./types.js";
import { getTemplate, writeTemplate } from "./templates.js";
import { getAdapter } from "./adapters/index.js";
import { spawnProcess, type ManagedProcess } from "./process-manager.js";
import {
  getAgentRunLogPath,
  nextAgentRunSequence,
  ensureProjectLogDir,
  getProjectLogDir,
} from "./log-storage.js";
import { appendHistoryEvent, updateHistoryEvent } from "./project-history.js";
import { registerProcess } from "./active-processes.js";
import { dispatchForProject, makeEvent } from "./notifications/index.js";
import * as gitManager from "./git-manager.js";
import { validatePlanRewrite as sharedValidatePlanRewrite } from "./plan-validation.js";

// Re-export for backwards compatibility with callers that imported it from
// this module before plan-validation.ts existed.
export { validatePlanRewrite } from "./plan-validation.js";

// --- Helpers ---

/**
 * Resolve the reflection agent config for a project, falling back through
 * project -> project.architect -> project.dev.
 */
export function resolveReflectionAgent(project: ProjectConfig): AgentConfig {
  return (
    project.reflectionAgent ??
    project.architectAgent ??
    project.devAgent
  );
}

// --- State ---

export interface ReflectState {
  projectId: string;
  projectName: string;
  status: "preparing" | "executing" | "collecting" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  logFile: string;
  logFileName: string;
  sequence: number;
  historyEventId: string;
  /** Iteration this reflection was produced after (0 for manual / cross-loop). */
  iteration: number;
  trigger: "loop" | "manual";
  signals?: ReflectionSignals;
  error?: string;
}

const reflectStore = new Map<string, ReflectState>();
const reflectProcessStore = new Map<string, ManagedProcess>();

export function getReflectState(projectId: string): ReflectState | undefined {
  return reflectStore.get(projectId);
}

// --- Template helpers ---

export async function writeReflectionInstructions(
  repoPath: string,
  project: ProjectConfig,
  iteration: number,
): Promise<void> {
  let template = await getTemplate("cfcf-reflection-instructions.md", { repoPath });
  template = template.replace(/\{\{ITERATION\}\}/g, String(iteration));
  template = template.replace(/\{\{PROJECT_NAME\}\}/g, project.name);

  const cfcfDocsDir = join(repoPath, "cfcf-docs");
  await mkdir(cfcfDocsDir, { recursive: true });
  await writeFile(
    join(cfcfDocsDir, "cfcf-reflection-instructions.md"),
    template,
    "utf-8",
  );
}

export async function resetReflectionSignals(repoPath: string): Promise<void> {
  await writeTemplate(
    join(repoPath, "cfcf-docs"),
    "cfcf-reflection-signals.json",
    { repoPath },
  );
}

/**
 * Parse the reflection signal file after the agent exits. Returns null if
 * missing / malformed / still the template placeholder.
 */
export async function parseReflectionSignals(
  repoPath: string,
): Promise<ReflectionSignals | null> {
  try {
    const content = await readFile(
      join(repoPath, "cfcf-docs", "cfcf-reflection-signals.json"),
      "utf-8",
    );
    const signals = JSON.parse(content) as ReflectionSignals;
    if (!signals || typeof signals !== "object") return null;
    if (!signals.iteration_health) return null;
    // Template default: iteration=0 + health=inconclusive + empty key_observation.
    if (
      signals.iteration === 0 &&
      signals.iteration_health === "inconclusive" &&
      (!signals.key_observation || signals.key_observation.trim().length === 0)
    ) {
      return null;
    }
    return signals;
  } catch {
    return null;
  }
}

/**
 * Archive the reflection-analysis.md into reflection-reviews/reflection-N.md.
 * Noop if the file doesn't exist.
 */
export async function archiveReflectionAnalysis(
  repoPath: string,
  iteration: number,
): Promise<boolean> {
  const src = join(repoPath, "cfcf-docs", "reflection-analysis.md");
  const reviewsDir = join(repoPath, "cfcf-docs", "reflection-reviews");
  const dest = join(reviewsDir, `reflection-${iteration}.md`);
  try {
    await access(src);
    await mkdir(reviewsDir, { recursive: true });
    await copyFile(src, dest);
    return true;
  } catch {
    return false;
  }
}

// Plan-validation rules (research §6.3) live in plan-validation.ts and
// are shared with the Architect re-review path. This module re-exports
// `validatePlanRewrite` above for older import sites.

// --- Reflection context assembly (research §3.2 + Q1/Q3) ---

/**
 * Build a compact cfcf-reflection-context.md that captures:
 *   - A one-line-per-commit log of every cfcf/iteration-* branch (Q3).
 *   - The tail (~500 lines) of the most recent dev log (Q1).
 *
 * The reflection agent reads this in addition to all the usual markdown
 * artifacts. We write a separate file (rather than inlining in the
 * instructions) so the content stays within cfcf-docs/ and is not visible
 * to unrelated roles that don't need it.
 */
export async function writeReflectionContext(
  repoPath: string,
  projectId: string,
  iteration: number,
): Promise<void> {
  const lines: string[] = [];
  lines.push(`# Reflection Context (iteration ${iteration})`);
  lines.push("");
  lines.push("This file is assembled by cfcf before the reflection agent runs.");
  lines.push("It supplements the standard cfcf-docs/ artifacts with a compact");
  lines.push("cross-iteration git log and the tail of the last dev log.");
  lines.push("");

  // --- Git log across cfcf/iteration-* branches ---
  lines.push("## Commit log across iteration branches");
  lines.push("");
  try {
    const branches = await gitManager.listBranches(repoPath);
    const iterBranches = branches
      .filter((b) => /^cfcf\/iteration-\d+$/.test(b))
      .sort((a, b) => {
        const an = parseInt(a.split("-").pop() || "0", 10);
        const bn = parseInt(b.split("-").pop() || "0", 10);
        return an - bn;
      });
    if (iterBranches.length === 0) {
      lines.push("_No iteration branches found yet._");
    } else {
      for (const branch of iterBranches) {
        lines.push(`### ${branch}`);
        lines.push("");
        const log = await gitManager.logOneline(repoPath, branch, 20);
        if (log && log.length > 0) {
          lines.push("```");
          for (const entry of log) lines.push(entry);
          lines.push("```");
        } else {
          lines.push("_(no commits)_");
        }
        lines.push("");
      }
    }
  } catch (err) {
    lines.push(`_Failed to read git branches: ${String(err)}_`);
    lines.push("");
  }

  // --- Tail of the most recent dev log ---
  lines.push("## Tail of the most recent dev log");
  lines.push("");
  const tail = await readLatestDevLogTail(projectId);
  if (tail) {
    lines.push("```");
    lines.push(tail);
    lines.push("```");
  } else {
    lines.push("_No dev log found yet._");
  }
  lines.push("");

  const cfcfDocsDir = join(repoPath, "cfcf-docs");
  await mkdir(cfcfDocsDir, { recursive: true });
  await writeFile(
    join(cfcfDocsDir, "cfcf-reflection-context.md"),
    lines.join("\n"),
    "utf-8",
  );
}

/**
 * Read the last ~500 lines of the most recent iteration-NNN-dev.log file
 * for this project. Returns null if no dev logs exist.
 */
async function readLatestDevLogTail(projectId: string): Promise<string | null> {
  try {
    const dir = getProjectLogDir(projectId);
    const entries = await readdir(dir);
    const devLogs = entries
      .filter((e) => /^iteration-\d+-dev\.log$/.test(e))
      .sort();
    if (devLogs.length === 0) return null;
    const latest = devLogs[devLogs.length - 1];
    const content = await readFile(join(dir, latest), "utf-8");
    const logLines = content.split("\n");
    const tail = logLines.slice(-500).join("\n");
    return tail;
  } catch {
    return null;
  }
}

// --- Ad-hoc entry point (used by `cfcf reflect` and /api/projects/:id/reflect) ---

/**
 * Start a reflection run asynchronously (ad-hoc, not inside the loop).
 * Returns the initial state; the actual agent runs in the background.
 */
export async function startReflection(
  project: ProjectConfig,
  opts?: { prompt?: string },
): Promise<ReflectState> {
  await ensureProjectLogDir(project.id);
  const sequence = await nextAgentRunSequence(project.id, "reflection");
  const logFile = getAgentRunLogPath(project.id, "reflection", sequence);
  const logFileName = `reflection-${String(sequence).padStart(3, "0")}.log`;
  const historyEventId = randomBytes(8).toString("hex");
  const startedAt = new Date().toISOString();

  const agent = resolveReflectionAgent(project);
  const iteration = project.currentIteration || 0;

  await appendHistoryEvent(project.id, {
    id: historyEventId,
    type: "reflection",
    status: "running",
    startedAt,
    logFile: logFileName,
    agent: agent.adapter,
    model: agent.model,
    iteration,
    trigger: "manual",
  });

  const state: ReflectState = {
    projectId: project.id,
    projectName: project.name,
    status: "preparing",
    startedAt,
    logFile,
    logFileName,
    sequence,
    historyEventId,
    iteration,
    trigger: "manual",
  };
  reflectStore.set(project.id, state);

  runReflectionAsync(project, state, opts).catch(async (err) => {
    try {
      state.status = "failed";
      state.error = err instanceof Error ? err.message : String(err);
      state.completedAt = new Date().toISOString();
      await updateHistoryEvent(project.id, historyEventId, {
        status: "failed",
        error: state.error,
        completedAt: state.completedAt,
      });
      dispatchForProject(
        makeEvent({
          type: "agent.failed",
          title: "Reflection failed",
          message: `${project.name}: ${state.error}`,
          projectId: project.id,
          projectName: project.name,
          details: { role: "reflection", error: state.error },
        }),
        project.notifications,
      );
    } catch (handlerErr) {
      console.error(`[reflection-runner] Failed to record error for ${project.id}:`, handlerErr);
      console.error(`  Original error:`, err);
    }
  });

  return state;
}

/** Stop a manually-running reflection. */
export async function stopReflection(projectId: string): Promise<ReflectState | null> {
  const state = reflectStore.get(projectId);
  if (!state) return null;
  if (!["preparing", "executing", "collecting"].includes(state.status)) {
    return state;
  }
  const proc = reflectProcessStore.get(projectId);
  if (proc) {
    proc.kill();
    reflectProcessStore.delete(projectId);
  }
  state.status = "failed";
  state.error = "Stopped by user";
  state.completedAt = new Date().toISOString();
  await updateHistoryEvent(projectId, state.historyEventId, {
    status: "failed",
    error: "Stopped by user",
    completedAt: state.completedAt,
  });
  return state;
}

async function runReflectionAsync(
  project: ProjectConfig,
  state: ReflectState,
  opts?: { prompt?: string },
): Promise<void> {
  const agent = resolveReflectionAgent(project);
  const adapter = getAdapter(agent.adapter);
  if (!adapter) {
    throw new Error(`Unknown reflection agent adapter: ${agent.adapter}`);
  }

  await writeReflectionInstructions(project.repoPath, project, state.iteration);
  await resetReflectionSignals(project.repoPath);
  await writeReflectionContext(project.repoPath, project.id, state.iteration);

  state.status = "executing";

  const focusHint = opts?.prompt
    ? ` The user has supplied this focus hint: "${opts.prompt.replace(/"/g, '\\"')}". Weigh it against the cross-iteration evidence; it is advisory, not binding.`
    : "";
  const prompt = `Read cfcf-docs/cfcf-reflection-instructions.md and follow the instructions exactly. Review the full cross-iteration history (decision log, iteration logs, prior reflections, compact git log in cfcf-docs/cfcf-reflection-context.md), classify iteration health, optionally rewrite pending items in cfcf-docs/plan.md (non-destructive), and produce cfcf-docs/reflection-analysis.md + cfcf-docs/cfcf-reflection-signals.json before exiting.${focusHint}`;
  const cmd = adapter.buildCommand(project.repoPath, prompt, agent.model);

  const managed = await spawnProcess({
    command: cmd.command,
    args: cmd.args,
    cwd: project.repoPath,
    logFile: state.logFile,
  });
  reflectProcessStore.set(project.id, managed);
  const unregister = registerProcess({
    projectId: project.id,
    role: "reflection",
    process: managed,
    startedAt: state.startedAt,
    historyEventId: state.historyEventId,
    logFileName: state.logFileName,
  });

  try {
    const result = await managed.result;
    state.exitCode = result.exitCode;
    if ((state.status as string) === "failed") return; // externally stopped

    state.status = "collecting";
    const signals = await parseReflectionSignals(project.repoPath);
    state.signals = signals ?? undefined;
    state.status = "completed";
    state.completedAt = new Date().toISOString();

    await updateHistoryEvent(project.id, state.historyEventId, {
      status: result.exitCode === 0 ? "completed" : "failed",
      completedAt: state.completedAt,
      exitCode: result.exitCode,
      signals: signals ?? undefined,
      iterationHealth: signals?.iteration_health,
      planModified: signals?.plan_modified,
    } as Partial<import("./project-history.js").ReflectionHistoryEvent>);
  } finally {
    reflectProcessStore.delete(project.id);
    unregister();
  }
}

// --- Sync entry point (used by the iteration loop in PR 3) ---

export interface ReflectionRunResult {
  exitCode: number;
  logFile: string;
  logFileName: string;
  sequence: number;
  historyEventId: string;
  signals: ReflectionSignals | null;
  /** True when the reflection agent's plan.md was accepted.
   *  False when the non-destructive check rejected it and the previous
   *  plan was restored. */
  planAccepted: boolean;
  /** Populated when planAccepted is false. */
  planRejectionReason?: string;
}

/**
 * Execute the reflection agent synchronously and return the result.
 * Performs non-destructive plan validation and reverts plan.md when the
 * new version violates the rules (research doc §6.3).
 */
export async function runReflectionSync(
  project: ProjectConfig,
  iteration: number,
  opts?: { reason?: string },
): Promise<ReflectionRunResult> {
  await ensureProjectLogDir(project.id);
  const sequence = await nextAgentRunSequence(project.id, "reflection");
  const logFile = getAgentRunLogPath(project.id, "reflection", sequence);
  const logFileName = `reflection-${String(sequence).padStart(3, "0")}.log`;
  const historyEventId = randomBytes(8).toString("hex");
  const startedAt = new Date().toISOString();

  const agent = resolveReflectionAgent(project);
  const adapter = getAdapter(agent.adapter);
  if (!adapter) {
    throw new Error(`Unknown reflection agent adapter: ${agent.adapter}`);
  }

  await appendHistoryEvent(project.id, {
    id: historyEventId,
    type: "reflection",
    status: "running",
    startedAt,
    logFile: logFileName,
    agent: agent.adapter,
    model: agent.model,
    iteration,
    trigger: "loop",
  });

  await writeReflectionInstructions(project.repoPath, project, iteration);
  await resetReflectionSignals(project.repoPath);
  await writeReflectionContext(project.repoPath, project.id, iteration);

  // Snapshot plan.md so we can revert if the rewrite is invalid.
  const planPath = join(project.repoPath, "cfcf-docs", "plan.md");
  let priorPlan = "";
  try {
    priorPlan = await readFile(planPath, "utf-8");
  } catch {
    priorPlan = "";
  }

  const reasonHint = opts?.reason
    ? ` The judge flagged: "${opts.reason.replace(/"/g, '\\"')}". Weigh it against the cross-iteration evidence.`
    : "";
  const prompt = `Read cfcf-docs/cfcf-reflection-instructions.md and follow the instructions exactly. This reflection runs at the END of iteration ${iteration}. Review the full cross-iteration history (decision log, iteration logs, prior reflections, compact git log in cfcf-docs/cfcf-reflection-context.md), classify iteration health, optionally rewrite pending items in cfcf-docs/plan.md (non-destructive: preserve all completed items), and produce cfcf-docs/reflection-analysis.md + cfcf-docs/cfcf-reflection-signals.json before exiting.${reasonHint}`;
  const cmd = adapter.buildCommand(project.repoPath, prompt, agent.model);

  const managed = await spawnProcess({
    command: cmd.command,
    args: cmd.args,
    cwd: project.repoPath,
    logFile,
  });
  const unregister = registerProcess({
    projectId: project.id,
    role: "reflection",
    process: managed,
    startedAt,
    historyEventId,
    logFileName,
  });

  try {
    const result = await managed.result;

    // Validate any plan rewrite
    let planAccepted = true;
    let planRejectionReason: string | undefined;
    let newPlan = "";
    try {
      newPlan = await readFile(planPath, "utf-8");
    } catch {
      newPlan = "";
    }
    if (priorPlan && newPlan !== priorPlan) {
      const validation = sharedValidatePlanRewrite(priorPlan, newPlan);
      if (!validation.valid) {
        await writeFile(planPath, priorPlan, "utf-8");
        planAccepted = false;
        planRejectionReason = validation.reason;
      }
    }

    const signals = await parseReflectionSignals(project.repoPath);

    await updateHistoryEvent(project.id, historyEventId, {
      status: result.exitCode === 0 ? "completed" : "failed",
      completedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      signals: signals ?? undefined,
      iterationHealth: signals?.iteration_health,
      planModified: planAccepted && signals?.plan_modified === true,
      planRejectionReason,
    } as Partial<import("./project-history.js").ReflectionHistoryEvent>);

    return {
      exitCode: result.exitCode,
      logFile,
      logFileName,
      sequence,
      historyEventId,
      signals,
      planAccepted,
      planRejectionReason,
    };
  } finally {
    unregister();
  }
}
