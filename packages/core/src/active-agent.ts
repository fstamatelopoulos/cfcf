/**
 * Cross-runner "is anything running on this workspace right now?" helper
 * (item F.22, v0.24.0).
 *
 * `workspace.status` (the on-disk WorkspaceConfig field) tracks ONLY the
 * iteration loop. Standalone agent runs — Review, Document, Reflect —
 * don't touch it by design (their state lives in per-runner in-memory
 * stores). That makes the dashboard list view blind to "I just kicked
 * off a manual reflect on a completed workspace": the StatusBadge keeps
 * showing the workspace's loop-status (`completed` / `idle`) while the
 * agent is actively running.
 *
 * `getActiveAgent()` consults all four runner state stores in priority
 * order and returns whichever agent is in an active phase. The web UI's
 * Dashboard fetches this via the extended `/api/workspaces` response;
 * `WorkspaceCard` renders an "<agent> running" chip when non-null.
 *
 * Priority: loop > review > document > reflect. The loop is the
 * "primary" workspace activity; the others are typically standalone +
 * mutually exclusive (`LoopControls` disables them while the loop is
 * running). When the priority matters in practice it's during a brief
 * race window (e.g. a manual reflect kicks off just as the loop is
 * tearing down) — picking the loop in that case keeps the UI stable.
 *
 * Returns `null` when nothing is running.
 */

import { getLoopState, type LoopPhase } from "./iteration-loop.js";
import { getReviewState } from "./architect-runner.js";
import { getDocumentState } from "./documenter-runner.js";
import { getReflectState } from "./reflection-runner.js";

export type ActiveAgent = "loop" | "review" | "document" | "reflect";

/**
 * Loop phases that count as "the loop is actively doing work" — same
 * set as the web UI's `LOOP_ACTIVE_PHASES`. `paused` is intentionally
 * excluded (no agent process is running; the loop is waiting on the
 * user) so the dashboard can show that case as a paused-loop chip
 * separately if needed.
 */
const LOOP_ACTIVE_PHASES: LoopPhase[] = [
  "pre_loop_reviewing",
  "preparing",
  "dev_executing",
  "judging",
  "reflecting",
  "deciding",
  "documenting",
];

/** Review-runner statuses that mean an agent is actively running. */
const REVIEW_ACTIVE_STATUSES = new Set(["preparing", "executing", "collecting"]);
/** Document-runner statuses that mean an agent is actively running. */
const DOCUMENT_ACTIVE_STATUSES = new Set(["preparing", "executing"]);
/** Reflect-runner statuses that mean an agent is actively running. */
const REFLECT_ACTIVE_STATUSES = new Set(["preparing", "executing", "collecting"]);

/**
 * Resolve the active agent on a workspace by inspecting all four runner
 * state stores. Returns `null` if nothing is running.
 *
 * Priority: loop > review > document > reflect. See module-doc for
 * rationale.
 */
export async function getActiveAgent(
  workspaceId: string,
): Promise<ActiveAgent | null> {
  const loop = await getLoopState(workspaceId);
  if (loop && LOOP_ACTIVE_PHASES.includes(loop.phase)) {
    return "loop";
  }
  const review = getReviewState(workspaceId);
  if (review && REVIEW_ACTIVE_STATUSES.has(review.status)) {
    return "review";
  }
  const document = getDocumentState(workspaceId);
  if (document && DOCUMENT_ACTIVE_STATUSES.has(document.status)) {
    return "document";
  }
  const reflect = getReflectState(workspaceId);
  if (reflect && REFLECT_ACTIVE_STATUSES.has(reflect.status)) {
    return "reflect";
  }
  return null;
}

/**
 * Batch resolver for multiple workspaces — used by the dashboard list
 * endpoint. Performs the four store lookups per workspace concurrently
 * but yields between workspaces so a 100-workspace dashboard doesn't
 * thrash the event loop.
 */
export async function getActiveAgentsForWorkspaces(
  workspaceIds: string[],
): Promise<Record<string, ActiveAgent | null>> {
  const out: Record<string, ActiveAgent | null> = {};
  for (const id of workspaceIds) {
    out[id] = await getActiveAgent(id);
  }
  return out;
}
