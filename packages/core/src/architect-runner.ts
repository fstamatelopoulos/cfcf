/**
 * Solution Architect runner for cfcf.
 *
 * Spawns a Solution Architect agent to review the Problem Pack
 * and produce a readiness assessment + initial implementation plan.
 * User-invoked, advisory, repeatable.
 */

import { join } from "path";
import { readFile, writeFile, mkdir } from "fs/promises";
import type { WorkspaceConfig, ArchitectSignals } from "./types.js";
import { getTemplate, writeTemplate } from "./templates.js";
import { getAdapter } from "./adapters/index.js";
import { effectiveClioProject } from "./clio/system-projects.js";
import { formatClioActor } from "./clio/actor.js";
import { spawnProcess, type ManagedProcess } from "./process-manager.js";
import { registerProcess } from "./active-processes.js";
import { dispatchForWorkspace, makeEvent } from "./notifications/index.js";
import { getAgentRunLogPath, nextAgentRunSequence, ensureWorkspaceLogDir } from "./log-storage.js";
import { appendHistoryEvent, updateHistoryEvent } from "./workspace-history.js";
import { persistAgentState, loadAgentState } from "./agent-state-store.js";
import { randomBytes } from "crypto";
import { readProblemPack, validateProblemPack } from "./problem-pack.js";
import { writeContextToRepo, type IterationContext } from "./context-assembler.js";
import { validatePlanRewrite, planHasCompletedItems } from "./plan-validation.js";
import * as gitManager from "./git-manager.js";

// Templates are resolved via the central templates module (embedded at build
// time with per-repo / per-user filesystem overrides).

// --- Review State ---

export interface ReviewState {
  workspaceId: string;
  workspaceName: string;
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

/**
 * Disk-backed store filename + active-status set for the F.23
 * persistence layer. The state file lives next to `loop-state.json`
 * under `~/.cfcf/workspaces/<id>/`. `setReviewState` writes through
 * (memory + disk); `getReviewState` is sync because the cache is
 * pre-hydrated from disk at server boot via `hydrateReviewStateStore`.
 */
const REVIEW_STATE_FILE = "review-state.json";
const REVIEW_ACTIVE_STATUSES = new Set(["preparing", "executing", "collecting"]);

/**
 * In-memory + on-disk write-through. Every place that mutates a
 * `ReviewState` (start, status transitions, signals attached, error
 * thrown) must funnel through this so the disk file stays in sync.
 * Best-effort on disk errors — the in-memory write always succeeds.
 */
async function setReviewState(state: ReviewState): Promise<void> {
  reviewStore.set(state.workspaceId, state);
  try {
    await persistAgentState(REVIEW_STATE_FILE, state);
  } catch (err) {
    console.warn(
      `[architect-runner] persistAgentState failed for ${state.workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function getReviewState(workspaceId: string): ReviewState | undefined {
  return reviewStore.get(workspaceId);
}

/**
 * Force-mark this workspace's architect/review state as `failed`
 * with the given reason. Used by `stopLoop()` + `cfcf agents reap`
 * to flip the dashboard's "review running" indicator off
 * immediately after killing the subprocess. Mirrors
 * `markReflectStateFailed` / `markDocumentStateFailed`.
 *
 * Idempotent: no-op when no state exists, or when the state is
 * already terminal (completed / failed). Returns true if a flip
 * happened.
 */
export async function markReviewStateFailed(
  workspaceId: string,
  reason: string,
): Promise<boolean> {
  const current = reviewStore.get(workspaceId);
  if (!current) return false;
  if (!REVIEW_ACTIVE_STATUSES.has(current.status)) return false;
  current.status = "failed";
  current.error = reason;
  current.completedAt = new Date().toISOString();
  await setReviewState(current);
  return true;
}

/**
 * Server-boot hook (item F.23): load every workspace's persisted
 * review state into the in-memory cache. Any state still in an active
 * phase from the prior server is flipped to `failed` (with the supplied
 * reason) — the agent process didn't survive the restart, so the
 * "running" claim is stale.
 *
 * Returns the number of states that needed cleanup. Best-effort:
 * missing/malformed files are silently skipped so a single corrupt
 * state file doesn't block server boot.
 */
export async function hydrateReviewStateStore(
  staleReason: string = "Server restarted while review was running",
): Promise<number> {
  const { listWorkspaces } = await import("./workspaces.js");
  const workspaces = await listWorkspaces();
  let cleaned = 0;
  for (const w of workspaces) {
    const state = await loadAgentState<ReviewState>(REVIEW_STATE_FILE, w.id);
    if (!state) continue;
    if (REVIEW_ACTIVE_STATUSES.has(state.status)) {
      state.status = "failed";
      state.error = staleReason;
      state.completedAt = new Date().toISOString();
      await persistAgentState(REVIEW_STATE_FILE, state).catch(() => {});
      cleaned++;
    }
    reviewStore.set(w.id, state);
  }
  return cleaned;
}

/**
 * Stop a running review for a workspace. Kills the process and updates state.
 */
export async function stopReview(workspaceId: string): Promise<ReviewState | null> {
  const state = reviewStore.get(workspaceId);
  if (!state) return null;
  if (!REVIEW_ACTIVE_STATUSES.has(state.status)) {
    return state; // already terminal
  }

  const proc = reviewProcessStore.get(workspaceId);
  if (proc) {
    proc.kill();
    reviewProcessStore.delete(workspaceId);
  }

  state.status = "failed";
  state.error = "Stopped by user";
  state.completedAt = new Date().toISOString();
  await setReviewState(state);

  await updateHistoryEvent(workspaceId, state.historyEventId, {
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
  workspace: WorkspaceConfig,
): Promise<void> {
  let template = await getTemplate("cfcf-architect-instructions.md", { repoPath });
  template = template.replace(/\{\{WORKSPACE_NAME\}\}/g, workspace.name);
  // Item 6.9: real effective Clio Project in the agent's CLI examples.
  template = template.replace(
    /\{\{WORKSPACE_CLIO_PROJECT\}\}/g,
    effectiveClioProject(workspace),
  );

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
  await writeTemplate(
    join(repoPath, "cfcf-docs"),
    "cfcf-architect-signals.json",
    { repoPath },
  );
}

/**
 * Why parseArchitectSignals returned null. Used by the iteration-loop
 * pause message to give the user a more specific diagnostic than the
 * generic "missing or malformed" string. Surfaced 2026-05-08 — when
 * opencode-ollama hangs without writing the signals file, the user
 * was getting a misleading "review run hit an error mid-way" message
 * that suggested a validator bug rather than the actual cause (agent
 * never finished writing).
 */
export type SignalFailureReason =
  /** Signals file doesn't exist on disk — the agent never created it. */
  | "missing"
  /** File exists but is the literal untouched template (NEEDS_REFINEMENT + all empty + null approach). Agent likely hung or crashed before editing. */
  | "untouched_template"
  /** File exists but JSON.parse failed — the agent wrote something corrupted. */
  | "malformed_json"
  /** File exists, JSON parsed, but `readiness` field is missing or unknown. */
  | "missing_readiness"
  /** File exists with a value cfcf doesn't understand for `readiness`. */
  | "valid";

/**
 * Read the signals file on disk and classify why parseArchitectSignals
 * couldn't return a valid result. Returns "valid" when the file actually
 * IS valid (caller can use this to detect race conditions where the
 * file appeared between the original parse and this diagnosis call).
 */
export async function diagnoseFailedArchitectSignals(
  repoPath: string,
): Promise<SignalFailureReason> {
  const path = join(repoPath, "cfcf-docs", "cfcf-architect-signals.json");
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return "missing";
  }
  let parsed: ArchitectSignals;
  try {
    parsed = JSON.parse(content) as ArchitectSignals;
  } catch {
    return "malformed_json";
  }
  if (!parsed.readiness) return "missing_readiness";
  // The cfcf template ships with NEEDS_REFINEMENT + all-empty arrays +
  // null recommended_approach. If the file matches this exactly, the
  // agent never edited it.
  if (
    parsed.readiness === "NEEDS_REFINEMENT" &&
    Array.isArray(parsed.gaps) && parsed.gaps.length === 0 &&
    Array.isArray(parsed.suggestions) && parsed.suggestions.length === 0 &&
    Array.isArray(parsed.risks) && parsed.risks.length === 0 &&
    !parsed.recommended_approach
  ) {
    return "untouched_template";
  }
  return "valid";
}

/**
 * Count `[ ]` (pending) and `[x]` (completed) checkbox items in a plan
 * document. Used by `parseArchitectSignals` to detect the "agent said
 * READY but the plan has no pending work" case (item 6.28 dogfood,
 * 2026-05-08). Pure function for testability.
 */
export function countPlanItems(planContent: string): { pending: number; completed: number } {
  // GFM-style checkboxes: `- [ ]` or `- [x]` / `- [X]`. Allow leading
  // whitespace + alternative bullet markers (`*`, `+`).
  const pending = (planContent.match(/^\s*[-*+]\s+\[\s\]/gm) ?? []).length;
  const completed = (planContent.match(/^\s*[-*+]\s+\[[xX]\]/gm) ?? []).length;
  return { pending, completed };
}

/**
 * Read `cfcf-docs/plan.md` and count its checkbox items. Returns
 * `{pending: 0, completed: 0}` if the file is missing — matches the
 * "no plan yet" case (e.g. fresh workspace pre-architect-first-run).
 */
async function readPlanItemCounts(repoPath: string): Promise<{ pending: number; completed: number }> {
  try {
    const content = await readFile(join(repoPath, "cfcf-docs", "plan.md"), "utf-8");
    return countPlanItems(content);
  } catch {
    return { pending: 0, completed: 0 };
  }
}

/**
 * Parse the architect signal file after the architect exits.
 *
 * Two safeguards live here, both surfaced 2026-05-08 during dogfood
 * with qwen3-coder on the SA role for a fully-shipped calc workspace:
 *
 *   1. **Untouched-template rejection** (only when readiness genuinely
 *      demands explanation: NEEDS_REFINEMENT / BLOCKED). Avoids
 *      false-positive rejection of clean READY/SCOPE_COMPLETE verdicts
 *      with empty supporting fields.
 *   2. **READY → SCOPE_COMPLETE auto-promotion** when plan.md has all
 *      `[x]` items and zero `[ ]` pending. This catches a common agent
 *      slip-up where the model identifies the project as complete but
 *      labels it READY (the more familiar value) instead of
 *      SCOPE_COMPLETE. Picking READY for a finished project is wrong:
 *      the harness sends the dev agent into a wasted iteration before
 *      the loop figures out there's no work. The prompt template
 *      explicitly tells the agent the right answer is SCOPE_COMPLETE,
 *      but defensive auto-promotion catches non-compliant agents too.
 *      Only fires when there's at least one `[x]` (work has actually
 *      been done) AND zero `[ ]` (nothing pending) — guards against
 *      promoting an empty plan in first-run mode.
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
    // Untouched-template detection (1) — see docstring above.
    const needsExplanation =
      signals.readiness === "NEEDS_REFINEMENT" || signals.readiness === "BLOCKED";
    if (
      needsExplanation &&
      signals.gaps.length === 0 &&
      signals.suggestions.length === 0 &&
      signals.risks.length === 0 &&
      !signals.recommended_approach
    ) {
      return null;
    }
    // READY → SCOPE_COMPLETE auto-promotion (2) — see docstring above.
    if (signals.readiness === "READY") {
      const { pending, completed } = await readPlanItemCounts(repoPath);
      if (pending === 0 && completed > 0) {
        console.log(
          `[architect] note: agent returned readiness="READY" but cfcf-docs/plan.md has ${completed} completed item${completed === 1 ? "" : "s"} and 0 pending — promoting to SCOPE_COMPLETE so the harness can route to the "done" UX rather than a wasted dev iteration.`,
        );
        signals.readiness = "SCOPE_COMPLETE";
      }
    }
    return signals;
  } catch {
    return null;
  }
}

/**
 * Start an architect review for a workspace.
 * Runs asynchronously -- returns the initial state immediately.
 */
export async function startReview(
  workspace: WorkspaceConfig,
  opts?: { problemPackPath?: string },
): Promise<ReviewState> {
  await ensureWorkspaceLogDir(workspace.id);
  const sequence = await nextAgentRunSequence(workspace.id, "architect");
  const logFile = getAgentRunLogPath(workspace.id, "architect", sequence);
  const logFileName = `architect-${String(sequence).padStart(3, "0")}.log`;

  const historyEventId = randomBytes(8).toString("hex");
  const startedAt = new Date().toISOString();

  // Record the history event immediately
  await appendHistoryEvent(workspace.id, {
    id: historyEventId,
    type: "review",
    status: "running",
    startedAt,
    logFile: logFileName,
    agent: workspace.architectAgent.adapter,
    model: workspace.architectAgent.model,
    trigger: "manual",
  } as import("./workspace-history.js").ReviewHistoryEvent);

  const state: ReviewState = {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    status: "preparing",
    startedAt,
    logFile,
    logFileName,
    sequence,
    historyEventId,
  };

  await setReviewState(state);

  // Run in background. Wrap the error handler itself in try/catch so that
  // a failure to update state (e.g., disk write error) doesn't result in
  // a silent failure with no trace.
  runReview(workspace, state, opts).catch(async (err) => {
    try {
      state.status = "failed";
      state.error = err instanceof Error ? err.message : String(err);
      state.completedAt = new Date().toISOString();
      await setReviewState(state);
      await updateHistoryEvent(workspace.id, historyEventId, {
        status: "failed",
        error: state.error,
        completedAt: state.completedAt,
      });
      dispatchForWorkspace(
        makeEvent({
          type: "agent.failed",
          title: "Architect review failed",
          message: `${workspace.name}: ${state.error}`,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          details: { role: "architect", error: state.error },
        }),
        workspace.notifications,
      );
    } catch (handlerErr) {
      console.error(`[architect-runner] Failed to record error for ${workspace.id}:`, handlerErr);
      console.error(`  Original error:`, err);
    }
  });

  return state;
}

/**
 * Execute the architect review.
 */
async function runReview(
  workspace: WorkspaceConfig,
  state: ReviewState,
  opts?: { problemPackPath?: string },
): Promise<void> {
  const adapter = getAdapter(workspace.architectAgent.adapter);
  if (!adapter) {
    throw new Error(`Unknown architect agent adapter: ${workspace.architectAgent.adapter}`);
  }

  // Validate and read Problem Pack
  const packPath = opts?.problemPackPath || join(workspace.repoPath, "problem-pack");
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
    workspace,
  };
  await writeContextToRepo(workspace.repoPath, ctx);

  // Write architect-specific instructions
  await writeArchitectInstructions(workspace.repoPath, workspace);
  await resetArchitectSignals(workspace.repoPath);

  // Detect re-review mode. If cfcf-docs/plan.md already has any `[x]`
  // completed items, the workspace has previous iterations and the architect
  // is being re-run (e.g. user added new requirements to the problem pack,
  // or adopted an existing repo with a partial plan). The prompt and the
  // template branch on this so the architect extends the plan instead of
  // producing a fresh one. Snapshot the plan so we can revert any
  // destructive rewrite -- same rule reflection applies (§6.3).
  const planPath = join(workspace.repoPath, "cfcf-docs", "plan.md");
  let priorPlan = "";
  try {
    priorPlan = await readFile(planPath, "utf-8");
  } catch {
    priorPlan = "";
  }
  const reReviewMode = planHasCompletedItems(priorPlan);

  // Build and run the architect agent
  state.status = "executing";
  await setReviewState(state);

  const prompt = reReviewMode
    ? `Read cfcf-docs/cfcf-architect-instructions.md and follow the instructions exactly. This is a RE-REVIEW of an existing workspace -- cfcf-docs/plan.md already has completed iterations. Review the problem definition alongside the existing plan, completed-iteration logs under cfcf-docs/iteration-logs/, the decision log, and any iteration_history. Decide whether the current problem pack matches what has already been delivered. If new requirements warrant it, APPEND new pending iterations to cfcf-docs/plan.md; otherwise leave the plan untouched and say so in the review. Never delete completed items or existing iteration headers. Produce cfcf-docs/architect-review.md and cfcf-docs/cfcf-architect-signals.json before exiting.`
    : `Read cfcf-docs/cfcf-architect-instructions.md and follow the instructions exactly. Review the problem definition, produce cfcf-docs/architect-review.md, cfcf-docs/plan.md, and cfcf-docs/cfcf-architect-signals.json before exiting.`;
  const cmd = adapter.buildCommand(workspace.repoPath, prompt, workspace.architectAgent.model);

  const managed = await spawnProcess({
    command: cmd.command,
    args: cmd.args,
    cwd: workspace.repoPath,
    logFile: state.logFile,
    env: {
      CFCF_ACCESS_PATH: "agent-cli",
      CFCF_ACTOR: formatClioActor("architect", workspace.architectAgent.adapter, workspace.architectAgent.model),
    },
  });
  reviewProcessStore.set(workspace.id, managed);
  const unregister = registerProcess({
    workspaceId: workspace.id,
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
    await setReviewState(state);

    // Re-review non-destructive check: if the architect rewrote plan.md in
    // a way that removes a completed item or an iteration header, revert
    // the file to the snapshot we took before spawn. Record it in the
    // signals so the review UI can explain.
    if (reReviewMode) {
      let newPlan = "";
      try {
        newPlan = await readFile(planPath, "utf-8");
      } catch {
        newPlan = "";
      }
      if (newPlan !== priorPlan) {
        const validation = validatePlanRewrite(priorPlan, newPlan);
        if (!validation.valid) {
          await writeFile(planPath, priorPlan, "utf-8");
          console.warn(
            `[architect-runner] re-review rewrote plan.md destructively (${validation.reason}); reverted.`,
          );
        }
      }
    }

    const signals = await parseArchitectSignals(workspace.repoPath);
    state.signals = signals ?? undefined;

    // F.1 (v0.24): commit the architect's on-disk outputs
    // (architect-review.md, plan.md possibly rewritten, cfcf-architect-
    // signals.json, cfcf-architect-instructions.md) on the current
    // branch. Pre-v0.24 standalone `cfcf review` and the web Review
    // button left these files dirty — the in-loop pre-loop review
    // already commits via iteration-loop's own gitManager call, but
    // the async / manual path didn't. Best-effort: failing commit is
    // logged but doesn't fail the run.
    let committed = false;
    if (result.exitCode === 0) {
      try {
        if (await gitManager.hasChanges(workspace.repoPath)) {
          const subject = `cfcf manual review (${signals?.readiness ?? "unknown"})`;
          const cr = await gitManager.commitAll(workspace.repoPath, subject);
          committed = cr.success;
          if (!cr.success) {
            console.warn(`[architect-runner] commitAll returned non-success`);
          }
        }
      } catch (err) {
        console.warn(
          `[architect-runner] post-run commit failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    state.status = "completed";
    state.completedAt = new Date().toISOString();
    await setReviewState(state);

    // Update history event with final status.
    // We persist the full signals inline so prior reviews remain viewable
    // after `cfcf-docs/cfcf-architect-signals.json` is overwritten by later runs.
    await updateHistoryEvent(workspace.id, state.historyEventId, {
      status: result.exitCode === 0 ? "completed" : "failed",
      completedAt: state.completedAt,
      readiness: signals?.readiness,
      signals: signals ?? undefined,
      committed,
    } as Partial<import("./workspace-history.js").ReviewHistoryEvent>);

    // Clio ingest (item 5.7 PR3): auto-ingest user-invoked `cfcf review`
    // architect-review.md. Failures are swallowed -- never break a review.
    try {
      const { getClioBackend, ingestArchitectReview, ingestPlanMd, ingestContextPack, formatClioActor } = await import("./clio/index.js");
      const backend = getClioBackend();
      const architectActor = formatClioActor("architect", workspace.architectAgent.adapter, workspace.architectAgent.model);
      await ingestArchitectReview(backend, workspace, "manual", signals?.readiness);
      // Item 6.35 follow-up (2026-05-10): SA writes plan.md too, not just
      // architect-review.md. Mirror the plan to Clio with the SA actor
      // stamp so the audit log attributes the create / update correctly.
      await ingestPlanMd(
        backend,
        workspace,
        "post-architect",
        architectActor,
      );
      // F.27 (v0.24): SA may produce / point at a synthesis doc the
      // user wants searchable (e.g. a "what the constraints really
      // imply" walkthrough). Re-scan `context-pack/` so any edits the
      // SA hinted at or directly made land in Clio without waiting
      // for the next iteration. sha256 dedup → unchanged files are
      // a no-op.
      await ingestContextPack(backend, workspace, "post-architect", architectActor);
    } catch (err) {
      console.warn(`[clio] manual architect post-run ingest failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    reviewProcessStore.delete(workspace.id);
    unregister();
  }
}

// --- Sync entry point (used by the iteration loop for pre-loop review; item 5.1) ---

export interface ReviewRunResult {
  exitCode: number;
  logFile: string;
  logFileName: string;
  sequence: number;
  historyEventId: string;
  signals: ArchitectSignals | null;
}

/**
 * Run the Solution Architect synchronously and return the result.
 * Used by the iteration loop when `autoReviewSpecs=true` -- Review runs
 * as a pre-loop phase before iteration 1, commits to main (not an
 * iteration branch, since review output is a deterministic input to the
 * loop rather than iteration work), and the result feeds the readiness
 * gate. Mirrors `runDocumentSync` in shape.
 */
export async function runReviewSync(
  workspace: WorkspaceConfig,
  opts?: {
    problemPackPath?: string;
    /**
     * User feedback text entered on the FeedbackForm / `cfcf resume
     * --feedback`. When the loop paused at the pre-loop review phase
     * (readiness gate rejected the previous spawn) and the user
     * provides guidance on resume, it must reach the architect on the
     * next spawn -- we write it to `cfcf-docs/user-feedback.md` via
     * the iteration context. Without this, architect re-runs saw the
     * default "No user feedback yet." even after the user typed
     * something in. (fixed in v0.7.2)
     */
    userFeedback?: string;
    /**
     * Marks this review as loop-triggered (pre-loop review phase).
     * Stored on the review history event so the web History tab can
     * label it "Pre-loop review" instead of the plain "Review" used
     * for user-invoked `cfcf review`. Defaults to undefined
     * (treated as manual).
     */
    trigger?: "loop" | "manual";
  },
): Promise<ReviewRunResult> {
  const adapter = getAdapter(workspace.architectAgent.adapter);
  if (!adapter) {
    throw new Error(`Unknown architect agent adapter: ${workspace.architectAgent.adapter}`);
  }

  // Validate + read Problem Pack
  const packPath = opts?.problemPackPath || join(workspace.repoPath, "problem-pack");
  const packValidation = await validateProblemPack(packPath);
  if (!packValidation.valid) {
    throw new Error(
      `Problem Pack invalid: ${packValidation.errors.join(", ")}. Create a problem-pack/ directory with problem.md and success.md.`,
    );
  }
  const problemPack = await readProblemPack(packPath);

  // Log + history event
  await ensureWorkspaceLogDir(workspace.id);
  const sequence = await nextAgentRunSequence(workspace.id, "architect");
  const logFile = getAgentRunLogPath(workspace.id, "architect", sequence);
  const logFileName = `architect-${String(sequence).padStart(3, "0")}.log`;
  const historyEventId = randomBytes(8).toString("hex");
  const startedAt = new Date().toISOString();

  await appendHistoryEvent(workspace.id, {
    id: historyEventId,
    type: "review",
    status: "running",
    startedAt,
    logFile: logFileName,
    agent: workspace.architectAgent.adapter,
    model: workspace.architectAgent.model,
    trigger: opts?.trigger ?? "loop",
  } as import("./workspace-history.js").ReviewHistoryEvent);

  // Read any existing judge-assessment.md from disk BEFORE writeContextToRepo
  // runs -- otherwise writeContextToRepo writes the default "No previous
  // judge assessment..." placeholder and we silently clobber the previous
  // iteration's verdict on brownfield workspaces (fixed in v0.7.6). Same
  // fix pattern we used for `userFeedback` in v0.7.2.
  let previousJudgeAssessment: string | undefined;
  try {
    const { parseJudgeAssessment } = await import("./judge-runner.js");
    previousJudgeAssessment = (await parseJudgeAssessment(workspace.repoPath)) ?? undefined;
  } catch {
    // No previous assessment -- fresh workspace, pass through
  }

  // Write context files and architect-specific files into the repo.
  // `userFeedback` is plumbed through so the architect sees any guidance
  // the user provided on resume from a pre-loop review pause.
  const ctx: IterationContext = {
    iteration: 0,
    problemPack,
    workspace,
    userFeedback: opts?.userFeedback,
    previousJudgeAssessment,
  };
  await writeContextToRepo(workspace.repoPath, ctx);
  await writeArchitectInstructions(workspace.repoPath, workspace);
  await resetArchitectSignals(workspace.repoPath);

  // Re-review snapshot (same non-destructive rule as the async entry)
  const planPath = join(workspace.repoPath, "cfcf-docs", "plan.md");
  let priorPlan = "";
  try {
    priorPlan = await readFile(planPath, "utf-8");
  } catch {
    priorPlan = "";
  }
  const reReviewMode = planHasCompletedItems(priorPlan);

  const prompt = reReviewMode
    ? `Read cfcf-docs/cfcf-architect-instructions.md and follow the instructions exactly. This is a RE-REVIEW of an existing workspace -- cfcf-docs/plan.md already has completed iterations. Review the problem definition alongside the existing plan, completed-iteration logs under cfcf-docs/iteration-logs/, the decision log, and any iteration history. Decide whether the current problem pack matches what has already been delivered. If new requirements warrant it, APPEND new pending iterations to cfcf-docs/plan.md; otherwise leave the plan untouched and say so in the review. Never delete completed items or existing iteration headers. Produce cfcf-docs/architect-review.md and cfcf-docs/cfcf-architect-signals.json before exiting.`
    : `Read cfcf-docs/cfcf-architect-instructions.md and follow the instructions exactly. Review the problem definition, produce cfcf-docs/architect-review.md, cfcf-docs/plan.md, and cfcf-docs/cfcf-architect-signals.json before exiting.`;
  const cmd = adapter.buildCommand(workspace.repoPath, prompt, workspace.architectAgent.model);

  const managed = await spawnProcess({
    command: cmd.command,
    args: cmd.args,
    cwd: workspace.repoPath,
    logFile,
    env: {
      CFCF_ACCESS_PATH: "agent-cli",
      CFCF_ACTOR: formatClioActor("architect", workspace.architectAgent.adapter, workspace.architectAgent.model),
    },
  });
  const unregister = registerProcess({
    workspaceId: workspace.id,
    role: "architect",
    process: managed,
    startedAt,
    historyEventId,
    logFileName,
  });

  try {
    const result = await managed.result;

    // Non-destructive plan rewrite check
    if (reReviewMode) {
      let newPlan = "";
      try {
        newPlan = await readFile(planPath, "utf-8");
      } catch {
        newPlan = "";
      }
      if (newPlan !== priorPlan) {
        const validation = validatePlanRewrite(priorPlan, newPlan);
        if (!validation.valid) {
          await writeFile(planPath, priorPlan, "utf-8");
          console.warn(
            `[architect-runner] pre-loop review rewrote plan.md destructively (${validation.reason}); reverted.`,
          );
        }
      }
    }

    const signals = await parseArchitectSignals(workspace.repoPath);
    await updateHistoryEvent(workspace.id, historyEventId, {
      status: result.exitCode === 0 ? "completed" : "failed",
      completedAt: new Date().toISOString(),
      readiness: signals?.readiness,
      signals: signals ?? undefined,
    } as Partial<import("./workspace-history.js").ReviewHistoryEvent>);

    return { exitCode: result.exitCode, logFile, logFileName, sequence, historyEventId, signals };
  } finally {
    unregister();
  }
}

// --- Readiness gate helper (item 5.1) ---

/**
 * Apply a `readinessGate` policy to an architect readiness outcome.
 * Returns whether the loop should be blocked from entering iteration 1.
 *
 * Rules:
 *   - `gate === "never"`:                       never block.
 *   - `gate === "blocked"` (default):           block only when readiness is `BLOCKED`.
 *   - `gate === "needs_refinement_or_blocked"`: block on anything other than `READY`.
 *   - If the architect failed to emit signals entirely: conservative --
 *     block unless the gate is `never` (pre-loop without signals is a
 *     genuine anomaly; the user should see what happened before we burn
 *     an iteration's worth of compute).
 *
 * **SCOPE_COMPLETE always blocks** (item 6.25 follow-up, 2026-05-02): when
 * the architect determines the spec describes work that's already done, no
 * gate value lets the loop proceed -- there's literally nothing to build.
 * The gate's "should we tolerate spec issues and run anyway" semantic does
 * not apply when there's no work, regardless of the gate setting.
 */
export function readinessGateBlocks(
  readiness: string | undefined,
  gate: import("./types.js").ReadinessGate,
): boolean {
  // SCOPE_COMPLETE always blocks regardless of gate: no work, no run.
  if (readiness === "SCOPE_COMPLETE") return true;
  if (gate === "never") return false;
  if (!readiness) return true;
  if (gate === "blocked") return readiness === "BLOCKED";
  if (gate === "needs_refinement_or_blocked") return readiness !== "READY";
  return false;
}
