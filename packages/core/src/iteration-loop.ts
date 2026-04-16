/**
 * Iteration loop controller for cfcf.
 *
 * Orchestrates the full iteration cycle:
 *   prepare → dev agent → commit → judge agent → commit → decide → loop/pause/stop
 *
 * This is the heart of cfcf -- the deterministic outer loop that manages
 * non-deterministic AI agent workers.
 */

import { join } from "path";
import { writeFile, readFile, access, mkdir } from "fs/promises";
import type { ProjectConfig, DevSignals, JudgeSignals } from "./types.js";
import { getProjectDir } from "./projects.js";
import {
  writeContextToRepo,
  generateInstructionContent,
  parseHandoffDocument,
  parseSignalFile,
  generateIterationSummary,
  type IterationContext,
} from "./context-assembler.js";
import {
  writeJudgeInstructions,
  resetJudgeSignals,
  buildJudgeCommand,
  parseJudgeSignals,
  parseJudgeAssessment,
  archiveJudgeAssessment,
  summarizeJudgeAssessment,
} from "./judge-runner.js";
import { readProblemPack, validateProblemPack } from "./problem-pack.js";
import { getAdapter } from "./adapters/index.js";
import { spawnProcess } from "./process-manager.js";
import { getIterationLogPath, ensureProjectLogDir } from "./log-storage.js";
import * as gitManager from "./git-manager.js";
import { nextIteration, updateProject } from "./projects.js";
import { runDocumentSync } from "./documenter-runner.js";

// --- Loop State Types ---

export type LoopPhase =
  | "idle"
  | "preparing"
  | "dev_executing"
  | "judging"
  | "deciding"
  | "documenting"
  | "paused"
  | "completed"
  | "failed"
  | "stopped";

export interface LoopState {
  projectId: string;
  projectName: string;
  phase: LoopPhase;
  currentIteration: number;
  maxIterations: number;
  pauseEvery: number;
  startedAt: string;
  completedAt?: string;
  /** Reason the loop is paused */
  pauseReason?: "cadence" | "anomaly" | "user_input_needed" | "max_iterations";
  /** Questions from dev/judge that need user answers */
  pendingQuestions?: string[];
  /** User feedback to inject into the next iteration */
  userFeedback?: string;
  /** Per-iteration records */
  iterations: LoopIterationRecord[];
  /** Error message if failed */
  error?: string;
  /** Final outcome when completed */
  outcome?: "success" | "failure" | "stopped" | "max_iterations";
  /** Consecutive stalled count for onStalled policy */
  consecutiveStalled: number;
  /** When true, the last iteration's dev phase completed but the judge failed.
   *  On resume, retry the judge instead of running a new full iteration. */
  retryJudge?: boolean;
}

export interface LoopIterationRecord {
  number: number;
  branch: string;
  devExitCode?: number;
  devSignals?: DevSignals;
  judgeExitCode?: number;
  judgeSignals?: JudgeSignals;
  judgeError?: string;
  devLogFile: string;
  judgeLogFile: string;
  startedAt: string;
  completedAt?: string;
  merged: boolean;
}

// --- State Store (in-memory + disk persistence) ---

const loopStore = new Map<string, LoopState>();

const LOOP_STATE_FILENAME = "loop-state.json";

/**
 * Get the path to the loop state file for a project.
 */
function getLoopStatePath(projectId: string): string {
  return join(getProjectDir(projectId), LOOP_STATE_FILENAME);
}

/**
 * Persist loop state to disk. Called on every phase transition.
 */
async function persistLoopState(state: LoopState): Promise<void> {
  const dir = getProjectDir(state.projectId);
  await mkdir(dir, { recursive: true });
  const path = getLoopStatePath(state.projectId);
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/**
 * Load loop state from disk. Returns null if no persisted state exists.
 */
async function loadLoopState(projectId: string): Promise<LoopState | null> {
  try {
    const path = getLoopStatePath(projectId);
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as LoopState;
  } catch {
    return null;
  }
}

/**
 * Update loop state in memory and persist to disk.
 * Use this for all state mutations to keep memory and disk in sync.
 */
async function saveLoopState(state: LoopState): Promise<void> {
  loopStore.set(state.projectId, state);
  await persistLoopState(state);
}

/**
 * Get the loop state for a project.
 * Checks in-memory cache first, then falls back to disk.
 */
export async function getLoopState(projectId: string): Promise<LoopState | undefined> {
  // Check in-memory first
  const cached = loopStore.get(projectId);
  if (cached) return cached;

  // Fall back to disk
  const persisted = await loadLoopState(projectId);
  if (persisted) {
    loopStore.set(projectId, persisted);
    return persisted;
  }

  return undefined;
}

// --- Decision Engine ---

export interface LoopDecision {
  action: "continue" | "pause" | "stop";
  reason: string;
  pauseReason?: LoopState["pauseReason"];
  questions?: string[];
}

/**
 * Make a deterministic decision based on judge signals and loop state.
 */
export function makeDecision(
  judgeSignals: JudgeSignals | null,
  devSignals: DevSignals | null,
  state: LoopState,
  project: ProjectConfig,
): LoopDecision {
  // Check max iterations
  if (state.currentIteration >= state.maxIterations) {
    return { action: "stop", reason: "Max iterations reached", pauseReason: "max_iterations" };
  }

  // Check for user input needed from dev agent
  if (devSignals?.user_input_needed && devSignals.questions?.length) {
    return {
      action: "pause",
      reason: "Dev agent needs user input",
      pauseReason: "user_input_needed",
      questions: devSignals.questions,
    };
  }

  // If judge signals missing, treat as anomaly
  if (!judgeSignals) {
    return {
      action: "pause",
      reason: "Judge signal file missing or malformed. The judge agent may have failed to run or did not produce output. Check the judge log file for details.",
      pauseReason: "anomaly",
      questions: ["Judge did not produce signals -- check judge log for errors"],
    };
  }

  // Check for user input needed from judge
  if (judgeSignals.user_input_needed) {
    return {
      action: "pause",
      reason: "Judge says user input is needed",
      pauseReason: "user_input_needed",
      questions: judgeSignals.key_concern ? [judgeSignals.key_concern] : [],
    };
  }

  // Map judge determination to action
  switch (judgeSignals.determination) {
    case "SUCCESS":
      return { action: "stop", reason: "Judge determination: SUCCESS -- all criteria met" };

    case "PROGRESS":
      // Check pause cadence
      if (state.pauseEvery > 0 && state.currentIteration % state.pauseEvery === 0) {
        return {
          action: "pause",
          reason: `Pause cadence reached (every ${state.pauseEvery} iterations)`,
          pauseReason: "cadence",
        };
      }
      return { action: "continue", reason: "Judge determination: PROGRESS -- continuing" };

    case "STALLED": {
      const newStalledCount = state.consecutiveStalled + 1;
      switch (project.onStalled) {
        case "stop":
          return { action: "stop", reason: `Judge determination: STALLED (${newStalledCount} consecutive). Policy: stop` };
        case "alert":
          return {
            action: "pause",
            reason: `Judge determination: STALLED (${newStalledCount} consecutive). Alerting user.`,
            pauseReason: "anomaly",
          };
        case "continue":
        default:
          // Check pause cadence even on continue
          if (state.pauseEvery > 0 && state.currentIteration % state.pauseEvery === 0) {
            return {
              action: "pause",
              reason: `Judge: STALLED but policy is continue. Pause cadence reached.`,
              pauseReason: "cadence",
            };
          }
          return { action: "continue", reason: `Judge: STALLED but policy is continue (${newStalledCount} consecutive)` };
      }
    }

    case "ANOMALY":
      return {
        action: "pause",
        reason: `Judge determination: ANOMALY (${judgeSignals.anomaly_type ?? "unknown"}). ${judgeSignals.key_concern ?? ""}`,
        pauseReason: "anomaly",
        questions: judgeSignals.key_concern ? [judgeSignals.key_concern] : [],
      };

    default:
      return {
        action: "pause",
        reason: `Unknown judge determination: ${judgeSignals.determination}`,
        pauseReason: "anomaly",
      };
  }
}

// --- Main Loop ---

/**
 * Start the iteration loop for a project.
 * Runs in the background -- returns the initial state immediately.
 */
export async function startLoop(
  project: ProjectConfig,
  opts?: { problemPackPath?: string },
): Promise<LoopState> {
  const existing = await getLoopState(project.id);
  if (existing && existing.phase !== "completed" && existing.phase !== "failed" && existing.phase !== "stopped") {
    throw new Error(`Loop already active for project ${project.name} (phase: ${existing.phase})`);
  }

  const state: LoopState = {
    projectId: project.id,
    projectName: project.name,
    phase: "idle",
    currentIteration: 0,
    maxIterations: project.maxIterations,
    pauseEvery: project.pauseEvery,
    startedAt: new Date().toISOString(),
    iterations: [],
    consecutiveStalled: 0,
  };

  await saveLoopState(state);

  // Update project status
  await updateProject(project.id, { status: "running" });

  // Run loop in background
  runLoop(project, state, opts).catch(async (err) => {
    state.phase = "failed";
    state.error = err instanceof Error ? err.message : String(err);
    state.completedAt = new Date().toISOString();
    await saveLoopState(state);
    updateProject(project.id, { status: "failed" }).catch(() => {});
  });

  return state;
}

/**
 * Resume a paused loop with optional user feedback.
 */
export async function resumeLoop(
  projectId: string,
  feedback?: string,
): Promise<LoopState> {
  const state = await getLoopState(projectId);
  if (!state) {
    throw new Error("No active loop for this project");
  }
  if (state.phase !== "paused") {
    throw new Error(`Loop is not paused (current phase: ${state.phase})`);
  }

  state.userFeedback = feedback;
  state.pauseReason = undefined;
  state.pendingQuestions = undefined;

  // Re-read the project config in case it was updated
  const { getProject } = await import("./projects.js");
  const project = await getProject(projectId);
  if (!project) {
    throw new Error("Project not found");
  }

  await saveLoopState(state);
  await updateProject(projectId, { status: "running" });

  // Resume loop in background
  runLoop(project, state).catch(async (err) => {
    state.phase = "failed";
    state.error = err instanceof Error ? err.message : String(err);
    state.completedAt = new Date().toISOString();
    await saveLoopState(state);
    updateProject(projectId, { status: "failed" }).catch(() => {});
  });

  return state;
}

/**
 * Stop a running or paused loop.
 */
export async function stopLoop(projectId: string): Promise<LoopState> {
  const state = await getLoopState(projectId);
  if (!state) {
    throw new Error("No active loop for this project");
  }
  if (state.phase === "completed" || state.phase === "failed" || state.phase === "stopped") {
    throw new Error(`Loop already ended (phase: ${state.phase})`);
  }

  state.phase = "stopped";
  state.outcome = "stopped";
  state.completedAt = new Date().toISOString();
  await saveLoopState(state);
  await updateProject(projectId, { status: "stopped" });

  return state;
}

/**
 * Check if the loop has been stopped externally.
 * Extracted as a function to avoid TypeScript narrowing issues --
 * stopLoop() can set phase to "stopped" at any time from another context.
 */
function isStopped(state: LoopState): boolean {
  return state.phase === "stopped";
}

/**
 * Check if the loop has reached a terminal or paused state.
 * Used after calling runJudgeAndDecide() which mutates state.phase.
 */
function isLoopDone(state: LoopState): boolean {
  return state.phase === "paused" || state.phase === "completed" || state.phase === "stopped";
}

/**
 * The main iteration loop.
 * Runs iterations until a stop condition is met or the loop is paused.
 */
async function runLoop(
  project: ProjectConfig,
  state: LoopState,
  opts?: { problemPackPath?: string },
): Promise<void> {
  const packPath = opts?.problemPackPath || join(project.repoPath, "problem-pack");

  while (true) {
    // Check if stopped externally
    if (isStopped(state)) break;

    // --- RETRY JUDGE (if resuming after judge failure) ---
    // When the dev phase succeeded but the judge failed, we skip straight
    // to the judge phase on the same branch rather than re-running dev.
    if (state.retryJudge && state.iterations.length > 0) {
      state.retryJudge = false;
      const lastIter = state.iterations[state.iterations.length - 1];
      const iterationNum = lastIter.number;
      const branchName = lastIter.branch;

      // Ensure we're on the right branch
      await gitManager.checkoutBranch(project.repoPath, branchName);

      // Re-read the dev signals (they're still in the repo from the last run)
      const devSignals = await parseSignalFile(project.repoPath);

      // Jump straight to judge -- see the JUDGE section below
      await runJudgeAndDecide(
        project, state, lastIter, iterationNum, branchName, devSignals, packPath,
      );

      // If we returned (paused or stopped), exit the while loop
      if (isLoopDone(state)) {
        return;
      }
      // Otherwise continue to the next iteration
      continue;
    }

    // --- PREPARE ---
    state.phase = "preparing";
    await saveLoopState(state);

    // Validate problem pack BEFORE switching branches
    const packValidation = await validateProblemPack(packPath);
    if (!packValidation.valid) {
      throw new Error(
        `Problem Pack invalid: ${packValidation.errors.join(", ")}. Create a problem-pack/ directory with problem.md and success.md.`,
      );
    }

    const iterationNum = await nextIteration(project.id);
    if (iterationNum === null) {
      throw new Error("Failed to increment iteration counter");
    }
    state.currentIteration = iterationNum;

    // Create feature branch off current HEAD.
    // If the branch already exists (e.g., from a failed previous attempt),
    // delete it first so we get a fresh branch off the current HEAD --
    // not a stale branch that was created off a different base.
    const branchName = `cfcf/iteration-${iterationNum}`;
    if (await gitManager.branchExists(project.repoPath, branchName)) {
      // Delete the stale branch (we're not on it, since we haven't checked it out)
      await gitManager.deleteBranch(project.repoPath, branchName);
    }
    const branchResult = await gitManager.createBranch(project.repoPath, branchName);
    if (!branchResult.success) {
      throw new Error(`Failed to create branch ${branchName}: ${branchResult.error}`);
    }

    // Prepare log paths
    await ensureProjectLogDir(project.id);
    const devLogFile = getIterationLogPath(project.id, iterationNum, "dev");
    const judgeLogFile = getIterationLogPath(project.id, iterationNum, "judge");

    const iterRecord: LoopIterationRecord = {
      number: iterationNum,
      branch: branchName,
      devLogFile,
      judgeLogFile,
      startedAt: new Date().toISOString(),
      merged: false,
    };
    state.iterations.push(iterRecord);

    const problemPack = await readProblemPack(packPath);

    // Build iteration context
    // Read previous judge assessment if it exists
    let previousJudgeAssessment: string | undefined;
    let iterationHistory: string | undefined;
    try {
      previousJudgeAssessment = (await parseJudgeAssessment(project.repoPath)) ?? undefined;
    } catch { /* no previous assessment */ }

    // Build iteration history from previous iterations
    if (state.iterations.length > 1) {
      const historyLines: string[] = ["# Iteration History\n"];
      for (const prev of state.iterations.slice(0, -1)) {
        historyLines.push(`### Iteration ${prev.number}`);
        if (prev.devSignals) {
          historyLines.push(`- Status: ${prev.devSignals.status}`);
          historyLines.push(`- Assessment: ${prev.devSignals.self_assessment}`);
        }
        if (prev.judgeSignals) {
          historyLines.push(`- Judge: ${prev.judgeSignals.determination} (quality: ${prev.judgeSignals.quality_score}/10)`);
          if (prev.judgeSignals.key_concern) {
            historyLines.push(`- Concern: ${prev.judgeSignals.key_concern}`);
          }
        }
        historyLines.push("");
      }
      iterationHistory = historyLines.join("\n");
    }

    const ctx: IterationContext = {
      iteration: iterationNum,
      problemPack,
      project,
      previousJudgeAssessment,
      userFeedback: state.userFeedback,
      iterationHistory,
    };

    await writeContextToRepo(project.repoPath, ctx);

    // Generate agent instruction file
    const devAdapter = getAdapter(project.devAgent.adapter);
    if (!devAdapter) {
      throw new Error(`Unknown dev agent adapter: ${project.devAgent.adapter}`);
    }

    const instructionContent = generateInstructionContent(ctx);
    await writeFile(
      join(project.repoPath, devAdapter.instructionFilename),
      instructionContent,
      "utf-8",
    );

    // Prepare judge files
    await writeJudgeInstructions(project.repoPath, project, iterationNum);
    await resetJudgeSignals(project.repoPath);

    // --- DEV EXECUTE ---
    if (isStopped(state)) break;
    state.phase = "dev_executing";
    await saveLoopState(state);

    const devPrompt = `Read ${devAdapter.instructionFilename} and follow the instructions. Execute the iteration plan, then fill in cfcf-docs/iteration-handoff.md and cfcf-docs/cfcf-iteration-signals.json before exiting.`;
    const devCmd = devAdapter.buildCommand(project.repoPath, devPrompt, project.devAgent.model);

    const devProcess = await spawnProcess({
      command: devCmd.command,
      args: devCmd.args,
      cwd: project.repoPath,
      logFile: devLogFile,
    });

    const devResult = await devProcess.result;
    iterRecord.devExitCode = devResult.exitCode;

    // Check if stopped during dev execution
    if (isStopped(state)) break;

    // Collect dev results
    const handoff = await parseHandoffDocument(project.repoPath);
    const devSignals = await parseSignalFile(project.repoPath);
    iterRecord.devSignals = devSignals ?? undefined;

    // Commit dev work
    if (await gitManager.hasChanges(project.repoPath)) {
      await gitManager.commitAll(
        project.repoPath,
        `cfcf iteration ${iterationNum} dev (${project.devAgent.adapter})`,
      );
    }

    // --- JUDGE + DECIDE ---
    if (isStopped(state)) break;

    await runJudgeAndDecide(
      project, state, iterRecord, iterationNum, branchName, devSignals, packPath,
    );

    // If the judge+decide phase ended the loop (pause/complete/stop), exit
    if (isLoopDone(state)) {
      return;
    }
    // Otherwise continue to the next iteration
  }
}

/**
 * Run the judge agent and make a decision. Shared between normal flow and judge retry.
 * Modifies state and iterRecord in place.
 */
async function runJudgeAndDecide(
  project: ProjectConfig,
  state: LoopState,
  iterRecord: LoopIterationRecord,
  iterationNum: number,
  branchName: string,
  devSignals: DevSignals | null,
  _packPath: string,
): Promise<void> {
  state.phase = "judging";
  state.currentIteration = iterationNum;
  await saveLoopState(state);

  // Prepare judge files
  await writeJudgeInstructions(project.repoPath, project, iterationNum);
  await resetJudgeSignals(project.repoPath);

  const judgeLogFile = iterRecord.judgeLogFile;

  const judgeCmd = buildJudgeCommand(project);
  if (!judgeCmd) {
    throw new Error(`Unknown judge agent adapter: ${project.judgeAgent.adapter}`);
  }

  const judgeProcess = await spawnProcess({
    command: judgeCmd.command,
    args: judgeCmd.args,
    cwd: project.repoPath,
    logFile: judgeLogFile,
  });

  const judgeResult = await judgeProcess.result;
  iterRecord.judgeExitCode = judgeResult.exitCode;

  // Check if stopped during judge execution
  if (isStopped(state)) return;

  // Collect judge results
  const judgeSignals = await parseJudgeSignals(project.repoPath);
  const judgeAssessment = await parseJudgeAssessment(project.repoPath);
  iterRecord.judgeSignals = judgeSignals ?? undefined;

  // If judge exited with non-zero and produced no signals, log it
  if (judgeResult.exitCode !== 0 && !judgeSignals) {
    iterRecord.judgeError = `Judge agent exited with code ${judgeResult.exitCode}. Check log: ${judgeLogFile}`;
  }

  // Commit judge work
  if (await gitManager.hasChanges(project.repoPath)) {
    await gitManager.commitAll(
      project.repoPath,
      `cfcf iteration ${iterationNum} judge (${project.judgeAgent.adapter})`,
    );
  }

  // Archive judge assessment
  await archiveJudgeAssessment(project.repoPath, iterationNum);

  iterRecord.completedAt = new Date().toISOString();

  // --- DECIDE ---
  state.phase = "deciding";
  await saveLoopState(state);

  // Update consecutive stalled count
  if (judgeSignals?.determination === "STALLED") {
    state.consecutiveStalled++;
  } else {
    state.consecutiveStalled = 0;
  }

  const decision = makeDecision(judgeSignals, devSignals, state, project);

  // Merge branch to main if auto-merge and progress/success
  if (
    project.mergeStrategy === "auto" &&
    judgeSignals &&
    (judgeSignals.determination === "PROGRESS" || judgeSignals.determination === "SUCCESS")
  ) {
    const mainBranch = "main"; // TODO: detect default branch
    await gitManager.checkoutBranch(project.repoPath, mainBranch);
    const mergeResult = await gitManager.merge(
      project.repoPath,
      branchName,
      `Merge cfcf iteration ${iterationNum}`,
    );
    iterRecord.merged = mergeResult.success;
    if (!mergeResult.success) {
      // If merge fails, stay on the feature branch
      await gitManager.checkoutBranch(project.repoPath, branchName);
    }
  }

  // Clear user feedback after it's been consumed
  state.userFeedback = undefined;

  switch (decision.action) {
    case "stop":
      // Determine the final outcome
      const outcome = judgeSignals?.determination === "SUCCESS" ? "success" :
                      decision.pauseReason === "max_iterations" ? "max_iterations" :
                      "failure";

      // On success: run documenter BEFORE marking loop as completed
      // so the UI knows the documenter is still producing output.
      if (outcome === "success") {
        state.phase = "documenting";
        await saveLoopState(state);

        try {
          await runDocumentSync(project);
          if (await gitManager.hasChanges(project.repoPath)) {
            await gitManager.commitAll(
              project.repoPath,
              `cfcf documentation (${project.documenterAgent.adapter})`,
            );
          }
        } catch {
          // Documenter failure is not fatal -- the code is done
        }
      }

      state.phase = "completed";
      state.outcome = outcome;
      state.completedAt = new Date().toISOString();
      await saveLoopState(state);
      await updateProject(project.id, { status: "completed" });

      // Push to remote on success
      if (outcome === "success") {
        await gitManager.push(project.repoPath).catch(() => {
          // Push failure is not fatal
        });
      }
      return;

    case "pause":
      state.phase = "paused";
      state.pauseReason = decision.pauseReason;
      state.pendingQuestions = decision.questions;
      // If the dev phase succeeded but the judge failed, mark for retry
      // so resumeLoop() retries the judge on the same branch instead of
      // starting a new iteration from scratch.
      if (!judgeSignals && iterRecord.devExitCode === 0) {
        state.retryJudge = true;
      }
      await saveLoopState(state);
      await updateProject(project.id, { status: "paused" });
      return; // Loop exits -- will be restarted by resumeLoop()

    case "continue":
      await saveLoopState(state);
      // Caller continues to next iteration
      return;
  }
}
