/**
 * Solution Architect runner for cfcf.
 *
 * Spawns a Solution Architect agent to review the Problem Pack
 * and produce a readiness assessment + initial implementation plan.
 * User-invoked, advisory, repeatable.
 */

import { join, dirname } from "path";
import { readFile, writeFile, mkdir, copyFile, access } from "fs/promises";
import type { ProjectConfig, ArchitectSignals } from "./types.js";
import { getAdapter } from "./adapters/index.js";
import { spawnProcess, type ManagedProcess } from "./process-manager.js";
import { registerProcess } from "./active-processes.js";
import { dispatchForProject, makeEvent } from "./notifications/index.js";
import { getAgentRunLogPath, nextAgentRunSequence, ensureProjectLogDir } from "./log-storage.js";
import { appendHistoryEvent, updateHistoryEvent } from "./project-history.js";
import { randomBytes } from "crypto";
import { readProblemPack, validateProblemPack } from "./problem-pack.js";
import { writeContextToRepo, type IterationContext } from "./context-assembler.js";

const TEMPLATES_DIR = join(dirname(new URL(import.meta.url).pathname), "templates");

// --- Review State ---

export interface ReviewState {
  projectId: string;
  projectName: string;
  status: "preparing" | "executing" | "collecting" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  /** Absolute path to the log file (for server use) */
  logFile: string;
  /** Log file name only (for web clients to reference via the logs API) */
  logFileName: string;
  /** Sequence number for this review run */
  sequence: number;
  /** History event ID */
  historyEventId: string;
  signals?: ArchitectSignals;
  error?: string;
}

const reviewStore = new Map<string, ReviewState>();
const reviewProcessStore = new Map<string, ManagedProcess>();

export function getReviewState(projectId: string): ReviewState | undefined {
  return reviewStore.get(projectId);
}

/**
 * Stop a running review for a project. Kills the process and updates state.
 */
export async function stopReview(projectId: string): Promise<ReviewState | null> {
  const state = reviewStore.get(projectId);
  if (!state) return null;
  if (!["preparing", "executing", "collecting"].includes(state.status)) {
    return state; // already terminal
  }

  const proc = reviewProcessStore.get(projectId);
  if (proc) {
    proc.kill();
    reviewProcessStore.delete(projectId);
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

// --- Core Functions ---

/**
 * Write architect instructions into cfcf-docs/.
 */
export async function writeArchitectInstructions(
  repoPath: string,
  project: ProjectConfig,
): Promise<void> {
  const templatePath = join(TEMPLATES_DIR, "cfcf-architect-instructions.md");
  let template = await readFile(templatePath, "utf-8");

  template = template.replace(/\{\{PROJECT_NAME\}\}/g, project.name);

  const cfcfDocsDir = join(repoPath, "cfcf-docs");
  await mkdir(cfcfDocsDir, { recursive: true });

  await writeFile(
    join(cfcfDocsDir, "cfcf-architect-instructions.md"),
    template,
    "utf-8",
  );
}

/**
 * Reset the architect signal file to the template.
 */
export async function resetArchitectSignals(repoPath: string): Promise<void> {
  const src = join(TEMPLATES_DIR, "cfcf-architect-signals.json");
  const dest = join(repoPath, "cfcf-docs", "cfcf-architect-signals.json");
  await mkdir(join(repoPath, "cfcf-docs"), { recursive: true });
  await copyFile(src, dest);
}

/**
 * Parse the architect signal file after the architect exits.
 */
export async function parseArchitectSignals(
  repoPath: string,
): Promise<ArchitectSignals | null> {
  try {
    const content = await readFile(
      join(repoPath, "cfcf-docs", "cfcf-architect-signals.json"),
      "utf-8",
    );
    const signals = JSON.parse(content) as ArchitectSignals;
    // Basic validation
    if (!signals.readiness) return null;
    // Check it's not the untouched template
    if (signals.gaps.length === 0 && signals.suggestions.length === 0 && signals.risks.length === 0 && !signals.recommended_approach) {
      return null;
    }
    return signals;
  } catch {
    return null;
  }
}

/**
 * Start an architect review for a project.
 * Runs asynchronously -- returns the initial state immediately.
 */
export async function startReview(
  project: ProjectConfig,
  opts?: { problemPackPath?: string },
): Promise<ReviewState> {
  await ensureProjectLogDir(project.id);
  const sequence = await nextAgentRunSequence(project.id, "architect");
  const logFile = getAgentRunLogPath(project.id, "architect", sequence);
  const logFileName = `architect-${String(sequence).padStart(3, "0")}.log`;

  const historyEventId = randomBytes(8).toString("hex");
  const startedAt = new Date().toISOString();

  // Record the history event immediately
  await appendHistoryEvent(project.id, {
    id: historyEventId,
    type: "review",
    status: "running",
    startedAt,
    logFile: logFileName,
    agent: project.architectAgent.adapter,
    model: project.architectAgent.model,
  });

  const state: ReviewState = {
    projectId: project.id,
    projectName: project.name,
    status: "preparing",
    startedAt,
    logFile,
    logFileName,
    sequence,
    historyEventId,
  };

  reviewStore.set(project.id, state);

  // Run in background. Wrap the error handler itself in try/catch so that
  // a failure to update state (e.g., disk write error) doesn't result in
  // a silent failure with no trace.
  runReview(project, state, opts).catch(async (err) => {
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
          title: "Architect review failed",
          message: `${project.name}: ${state.error}`,
          projectId: project.id,
          projectName: project.name,
          details: { role: "architect", error: state.error },
        }),
        project.notifications,
      );
    } catch (handlerErr) {
      console.error(`[architect-runner] Failed to record error for ${project.id}:`, handlerErr);
      console.error(`  Original error:`, err);
    }
  });

  return state;
}

/**
 * Execute the architect review.
 */
async function runReview(
  project: ProjectConfig,
  state: ReviewState,
  opts?: { problemPackPath?: string },
): Promise<void> {
  const adapter = getAdapter(project.architectAgent.adapter);
  if (!adapter) {
    throw new Error(`Unknown architect agent adapter: ${project.architectAgent.adapter}`);
  }

  // Validate and read Problem Pack
  const packPath = opts?.problemPackPath || join(project.repoPath, "problem-pack");
  const packValidation = await validateProblemPack(packPath);
  if (!packValidation.valid) {
    throw new Error(
      `Problem Pack invalid: ${packValidation.errors.join(", ")}. Create a problem-pack/ directory with problem.md and success.md.`,
    );
  }
  const problemPack = await readProblemPack(packPath);

  // Write context files (so the architect can read them)
  const ctx: IterationContext = {
    iteration: 0, // Architect runs before any iteration
    problemPack,
    project,
  };
  await writeContextToRepo(project.repoPath, ctx);

  // Write architect-specific instructions
  await writeArchitectInstructions(project.repoPath, project);
  await resetArchitectSignals(project.repoPath);

  // Build and run the architect agent
  state.status = "executing";

  const prompt = `Read cfcf-docs/cfcf-architect-instructions.md and follow the instructions exactly. Review the problem definition, produce cfcf-docs/architect-review.md, cfcf-docs/plan.md, and cfcf-docs/cfcf-architect-signals.json before exiting.`;
  const cmd = adapter.buildCommand(project.repoPath, prompt, project.architectAgent.model);

  const managed = await spawnProcess({
    command: cmd.command,
    args: cmd.args,
    cwd: project.repoPath,
    logFile: state.logFile,
  });
  reviewProcessStore.set(project.id, managed);
  const unregister = registerProcess({
    projectId: project.id,
    role: "architect",
    process: managed,
    startedAt: state.startedAt,
    historyEventId: state.historyEventId,
    logFileName: state.logFileName,
  });

  try {
    const result = await managed.result;
    state.exitCode = result.exitCode;

    // If stopped externally, state.status was already set to "failed"
    if ((state.status as string) === "failed") return;

    // Collect results
    state.status = "collecting";
    const signals = await parseArchitectSignals(project.repoPath);
    state.signals = signals ?? undefined;

    state.status = "completed";
    state.completedAt = new Date().toISOString();

    // Update history event with final status
    await updateHistoryEvent(project.id, state.historyEventId, {
      status: result.exitCode === 0 ? "completed" : "failed",
      completedAt: state.completedAt,
      readiness: signals?.readiness,
    } as Partial<import("./project-history.js").ReviewHistoryEvent>);
  } finally {
    reviewProcessStore.delete(project.id);
    unregister();
  }
}
