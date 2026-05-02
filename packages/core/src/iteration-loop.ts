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
import { writeFile, readFile, mkdir } from "fs/promises";
import type { WorkspaceConfig, DevSignals, JudgeSignals, ReflectionSignals } from "./types.js";
import { getWorkspaceDir } from "./workspaces.js";
import {
  writeContextToRepo,
  generateInstructionContent,
  writeInstructionFile,
  parseHandoffDocument,
  parseSignalFile,
  type IterationContext,
} from "./context-assembler.js";
import {
  writeJudgeInstructions,
  resetJudgeSignals,
  buildJudgeCommand,
  parseJudgeSignals,
  parseJudgeAssessment,
  archiveJudgeAssessment,
} from "./judge-runner.js";
import { readProblemPack, validateProblemPack } from "./problem-pack.js";
import { getAdapter } from "./adapters/index.js";
import { spawnProcess } from "./process-manager.js";
import { getIterationLogPath, ensureWorkspaceLogDir } from "./log-storage.js";
import * as gitManager from "./git-manager.js";
import { nextIteration, updateWorkspace } from "./workspaces.js";
import { runDocumentSync } from "./documenter-runner.js";
import { runReflectionSync, parseReflectionSignals } from "./reflection-runner.js";
import { runReviewSync, readinessGateBlocks } from "./architect-runner.js";
import { appendHistoryEvent, updateHistoryEvent } from "./workspace-history.js";
import { registerProcess } from "./active-processes.js";
import { dispatchForWorkspace, makeEvent } from "./notifications/index.js";
import {
  getClioBackend,
  ingestReflectionAnalysis,
  ingestArchitectReview,
  ingestDecisionLogEntries,
  ingestIterationSummary,
  ingestRawIterationArtifacts,
  writeClioRelevant,
} from "./clio/index.js";
import { randomBytes } from "crypto";

// --- Loop State Types ---

export type LoopPhase =
  | "idle"
  | "pre_loop_reviewing"
  | "preparing"
  | "dev_executing"
  | "judging"
  | "reflecting"
  | "deciding"
  | "documenting"
  | "paused"
  | "completed"
  | "failed"
  | "stopped";

export interface LoopState {
  workspaceId: string;
  workspaceName: string;
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
  /**
   * Number of consecutive iterations the judge has opted out of reflection
   * (via `reflection_needed: false`). Reset to 0 each time reflection runs.
   * When this reaches `workspace.reflectSafeguardAfter`, the next iteration
   * forces reflection regardless of what the judge says. (item 5.6 U1)
   */
  iterationsSinceLastReflection?: number;
  /**
   * Whether cfcf has already emitted the `workspace.decision_log_large`
   * notification for this loop run. Prevents re-firing each iteration
   * once the 50-iteration threshold is crossed. (item 5.6 U4)
   */
  decisionLogWarningFired?: boolean;
  /**
   * Set to true once the pre-loop Solution Architect review has run
   * (and the readiness gate accepted the result). Prevents re-running
   * the pre-loop review on resume after a pause. (item 5.1)
   */
  preLoopReviewCompleted?: boolean;
  /**
   * Per-run overrides for the three 5.1 config keys. When set, these
   * take precedence over the workspace/global defaults for the lifetime
   * of this loop. Persisted on loop-state.json so resume keeps the same
   * behaviour across server restarts. (item 5.1)
   */
  runOverrides?: {
    autoReviewSpecs?: boolean;
    autoDocumenter?: boolean;
    readinessGate?: import("./types.js").ReadinessGate;
  };
  /**
   * Structured action chosen by the user when resuming a paused loop
   * (item 6.25). Set by `resumeLoop`; consumed + cleared by `runLoop`
   * on the next iteration of the work pump. Default behaviour (when
   * absent or set to "continue") matches pre-6.25: spawn next dev
   * iteration with `userFeedback` as prompt context.
   */
  resumeAction?: import("./types.js").ResumeAction;
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
  /** Log filenames only (for web clients) */
  devLogFileName: string;
  judgeLogFileName: string;
  /** History event ID */
  historyEventId: string;
  startedAt: string;
  completedAt?: string;
  merged: boolean;
  /** Reflection outcome for this iteration (item 5.6). */
  reflectionRan?: boolean;
  reflectionSignals?: ReflectionSignals;
  reflectionLogFileName?: string;
  reflectionExitCode?: number;
  /** When the reflection agent's plan rewrite was rejected by the
   *  non-destructive validator, this captures the reason for the audit
   *  trail. The previous plan.md is restored on disk. */
  reflectionPlanRejectionReason?: string;
}

// --- State Store (in-memory + disk persistence) ---

const loopStore = new Map<string, LoopState>();

const LOOP_STATE_FILENAME = "loop-state.json";

/**
 * Get the path to the loop state file for a workspace.
 */
function getLoopStatePath(workspaceId: string): string {
  return join(getWorkspaceDir(workspaceId), LOOP_STATE_FILENAME);
}

/**
 * Persist loop state to disk. Called on every phase transition.
 */
async function persistLoopState(state: LoopState): Promise<void> {
  const dir = getWorkspaceDir(state.workspaceId);
  await mkdir(dir, { recursive: true });
  const path = getLoopStatePath(state.workspaceId);
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/**
 * Load loop state from disk. Returns null if no persisted state exists.
 */
async function loadLoopState(workspaceId: string): Promise<LoopState | null> {
  try {
    const path = getLoopStatePath(workspaceId);
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
  loopStore.set(state.workspaceId, state);
  await persistLoopState(state);
}

/**
 * Clean up stale loop-state files on server startup.
 * Any loop-state.json whose phase is an active phase (preparing, dev_executing,
 * judging, deciding, documenting) is orphaned because the agent process did
 * not survive the server restart. Marks these as "failed" with a clear error.
 *
 * Returns the number of loops marked failed.
 */
export async function cleanupStaleActiveLoops(
  reason: string = "Server restarted while this loop was in progress",
): Promise<number> {
  const { listWorkspaces } = await import("./workspaces.js");
  const workspaces = await listWorkspaces();
  let total = 0;
  const activePhases: LoopPhase[] = [
    "preparing",
    "dev_executing",
    "judging",
    "deciding",
    "documenting",
  ];

  for (const w of workspaces) {
    const state = await loadLoopState(w.id);
    if (!state) continue;
    if (activePhases.includes(state.phase)) {
      state.phase = "failed";
      state.error = `${reason} (was in phase: ${state.phase === "failed" ? "unknown" : state.phase})`;
      state.completedAt = new Date().toISOString();
      state.outcome = "failure";
      await persistLoopState(state);
      await updateWorkspace(w.id, { status: "failed" }).catch(() => {});
      total++;
    }
  }

  return total;
}

/**
 * Get the loop state for a workspace.
 * Checks in-memory cache first, then falls back to disk.
 */
export async function getLoopState(workspaceId: string): Promise<LoopState | undefined> {
  // Check in-memory first
  const cached = loopStore.get(workspaceId);
  if (cached) return cached;

  // Fall back to disk
  const persisted = await loadLoopState(workspaceId);
  if (persisted) {
    loopStore.set(workspaceId, persisted);
    return persisted;
  }

  return undefined;
}

// --- Per-loop effective config (item 5.1) ---

/**
 * Resolve the three 5.1 config keys for this loop, respecting the
 * priority order: per-run overrides (from `cfcf run --auto-review` etc.)
 * → workspace config → hard defaults. Workspace config was already merged
 * with global defaults by `getWorkspace()`, so we don't look at global
 * here.
 */
export function resolveLoopConfig(
  workspace: WorkspaceConfig,
  state: LoopState,
): {
  autoReviewSpecs: boolean;
  autoDocumenter: boolean;
  readinessGate: import("./types.js").ReadinessGate;
} {
  const o = state.runOverrides ?? {};
  return {
    autoReviewSpecs: o.autoReviewSpecs ?? workspace.autoReviewSpecs ?? false,
    autoDocumenter: o.autoDocumenter ?? workspace.autoDocumenter ?? true,
    readinessGate: o.readinessGate ?? workspace.readinessGate ?? "blocked",
  };
}

// --- Reflection trigger logic (item 5.6 §2.2) ---

/**
 * Decide whether reflection should run after the judge completes.
 *
 * Rules (research doc §2.2):
 *   - Run reflection when `judge.reflection_needed` is `true` or missing.
 *   - Skip reflection when `judge.reflection_needed` is `false` AND the
 *     number of consecutive skips has not yet reached the safeguard
 *     ceiling `reflectSafeguardAfter` (default 3).
 *   - Force reflection when we've already hit the safeguard ceiling.
 *   - If judge signals are missing entirely (judge crashed / malformed
 *     output), skip reflection too -- the harness will already pause
 *     on the missing signals and retry the judge on resume.
 */
export function shouldRunReflection(
  judgeSignals: JudgeSignals | null,
  state: LoopState,
  workspace: WorkspaceConfig,
): { run: boolean; reason: string } {
  if (!judgeSignals) {
    return { run: false, reason: "judge signals missing -- harness will pause before reflection" };
  }
  const ceiling = workspace.reflectSafeguardAfter ?? 3;
  const skipped = state.iterationsSinceLastReflection ?? 0;

  if (judgeSignals.reflection_needed === false) {
    if (skipped + 1 >= ceiling) {
      // This would be the (ceiling)th consecutive skip -> force reflection.
      return {
        run: true,
        reason: `judge opted out but safeguard ceiling reached (${skipped + 1} >= ${ceiling}); forcing reflection`,
      };
    }
    return {
      run: false,
      reason: `judge opted out (reflection_needed=false); skip count ${skipped + 1} < ceiling ${ceiling}`,
    };
  }
  // reflection_needed === true OR undefined/null
  return {
    run: true,
    reason: judgeSignals.reflection_needed === true
      ? `judge requested reflection${judgeSignals.reflection_reason ? `: "${judgeSignals.reflection_reason}"` : ""}`
      : "judge did not set reflection_needed; default is to run",
  };
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
 *
 * Reflection's `recommend_stop` (research Q5/Q6) takes precedence over
 * the judge's determination: reflection has the cross-iteration view,
 * so when it flags the loop as fundamentally stuck we pause for the
 * user even if the judge said PROGRESS.
 *
 * **Disambiguation on judge SUCCESS** (2026-05-01 fix): when reflection
 * runs on a SUCCESS iteration (e.g. via the `reflectSafeguardAfter`
 * ceiling) and sets `recommend_stop=true`, the boolean is ambiguous
 * between "I agree with SUCCESS, mission accomplished" and "judge said
 * SUCCESS but I disagree, more work is needed." We disambiguate via
 * `iteration_health`:
 *   - `converging` / `stable` → reflection AGREES with SUCCESS; let
 *     the judge's determination handle the stop (no popup).
 *   - `stalled` / `diverging` / `inconclusive` → reflection DISAGREES
 *     with SUCCESS; surface as user-arbitration popup so the user can
 *     choose to dismiss (accept SUCCESS) or feed back to trigger more
 *     iterations.
 * On non-SUCCESS judge determinations, `recommend_stop=true` retains
 * its original meaning (loop is stuck → pause + popup) regardless of
 * `iteration_health`.
 */
export function makeDecision(
  judgeSignals: JudgeSignals | null,
  devSignals: DevSignals | null,
  state: LoopState,
  workspace: WorkspaceConfig,
  reflectionSignals?: ReflectionSignals | null,
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

  // Reflection's recommend_stop wins over the judge's determination
  // (research doc Q5, Q6). Never auto-stops -- always pauses + notifies.
  // Exception: when judge=SUCCESS and reflection's iteration_health
  // signals agreement (converging/stable), let SUCCESS handle the stop
  // -- the recommend_stop=true is reflection agreeing with the judge,
  // not flagging a problem. See doc-comment above.
  if (reflectionSignals?.recommend_stop === true) {
    const reflectionAgreesWithSuccess =
      judgeSignals?.determination === "SUCCESS" &&
      (reflectionSignals.iteration_health === "converging" ||
        reflectionSignals.iteration_health === "stable");
    if (!reflectionAgreesWithSuccess) {
      return {
        action: "pause",
        reason: `Reflection flagged loop as stuck: ${reflectionSignals.key_observation || "no summary"}`,
        pauseReason: "anomaly",
        questions: reflectionSignals.key_observation ? [reflectionSignals.key_observation] : [],
      };
    }
    // else: fall through to judge-determination handling below; the
    // SUCCESS case will return action: "stop" naturally.
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
      switch (workspace.onStalled) {
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
 * Start the iteration loop for a workspace.
 * Runs in the background -- returns the initial state immediately.
 */
export async function startLoop(
  workspace: WorkspaceConfig,
  opts?: {
    problemPackPath?: string;
    /** Per-run overrides for the 5.1 config keys. Persisted on loop-state. */
    autoReviewSpecs?: boolean;
    autoDocumenter?: boolean;
    readinessGate?: import("./types.js").ReadinessGate;
  },
): Promise<LoopState> {
  const existing = await getLoopState(workspace.id);
  if (existing && existing.phase !== "completed" && existing.phase !== "failed" && existing.phase !== "stopped") {
    throw new Error(`Loop already active for workspace ${workspace.name} (phase: ${existing.phase})`);
  }

  const runOverrides =
    opts?.autoReviewSpecs !== undefined ||
    opts?.autoDocumenter !== undefined ||
    opts?.readinessGate !== undefined
      ? {
          autoReviewSpecs: opts?.autoReviewSpecs,
          autoDocumenter: opts?.autoDocumenter,
          readinessGate: opts?.readinessGate,
        }
      : undefined;

  const state: LoopState = {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    phase: "idle",
    currentIteration: 0,
    maxIterations: workspace.maxIterations,
    pauseEvery: workspace.pauseEvery,
    startedAt: new Date().toISOString(),
    iterations: [],
    consecutiveStalled: 0,
    runOverrides,
  };

  await saveLoopState(state);

  // Update workspace status
  await updateWorkspace(workspace.id, { status: "running" });

  // Run loop in background. Error handler is itself try/catch-wrapped so a
  // disk write failure during error recording doesn't silently swallow the error.
  runLoop(workspace, state, opts).catch(async (err) => {
    try {
      state.phase = "failed";
      state.error = err instanceof Error ? err.message : String(err);
      state.completedAt = new Date().toISOString();
      await saveLoopState(state);
      updateWorkspace(workspace.id, { status: "failed" }).catch(() => {});
      dispatchForWorkspace(
        makeEvent({
          type: "loop.completed",
          title: "Loop failed",
          message: `${workspace.name}: ${state.error}`,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          details: { outcome: "failure", error: state.error },
        }),
        workspace.notifications,
      );
    } catch (handlerErr) {
      console.error(`[iteration-loop] Failed to record error for ${workspace.id}:`, handlerErr);
      console.error(`  Original error:`, err);
    }
  });

  return state;
}

/**
 * Compute which `ResumeAction` values are applicable for a given pause
 * scenario (item 6.25 — see docs/research/structured-pause-actions-design.md).
 *
 * Drives both UI button visibility (`FeedbackForm`) and CLI argument
 * validation (`cfcf resume --action <enum>`). Single source of truth so
 * the two surfaces stay in sync.
 *
 * Optional `signals` argument enables sub-case discrimination beyond
 * `pauseReason` alone (A2 dev-mid-iter vs A3 judge-needs-input;
 * A6 reflection-stuck vs A4/A5/A9 judge-state-anomaly; A8 judge-missing).
 * When `signals` is absent, returns the permissive superset for the
 * pause class.
 */
export function pauseReasonAllowedActions(
  pauseReason: LoopState["pauseReason"],
  signals?: {
    judge?: JudgeSignals | null;
    dev?: DevSignals | null;
    reflection?: ReflectionSignals | null;
  },
): import("./types.js").ResumeAction[] {
  // Mapping per docs/research/structured-pause-actions-design.md matrix;
  // keep this in sync with that doc.
  switch (pauseReason) {
    case "user_input_needed":
      // A2 (dev mid-iter) vs A3 (judge needs input). The dev case is a
      // strict subset because dev hasn't finished -- finish_loop and
      // refine_plan don't apply. Discriminate via dev signals if given.
      if (signals?.dev?.user_input_needed) {
        return ["continue", "stop_loop_now"];
      }
      // A3 (judge user_input_needed) -- full set
      return ["continue", "finish_loop", "stop_loop_now", "refine_plan", "consult_reflection"];

    case "anomaly":
      // A4 ANOMALY | A5 STALLED+alert | A6 reflection-stuck | A8 missing-judge | A9 unknown-judge.
      // Discriminate the broken-judge cases (A8) via null judge.
      if (signals?.judge === null) {
        return ["stop_loop_now", "refine_plan"];
      }
      // A4 / A5 / A6 / A9 -- full set including consult_reflection (A6
      // re-spawns reflection with user feedback as fresh context;
      // decided 2026-05-01 alongside the design doc).
      return ["continue", "finish_loop", "stop_loop_now", "refine_plan", "consult_reflection"];

    case "cadence":
      // A7: routine check-in; full set applicable.
      return ["continue", "finish_loop", "stop_loop_now", "refine_plan", "consult_reflection"];

    case "max_iterations":
      // B1: ceiling reached -- only finish_loop (run docs if configured)
      // or stop_loop_now make sense.
      return ["finish_loop", "stop_loop_now"];

    default:
      // A1 pre-loop review blocked. continue (after user edited the
      // Problem Pack), stop_loop_now, refine_plan (re-run architect
      // re-review). finish_loop ✗ (no iters yet); consult_reflection
      // ✗ (no iterations for reflection to reflect on).
      return ["continue", "stop_loop_now", "refine_plan"];
  }
}

/**
 * Resume a paused loop with the user's structured action + optional
 * free-text feedback (item 6.25).
 *
 * Default `action: "continue"` preserves pre-6.25 behaviour for any
 * caller (CLI without --action, API request without action field) so
 * existing automation/scripts keep working.
 */
export async function resumeLoop(
  workspaceId: string,
  feedback?: string,
  action: import("./types.js").ResumeAction = "continue",
): Promise<LoopState> {
  const state = await getLoopState(workspaceId);
  if (!state) {
    throw new Error("No active loop for this workspace");
  }
  if (state.phase !== "paused") {
    throw new Error(`Loop is not paused (current phase: ${state.phase})`);
  }

  // Validate the action against the pause scenario. Reject early with a
  // clear error so CLI / API callers don't silently get a no-op resume.
  const allowed = pauseReasonAllowedActions(state.pauseReason);
  if (!allowed.includes(action)) {
    throw new Error(
      `Action '${action}' is not applicable for this pause (reason: ${state.pauseReason ?? "pre-loop"}). Allowed: ${allowed.join(", ")}.`,
    );
  }

  state.userFeedback = feedback;
  state.resumeAction = action;
  state.pauseReason = undefined;
  state.pendingQuestions = undefined;

  // Re-read the workspace config in case it was updated
  const { getWorkspace } = await import("./workspaces.js");
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) {
    throw new Error("Workspace not found");
  }

  await saveLoopState(state);
  await updateWorkspace(workspaceId, { status: "running" });

  // Resume loop in background. Error handler itself is try/catch-wrapped.
  runLoop(workspace, state).catch(async (err) => {
    try {
      state.phase = "failed";
      state.error = err instanceof Error ? err.message : String(err);
      state.completedAt = new Date().toISOString();
      await saveLoopState(state);
      updateWorkspace(workspaceId, { status: "failed" }).catch(() => {});
    } catch (handlerErr) {
      console.error(`[iteration-loop] Failed to record resume error for ${workspaceId}:`, handlerErr);
      console.error(`  Original error:`, err);
    }
  });

  return state;
}

/**
 * Stop a running or paused loop.
 */
export async function stopLoop(workspaceId: string): Promise<LoopState> {
  const state = await getLoopState(workspaceId);
  if (!state) {
    throw new Error("No active loop for this workspace");
  }
  if (state.phase === "completed" || state.phase === "failed" || state.phase === "stopped") {
    throw new Error(`Loop already ended (phase: ${state.phase})`);
  }

  state.phase = "stopped";
  state.outcome = "stopped";
  state.completedAt = new Date().toISOString();
  await saveLoopState(state);
  await updateWorkspace(workspaceId, { status: "stopped" });

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

/** Map a pause reason to a human-readable title for notifications */
function pauseReasonTitle(reason?: LoopState["pauseReason"]): string {
  switch (reason) {
    case "cadence":
      return "Loop paused for review";
    case "anomaly":
      return "Loop paused: anomaly detected";
    case "user_input_needed":
      return "Loop needs your input";
    case "max_iterations":
      return "Loop reached max iterations";
    default:
      return "Loop paused";
  }
}

/**
 * Check if the loop has reached a terminal or paused state.
 * Used after calling runJudgeAndDecide() which mutates state.phase.
 */
function isLoopDone(state: LoopState): boolean {
  return state.phase === "paused" || state.phase === "completed" || state.phase === "stopped";
}

// --- Resume-action handlers (item 6.25) ---

/**
 * Handle the `stop_loop_now` resume action: terminate the loop
 * immediately, no documenter, capture the user's free-text feedback as
 * an audit note in both `history.json` (as a `loop-stopped` event) and
 * the human-readable `iteration-history.md`. Per design decision
 * 2026-05-01 (docs/research/structured-pause-actions-design.md §5).
 */
async function handleStopLoopNow(
  workspace: WorkspaceConfig,
  state: LoopState,
): Promise<void> {
  const userFeedback = state.userFeedback;
  state.userFeedback = undefined;
  state.phase = "stopped";
  state.outcome = "stopped";
  state.completedAt = new Date().toISOString();

  // Append a structured event to history.json so the web UI History
  // tab + downstream automation can see why the loop ended.
  const historyEventId = randomBytes(8).toString("hex");
  await appendHistoryEvent(workspace.id, {
    id: historyEventId,
    type: "loop-stopped",
    status: "completed",
    startedAt: state.completedAt,
    completedAt: state.completedAt,
    iteration: state.currentIteration,
    userFeedback,
  } as import("./workspace-history.js").LoopStoppedHistoryEvent);

  // Append a human-readable narrative to iteration-history.md so the
  // markdown ledger also captures the stop reason. Best-effort —
  // failure to write the narrative does not fail the stop.
  try {
    const lines: string[] = [
      "",
      `## Loop stopped at iteration ${state.currentIteration}`,
      "",
      `Stopped by user via \`stop_loop_now\` resume action on ${state.completedAt}.`,
      "",
    ];
    if (userFeedback?.trim()) {
      lines.push(`**User note:** ${userFeedback.trim()}`, "");
    }
    const histPath = join(workspace.repoPath, "cfcf-docs", "iteration-history.md");
    const { appendFile } = await import("node:fs/promises");
    await appendFile(histPath, lines.join("\n"), "utf-8");
  } catch (err) {
    console.warn(`[stop_loop_now] failed to append narrative to iteration-history.md: ${err instanceof Error ? err.message : String(err)}`);
  }

  await saveLoopState(state);
  await updateWorkspace(workspace.id, { status: "stopped" });

  dispatchForWorkspace(
    makeEvent({
      type: "loop.completed",
      title: "Loop stopped by user",
      message: `${workspace.name}: stopped at iteration ${state.currentIteration} via stop_loop_now${userFeedback?.trim() ? ` — "${userFeedback.trim().slice(0, 80)}${userFeedback.trim().length > 80 ? "…" : ""}"` : ""}`,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      details: { outcome: "stopped", iterations: state.currentIteration, userFeedback },
    }),
    workspace.notifications,
  );
}

/**
 * Handle the `finish_loop` resume action: skip the iteration spawn,
 * jump to the configured end-of-loop sequence (documenter when
 * `autoDocumenter=true`; otherwise just terminate cleanly with success
 * outcome). Per design decision 2026-05-01: respect `autoDocumenter`
 * config — `finish_loop` doesn't override the user's documenter
 * preference, only their loop-completion intent.
 */
async function handleFinishLoop(
  workspace: WorkspaceConfig,
  state: LoopState,
  loopCfg: { autoDocumenter: boolean },
): Promise<void> {
  const userFeedback = state.userFeedback;
  state.userFeedback = undefined;

  if (loopCfg.autoDocumenter) {
    state.phase = "documenting";
    await saveLoopState(state);

    try {
      const docResult = await runDocumentSync(workspace, { userFeedback });
      let committed = false;
      if (await gitManager.hasChanges(workspace.repoPath)) {
        const commitResult = await gitManager.commitAll(
          workspace.repoPath,
          `cfcf documentation (${workspace.documenterAgent.adapter})`,
        );
        committed = commitResult.success;
      }
      await updateHistoryEvent(workspace.id, docResult.historyEventId, {
        committed,
      } as Partial<import("./workspace-history.js").DocumentHistoryEvent>);
    } catch (err) {
      console.warn(`[finish_loop] documenter failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  state.phase = "completed";
  state.outcome = "success";
  state.completedAt = new Date().toISOString();
  await saveLoopState(state);
  await updateWorkspace(workspace.id, { status: "completed" });

  dispatchForWorkspace(
    makeEvent({
      type: "loop.completed",
      title: "Loop finished by user",
      message: `${workspace.name}: finished at iteration ${state.currentIteration} via finish_loop${loopCfg.autoDocumenter ? " (documenter ran)" : " (autoDocumenter=false; no docs)"}`,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      details: { outcome: "success", iterations: state.currentIteration, finishedByUser: true },
    }),
    workspace.notifications,
  );

  // Push to remote on success (mirrors the natural-success path).
  await gitManager.push(workspace.repoPath).catch(() => {});
}

/**
 * Handle the `consult_reflection` resume action: spawn reflection in
 * consult mode with the user's feedback as input. Reflection sets
 * `harness_action_recommendation` in its signals; we route per the
 * recommendation:
 *   - "stop_loop_now"   → finalize via handleStopLoopNow → return "stop"
 *   - "finish_loop"     → finalize via handleFinishLoop → return "stop"
 *   - "pause_for_user"  → re-pause with reflection's new key_observation → return "stop"
 *   - "continue"        → fall through to next iteration → return "continue"
 *   - undefined         → treat as "continue" (reflection didn't disambiguate)
 */
async function handleConsultReflection(
  workspace: WorkspaceConfig,
  state: LoopState,
): Promise<"continue" | "stop"> {
  const userFeedback = state.userFeedback;
  state.userFeedback = undefined;

  let recommendation: ReflectionSignals["harness_action_recommendation"];
  try {
    const result = await runReflectionSync(workspace, state.currentIteration, {
      consultMode: true,
      userFeedback,
    });
    recommendation = result.signals?.harness_action_recommendation;
  } catch (err) {
    console.warn(`[consult_reflection] reflection spawn failed: ${err instanceof Error ? err.message : String(err)}`);
    // On failure, bounce back to user via re-pause with a clear note.
    state.phase = "paused";
    state.pauseReason = "anomaly";
    state.pendingQuestions = [
      `consult_reflection: reflection agent failed to run (${err instanceof Error ? err.message : String(err)}). Pick a different action to resume.`,
    ];
    await saveLoopState(state);
    await updateWorkspace(workspace.id, { status: "paused" });
    return "stop";
  }

  if (recommendation === "stop_loop_now") {
    await handleStopLoopNow(workspace, state);
    return "stop";
  }
  if (recommendation === "finish_loop") {
    await handleFinishLoop(workspace, state, resolveLoopConfig(workspace, state));
    return "stop";
  }
  if (recommendation === "pause_for_user") {
    // Reflection couldn't decide; bounce back. Use its key_observation
    // as the new question so the user knows what the ambiguity was.
    state.phase = "paused";
    state.pauseReason = "anomaly";
    // Read the reflection signals from disk so we have the latest
    // key_observation (runReflectionSync's return shape may not
    // expose it directly).
    const sigs = await parseReflectionSignals(workspace.repoPath);
    state.pendingQuestions = [
      sigs?.key_observation ?? "Reflection consulted but couldn't decide on a next step. Pick an action to proceed.",
    ];
    await saveLoopState(state);
    await updateWorkspace(workspace.id, { status: "paused" });
    return "stop";
  }
  // "continue" or undefined → fall through to next iteration.
  return "continue";
}

/**
 * The main iteration loop.
 * Runs iterations until a stop condition is met or the loop is paused.
 */
async function runLoop(
  workspace: WorkspaceConfig,
  state: LoopState,
  opts?: { problemPackPath?: string },
): Promise<void> {
  const packPath = opts?.problemPackPath || join(workspace.repoPath, "problem-pack");
  const loopCfg = resolveLoopConfig(workspace, state);

  // --- RESUME ACTION HANDLING (item 6.25) ---
  // When the user resumes a paused loop with a structured action, route
  // before the normal iteration flow runs. "continue" falls through to
  // the existing pre-loop / iteration logic; other actions either
  // terminate early (stop_loop_now / finish_loop) or run a one-shot
  // agent and then fall through (refine_plan / consult_reflection).
  // The action is consumed (cleared) here so it doesn't re-fire on the
  // next iteration's resume cycle.
  const resumeAction = state.resumeAction;
  state.resumeAction = undefined;
  if (resumeAction === "stop_loop_now") {
    await handleStopLoopNow(workspace, state);
    return;
  }
  if (resumeAction === "finish_loop") {
    await handleFinishLoop(workspace, state, loopCfg);
    return;
  }
  if (resumeAction === "refine_plan") {
    // Sync architect re-review with userFeedback as direction.
    // Architect runner consumes state.userFeedback via writeContextToRepo;
    // we don't clear it here — the next dev iteration may still want it
    // as broader context (it'll be cleared after that iteration consumes
    // it, mirroring the existing flow).
    try {
      await runReviewSync(workspace, {
        problemPackPath: packPath,
        userFeedback: state.userFeedback,
        trigger: "loop",
      });
      // Commit any architect outputs to current branch (mirrors the
      // pre-loop review block's behaviour).
      if (await gitManager.hasChanges(workspace.repoPath)) {
        await gitManager.commitAll(
          workspace.repoPath,
          `cfcf architect re-review (refine_plan resume action, item 6.25)`,
        );
      }
    } catch (err) {
      // If the architect spawn itself fails, log and fall through to
      // the iteration loop anyway -- the failure is captured in the
      // architect history event.
      console.warn(`[refine_plan] architect re-review failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Fall through to the regular pre-loop / iteration logic.
  }
  if (resumeAction === "consult_reflection") {
    // Spawn reflection in consult mode with userFeedback as input.
    // Reflection sets harness_action_recommendation; route per its
    // recommendation (or fall through to next iteration on "continue").
    const consultResult = await handleConsultReflection(workspace, state);
    if (consultResult === "stop") return;
    // "continue" or "pause_for_user" → fall through (pause_for_user
    // is handled inside the consult helper, which sets the pause state
    // and returns "stop" to abort runLoop).
  }

  // --- PRE-LOOP REVIEW (item 5.1 autoReviewSpecs=true) ---
  // Runs before iteration 1, not on resume. When the readiness gate
  // accepts the result, commit the architect's outputs to main (the
  // current branch) -- review output is a deterministic input to the
  // loop, not iteration work, so it does NOT live on an iteration
  // branch. If the gate rejects, pause the loop and surface the gaps
  // via the standard `loop.paused` notification so the user knows what
  // to edit in the Problem Pack before retrying.
  if (
    loopCfg.autoReviewSpecs &&
    !state.preLoopReviewCompleted &&
    state.iterations.length === 0 &&
    !isStopped(state)
  ) {
    state.phase = "pre_loop_reviewing";
    await saveLoopState(state);

    let reviewRes: Awaited<ReturnType<typeof runReviewSync>> | null = null;
    let reviewError: string | undefined;
    try {
      // Pass through userFeedback so any guidance the user typed on the
      // FeedbackForm (or `cfcf resume --feedback`) reaches the architect
      // on the next spawn. Without this the user's feedback was being
      // silently dropped for pre-loop-review resumes (pre-v0.7.2).
      reviewRes = await runReviewSync(workspace, {
        problemPackPath: packPath,
        userFeedback: state.userFeedback,
        trigger: "loop",
      });
    } catch (err) {
      reviewError = err instanceof Error ? err.message : String(err);
    }

    if (isStopped(state)) return;

    const readiness = reviewRes?.signals?.readiness;
    const blocked = readinessGateBlocks(readiness, loopCfg.readinessGate);

    // Commit whatever the architect produced to the current branch
    // regardless of gate outcome. The artifacts (architect-review.md,
    // plan.md, docs/ stubs, signals) are useful to the user even when
    // the gate blocks.
    if (await gitManager.hasChanges(workspace.repoPath)) {
      const subject = readiness
        ? `cfcf pre-loop review (${readiness})`
        : "cfcf pre-loop review (signals missing)";
      await gitManager.commitAll(workspace.repoPath, subject);
    }

    // Clio ingest (item 5.7 PR3): auto-ingest architect-review.md as a
    // semantic artifact whether or not the gate accepts. Failures are
    // swallowed.
    try {
      await ingestArchitectReview(getClioBackend(), workspace, "loop", readiness);
    } catch (err) {
      console.warn(`[clio] pre-loop architect-review ingest failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (blocked || reviewError) {
      // Gate rejected -- pause the loop. User edits problem pack, then
      // resumes, which will re-enter this block and re-review.
      state.phase = "paused";
      state.pauseReason = "anomaly";
      const reason = reviewError
        ? `Pre-loop review failed: ${reviewError}`
        : `Pre-loop review readiness=${readiness ?? "missing"} does not satisfy gate="${loopCfg.readinessGate}". Edit the Problem Pack and resume.`;
      const questions = reviewRes?.signals?.gaps?.slice(0, 5) ?? [];
      state.pendingQuestions = questions.length ? questions : [reason];
      await saveLoopState(state);
      await updateWorkspace(workspace.id, { status: "paused" });

      dispatchForWorkspace(
        makeEvent({
          type: "loop.paused",
          title: "Pre-loop review blocked the loop",
          message: `${workspace.name}: ${reason}`,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          details: {
            pauseReason: "anomaly",
            kind: "pre_loop_review_blocked",
            readiness,
            gate: loopCfg.readinessGate,
            gaps: questions,
          },
        }),
        workspace.notifications,
      );
      return;
    }

    // Gate accepted -- mark as complete so resume after a later pause
    // does not re-run the review. Fall through to the while loop.
    state.preLoopReviewCompleted = true;
    await saveLoopState(state);
  }

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
      await gitManager.checkoutBranch(workspace.repoPath, branchName);

      // Re-read the dev signals (they're still in the repo from the last run)
      const devSignals = await parseSignalFile(workspace.repoPath);

      // Jump straight to judge -- see the JUDGE section below
      await runJudgeAndDecide(
        workspace, state, lastIter, iterationNum, branchName, devSignals, packPath,
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

    const iterationNum = await nextIteration(workspace.id);
    if (iterationNum === null) {
      throw new Error("Failed to increment iteration counter");
    }
    state.currentIteration = iterationNum;

    // Create feature branch off current HEAD.
    // If the branch already exists (e.g., from a failed previous attempt),
    // delete it first so we get a fresh branch off the current HEAD --
    // not a stale branch that was created off a different base.
    const branchName = `cfcf/iteration-${iterationNum}`;
    if (await gitManager.branchExists(workspace.repoPath, branchName)) {
      // Delete the stale branch (we're not on it, since we haven't checked it out)
      await gitManager.deleteBranch(workspace.repoPath, branchName);
    }
    const branchResult = await gitManager.createBranch(workspace.repoPath, branchName);
    if (!branchResult.success) {
      throw new Error(`Failed to create branch ${branchName}: ${branchResult.error}`);
    }

    // Prepare log paths
    await ensureWorkspaceLogDir(workspace.id);
    const devLogFile = getIterationLogPath(workspace.id, iterationNum, "dev");
    const judgeLogFile = getIterationLogPath(workspace.id, iterationNum, "judge");
    const iterStr = String(iterationNum).padStart(3, "0");
    const devLogFileName = `iteration-${iterStr}-dev.log`;
    const judgeLogFileName = `iteration-${iterStr}-judge.log`;

    const historyEventId = randomBytes(8).toString("hex");
    const startedAt = new Date().toISOString();

    const iterRecord: LoopIterationRecord = {
      number: iterationNum,
      branch: branchName,
      devLogFile,
      judgeLogFile,
      devLogFileName,
      judgeLogFileName,
      historyEventId,
      startedAt,
      merged: false,
    };
    state.iterations.push(iterRecord);

    // Record history event (will be updated when iteration completes)
    await appendHistoryEvent(workspace.id, {
      id: historyEventId,
      type: "iteration",
      status: "running",
      startedAt,
      iteration: iterationNum,
      branch: branchName,
      logFile: devLogFileName, // primary log file for display
      devLogFile: devLogFileName,
      judgeLogFile: judgeLogFileName,
      agent: workspace.devAgent.adapter, // used by BaseHistoryEvent
      model: workspace.devAgent.model,
      devAgent: workspace.devAgent.adapter,
      judgeAgent: workspace.judgeAgent.adapter,
    });

    const problemPack = await readProblemPack(packPath);

    // Build iteration context
    // Read previous judge assessment if it exists
    let previousJudgeAssessment: string | undefined;
    let iterationHistory: string | undefined;
    try {
      previousJudgeAssessment = (await parseJudgeAssessment(workspace.repoPath)) ?? undefined;
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
      workspace,
      previousJudgeAssessment,
      userFeedback: state.userFeedback,
      iterationHistory,
    };

    await writeContextToRepo(workspace.repoPath, ctx);

    // Clio context preload (item 5.7 PR3): generate
    // `cfcf-docs/clio-relevant.md` with top-k cross-workspace hits matched
    // against this workspace's problem.md. Reads through the same backend
    // used by auto-ingest. Failures are swallowed + the file is left
    // un-generated for this iteration (agents still have all other Tier-2
    // reads); we log a warning so it's visible in the server log.
    try {
      await writeClioRelevant(getClioBackend(), workspace, problemPack.problem);
    } catch (err) {
      console.warn(`[clio] clio-relevant.md generation failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Generate agent instruction file
    const devAdapter = getAdapter(workspace.devAgent.adapter);
    if (!devAdapter) {
      throw new Error(`Unknown dev agent adapter: ${workspace.devAgent.adapter}`);
    }

    // Merge into the dev agent's instruction file (CLAUDE.md / AGENTS.md /
    // adapter-specific) using sentinel markers. Any user-authored content
    // *outside* the `<!-- cfcf:begin --> ... <!-- cfcf:end -->` block is
    // preserved across iterations; only the cfcf-owned block is refreshed.
    const instructionContent = generateInstructionContent(ctx);
    await writeInstructionFile(
      workspace.repoPath,
      devAdapter.instructionFilename,
      instructionContent,
    );

    // Prepare judge files
    await writeJudgeInstructions(workspace.repoPath, workspace, iterationNum);
    await resetJudgeSignals(workspace.repoPath);

    // --- DEV EXECUTE ---
    if (isStopped(state)) break;
    state.phase = "dev_executing";
    await saveLoopState(state);

    const devPrompt = `Read ${devAdapter.instructionFilename} and follow the instructions. This is a single iteration in a multi-iteration loop -- execute only the next pending chunk from cfcf-docs/plan.md (map phases to iterations first if the plan is not yet structured that way), update plan.md with what you completed, then fill in cfcf-docs/iteration-handoff.md and cfcf-docs/cfcf-iteration-signals.json before exiting.`;
    const devCmd = devAdapter.buildCommand(workspace.repoPath, devPrompt, workspace.devAgent.model);

    const devProcess = await spawnProcess({
      command: devCmd.command,
      args: devCmd.args,
      cwd: workspace.repoPath,
      logFile: devLogFile,
    });
    const unregisterDev = registerProcess({
      workspaceId: workspace.id,
      role: "dev",
      process: devProcess,
      startedAt: iterRecord.startedAt,
      historyEventId: iterRecord.historyEventId,
      logFileName: iterRecord.devLogFileName,
    });

    let devResult: Awaited<typeof devProcess.result>;
    try {
      devResult = await devProcess.result;
    } finally {
      unregisterDev();
    }
    iterRecord.devExitCode = devResult.exitCode;

    // Check if stopped during dev execution
    if (isStopped(state)) break;

    // Collect dev results
    await parseHandoffDocument(workspace.repoPath);
    const devSignals = await parseSignalFile(workspace.repoPath);
    iterRecord.devSignals = devSignals ?? undefined;

    // Commit dev work
    if (await gitManager.hasChanges(workspace.repoPath)) {
      await gitManager.commitAll(
        workspace.repoPath,
        `cfcf iteration ${iterationNum} dev (${workspace.devAgent.adapter})`,
      );
    }

    // Archive the dev agent's iteration-handoff.md to
    // cfcf-docs/iteration-handoffs/iteration-N.md so the forward-looking
    // handoff is preserved per iteration (like iteration-reviews/ +
    // reflection-reviews/). The live file stays as-is so the judge in
    // this same iteration reads the same handoff, and so the next
    // iteration's dev agent sees it as starting context until they
    // replace it. (item 5.x polish, v0.7.6)
    const { archiveHandoff, refreshIterationHistory } = await import("./context-assembler.js");
    await archiveHandoff(workspace.repoPath, iterationNum);

    // Fold iter-N's just-written iteration-log into iteration-history.md.
    //
    // Without this, history.md stays permanently one iteration behind
    // whenever the loop terminates: writeContextToRepo (which rebuilds
    // history.md) only runs at the START of each iteration, so iter-N's
    // own log is never picked up unless iter-N+1 starts. End-of-loop
    // iterations (SUCCESS → documenter → exit; STALLED → exit) leave
    // their final log out of history.md indefinitely.
    //
    // Best-effort: a rebuild failure shouldn't fail the iteration.
    try {
      await refreshIterationHistory(workspace.repoPath);
    } catch (err) {
      console.warn(
        `[loop] couldn't refresh iteration-history.md after iter ${iterationNum}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // --- JUDGE + DECIDE ---
    if (isStopped(state)) break;

    await runJudgeAndDecide(
      workspace, state, iterRecord, iterationNum, branchName, devSignals, packPath,
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
  workspace: WorkspaceConfig,
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
  await writeJudgeInstructions(workspace.repoPath, workspace, iterationNum);
  await resetJudgeSignals(workspace.repoPath);

  const judgeLogFile = iterRecord.judgeLogFile;

  const judgeCmd = buildJudgeCommand(workspace);
  if (!judgeCmd) {
    throw new Error(`Unknown judge agent adapter: ${workspace.judgeAgent.adapter}`);
  }

  const judgeProcess = await spawnProcess({
    command: judgeCmd.command,
    args: judgeCmd.args,
    cwd: workspace.repoPath,
    logFile: judgeLogFile,
  });
  const unregisterJudge = registerProcess({
    workspaceId: workspace.id,
    role: "judge",
    process: judgeProcess,
    startedAt: iterRecord.startedAt,
    historyEventId: iterRecord.historyEventId,
    logFileName: iterRecord.judgeLogFileName,
  });

  let judgeResult: Awaited<typeof judgeProcess.result>;
  try {
    judgeResult = await judgeProcess.result;
  } finally {
    unregisterJudge();
  }
  iterRecord.judgeExitCode = judgeResult.exitCode;

  // Check if stopped during judge execution
  if (isStopped(state)) return;

  // Collect judge results
  const judgeSignals = await parseJudgeSignals(workspace.repoPath);
  iterRecord.judgeSignals = judgeSignals ?? undefined;

  // If judge exited with non-zero and produced no signals, log it
  if (judgeResult.exitCode !== 0 && !judgeSignals) {
    iterRecord.judgeError = `Judge agent exited with code ${judgeResult.exitCode}. Check log: ${judgeLogFile}`;
  }

  // Commit judge work
  if (await gitManager.hasChanges(workspace.repoPath)) {
    await gitManager.commitAll(
      workspace.repoPath,
      `cfcf iteration ${iterationNum} judge (${workspace.judgeAgent.adapter})`,
    );
  }

  // Archive judge assessment
  await archiveJudgeAssessment(workspace.repoPath, iterationNum);

  // Flip the iteration's history event to `completed` NOW, before
  // reflection starts. The dev and judge agents have both exited and
  // their signals are persisted -- from the user's point of view the
  // iteration is done; reflection is its own row in the history. Leaving
  // the iteration marked `running` across the reflection phase made the
  // History tab look stuck. Merge status is updated separately in the
  // DECIDE block after auto-merge succeeds.
  const iterCompletedAt = new Date().toISOString();
  await updateHistoryEvent(workspace.id, iterRecord.historyEventId, {
    status: "completed",
    completedAt: iterCompletedAt,
    devExitCode: iterRecord.devExitCode,
    judgeExitCode: iterRecord.judgeExitCode,
    judgeDetermination: judgeSignals?.determination,
    judgeQuality: judgeSignals?.quality_score,
    devSignals: iterRecord.devSignals,
    judgeSignals: judgeSignals ?? undefined,
  } as Partial<import("./workspace-history.js").IterationHistoryEvent>);

  // --- REFLECT (item 5.6) ---
  // Runs after the judge commits and before DECIDE. Decides whether to
  // run the reflection role based on judge's opt-out signal + safeguard
  // ceiling. When it runs, produces its OWN commit so `git log --oneline`
  // reads as a three-line story per iteration:
  //   dev(iter N) -> judge(iter N) -> reflect(iter N)
  let reflectionSignals: ReflectionSignals | null = null;
  if (judgeSignals) {
    const trigger = shouldRunReflection(judgeSignals, state, workspace);
    if (trigger.run) {
      state.phase = "reflecting";
      await saveLoopState(state);
      try {
        const reflectRes = await runReflectionSync(
          workspace,
          iterationNum,
          judgeSignals.reflection_reason ? { reason: judgeSignals.reflection_reason } : undefined,
        );
        reflectionSignals = reflectRes.signals;
        iterRecord.reflectionRan = true;
        iterRecord.reflectionSignals = reflectRes.signals ?? undefined;
        iterRecord.reflectionLogFileName = reflectRes.logFileName;
        iterRecord.reflectionExitCode = reflectRes.exitCode;
        if (!reflectRes.planAccepted) {
          iterRecord.reflectionPlanRejectionReason = reflectRes.planRejectionReason;
        }

        // Archive the reflection analysis into reflection-reviews/reflection-N.md
        const { archiveReflectionAnalysis } = await import("./reflection-runner.js");
        await archiveReflectionAnalysis(workspace.repoPath, iterationNum);

        // Commit the reflection outputs separately.
        if (await gitManager.hasChanges(workspace.repoPath)) {
          const health = reflectRes.signals?.iteration_health ?? "inconclusive";
          const obs = reflectRes.signals?.key_observation || "reflection output";
          const subject = `cfcf iteration ${iterationNum} reflect (${health}): ${obs}`.slice(0, 200);
          await gitManager.commitAll(workspace.repoPath, subject);
        }

        // Clio ingest (item 5.7 PR3): auto-ingest reflection-analysis.md as a
        // semantic artifact. Failures are swallowed -- never break the loop.
        try {
          await ingestReflectionAnalysis(
            getClioBackend(),
            workspace,
            iterationNum,
            reflectRes.signals,
          );
        } catch (err) {
          console.warn(`[clio] reflection-analysis ingest failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Reset the skip counter now that reflection has actually run.
        state.iterationsSinceLastReflection = 0;
      } catch (err) {
        // Reflection failure is not fatal: log, record, and continue.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[iteration-loop] reflection failed for iter ${iterationNum}: ${msg}`);
        iterRecord.reflectionRan = false;
      }
    } else {
      // Judge opted out within safeguard ceiling -- just bump the counter.
      state.iterationsSinceLastReflection = (state.iterationsSinceLastReflection ?? 0) + 1;
      iterRecord.reflectionRan = false;
    }
  }

  // Mirror the history event's completion time on the in-memory record.
  // (The history event itself was already marked completed above, before
  // reflection ran, so the user-visible row flipped promptly.)
  iterRecord.completedAt = iterCompletedAt;

  // --- Clio auto-ingest (item 5.7 PR3) ---
  // Runs after reflection + before DECIDE. Respects the workspace's
  // `clio.ingestPolicy`: "off" / "summaries-only" / "all". All hooks
  // swallow errors -- Clio ingest failures never break a loop.
  try {
    const clio = getClioBackend();
    // Raw per-iteration artifacts (policy=all only).
    await ingestRawIterationArtifacts(clio, workspace, iterationNum);
    // Tagged semantic decision-log entries (policy!=off).
    await ingestDecisionLogEntries(clio, workspace, iterationNum);
    // End-of-iteration summary: compact dev summary + judge verdict +
    // reflection key_observation. Ingested under summaries-only + all.
    let devSummary: string | null = null;
    try {
      const { readFile } = await import("fs/promises");
      const iterLog = await readFile(
        join(workspace.repoPath, "cfcf-docs", "iteration-logs", `iteration-${iterationNum}.md`),
        "utf-8",
      ).catch(() => "");
      const m = iterLog.match(/^##\s+Summary\s*\n+([\s\S]*?)(?=\n##\s|\n#\s|$)/m);
      if (m) devSummary = m[1].trim();
    } catch { /* noop */ }
    await ingestIterationSummary(clio, {
      workspace,
      iteration: iterationNum,
      devSummary,
      judgeSignals: judgeSignals ?? null,
      reflectionSignals,
    });
  } catch (err) {
    console.warn(`[clio] end-of-iteration ingest batch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- Decision-log size warning (item 5.6 U4) ---
  // Emit a notification once per loop run when the iteration counter
  // crosses 50. No auto-trim -- the user owns the log.
  if (
    iterationNum >= 50 &&
    !state.decisionLogWarningFired
  ) {
    state.decisionLogWarningFired = true;
    dispatchForWorkspace(
      makeEvent({
        type: "loop.paused", // closest existing type; using it as an informational channel
        title: "Decision log is getting large",
        message:
          `${workspace.name}: decision-log.md has accumulated through ${iterationNum} iterations. ` +
          `Consider archiving it (copy to decision-log.archive-iter-${iterationNum}.md). No action required from cfcf.`,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        details: {
          informational: true,
          kind: "decision_log_large",
          iteration: iterationNum,
        },
      }),
      workspace.notifications,
    );
  }

  // --- DECIDE ---
  state.phase = "deciding";
  await saveLoopState(state);

  // Update consecutive stalled count
  if (judgeSignals?.determination === "STALLED") {
    state.consecutiveStalled++;
  } else {
    state.consecutiveStalled = 0;
  }

  const decision = makeDecision(judgeSignals, devSignals, state, workspace, reflectionSignals);

  // Merge branch to main if auto-merge and progress/success
  if (
    workspace.mergeStrategy === "auto" &&
    judgeSignals &&
    (judgeSignals.determination === "PROGRESS" || judgeSignals.determination === "SUCCESS")
  ) {
    const mainBranch = "main"; // TODO: detect default branch
    await gitManager.checkoutBranch(workspace.repoPath, mainBranch);
    const mergeResult = await gitManager.merge(
      workspace.repoPath,
      branchName,
      `Merge cfcf iteration ${iterationNum}`,
    );
    iterRecord.merged = mergeResult.success;
    if (!mergeResult.success) {
      // If merge fails, stay on the feature branch
      await gitManager.checkoutBranch(workspace.repoPath, branchName);
    }
    // Update history with merge status
    await updateHistoryEvent(workspace.id, iterRecord.historyEventId, {
      merged: iterRecord.merged,
    } as Partial<import("./workspace-history.js").IterationHistoryEvent>);

    // Auto-delete the merged iteration branch when configured (item 5.2).
    // Default is false -- we keep branches so the audit trail is preserved
    // and the user can still diff iterations after the fact. Enabling this
    // is useful for long-running workspaces that would otherwise accumulate
    // hundreds of merged `cfcf/iteration-N` branches.
    if (mergeResult.success && workspace.cleanupMergedBranches === true) {
      const delResult = await gitManager.deleteBranch(workspace.repoPath, branchName);
      if (!delResult.success) {
        // Non-fatal -- branch is still there, audit trail is still intact
        console.warn(
          `[iteration ${iterationNum}] cleanupMergedBranches: could not delete ${branchName}: ${delResult.error}`,
        );
      }
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
      // Skipped when `autoDocumenter=false` (item 5.1) -- user can
      // invoke `cfcf document` manually later.
      if (outcome === "success" && resolveLoopConfig(workspace, state).autoDocumenter) {
        state.phase = "documenting";
        await saveLoopState(state);

        try {
          const docResult = await runDocumentSync(workspace);
          let committed = false;
          if (await gitManager.hasChanges(workspace.repoPath)) {
            const commitResult = await gitManager.commitAll(
              workspace.repoPath,
              `cfcf documentation (${workspace.documenterAgent.adapter})`,
            );
            committed = commitResult.success;
          }
          // Update the history event with the commit status
          await updateHistoryEvent(workspace.id, docResult.historyEventId, {
            committed,
          } as Partial<import("./workspace-history.js").DocumentHistoryEvent>);
        } catch {
          // Documenter failure is not fatal -- the code is done
        }
      }

      state.phase = "completed";
      state.outcome = outcome;
      state.completedAt = new Date().toISOString();
      await saveLoopState(state);
      await updateWorkspace(workspace.id, { status: "completed" });

      // Notify on loop completion
      dispatchForWorkspace(
        makeEvent({
          type: "loop.completed",
          title: `Loop ${outcome === "success" ? "completed successfully" : "ended"}`,
          message: outcome === "success"
            ? `${workspace.name}: all success criteria met (${iterationNum} iteration${iterationNum === 1 ? "" : "s"})`
            : `${workspace.name}: loop ended with outcome "${outcome}" after ${iterationNum} iteration${iterationNum === 1 ? "" : "s"}`,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          details: { outcome, iterations: iterationNum },
        }),
        workspace.notifications,
      );

      // Push to remote on success
      if (outcome === "success") {
        await gitManager.push(workspace.repoPath).catch(() => {
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
      await updateWorkspace(workspace.id, { status: "paused" });

      // Notify on pause (cadence, anomaly, user input needed)
      dispatchForWorkspace(
        makeEvent({
          type: "loop.paused",
          title: pauseReasonTitle(decision.pauseReason),
          message: `${workspace.name}: ${decision.reason}`,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          details: {
            iteration: iterationNum,
            pauseReason: decision.pauseReason,
            questions: decision.questions,
          },
        }),
        workspace.notifications,
      );

      // For judge failure (null signals + non-zero exit), also fire agent.failed
      if (!judgeSignals && iterRecord.judgeExitCode !== undefined && iterRecord.judgeExitCode !== 0) {
        dispatchForWorkspace(
          makeEvent({
            type: "agent.failed",
            title: "Judge agent failed",
            message: `${workspace.name}: judge exited with code ${iterRecord.judgeExitCode} and produced no signals. Check log.`,
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            details: {
              iteration: iterationNum,
              role: "judge",
              exitCode: iterRecord.judgeExitCode,
            },
          }),
          workspace.notifications,
        );
      }

      return; // Loop exits -- will be restarted by resumeLoop()

    case "continue":
      await saveLoopState(state);
      // Caller continues to next iteration
      return;
  }
}
