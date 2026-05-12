/**
 * Per-half status derivation for the History tab's split Dev + Judge
 * rows (item F.21, v0.24+). Pure function of an `IterationHistoryEvent`
 * — extracted out of `WorkspaceHistory.tsx` so the per-state-transition
 * matrix (dev running → judge pending, dev failed → judge skipped, …)
 * is unit-testable without component-test infrastructure.
 *
 * Mental model: each row reflects only ITS half — same semantic as
 * the live PhaseIndicator highlighting one of [prepare → dev → judge
 * → reflect → decide] at a time. The iteration's overall
 * `event.status` ("running" / "completed" / "failed") is a roll-up
 * across both halves and is intentionally NOT used directly when we
 * can derive sharper per-half status from exit codes + dev-completion
 * ordering.
 */

import type { IterationHistoryEvent } from "../types";

export type DevRowStatus = "running" | "completed" | "failed";

export type JudgeRowStatus =
  | "pending" // dev still running; judge hasn't started yet
  | "running" // dev done (exit 0), judge is the live phase
  | "completed"
  | "failed"
  | "skipped"; // dev failed; judge won't run

export interface IterationRowStatuses {
  dev: DevRowStatus;
  judge: JudgeRowStatus;
}

/**
 * Resolve the dev row's status. Driven primarily by `devExitCode`;
 * falls back to the event's terminal status when no exit code was
 * captured (rare — implies the loop errored before parsing dev
 * signals).
 */
export function deriveDevRowStatus(event: IterationHistoryEvent): DevRowStatus {
  if (event.devExitCode === undefined) {
    if (event.status === "running") return "running";
    if (event.status === "completed") return "completed";
    return "failed";
  }
  return event.devExitCode === 0 ? "completed" : "failed";
}

/**
 * Resolve the judge row's status. Adds "pending" + "skipped"
 * states the dev row doesn't need:
 *
 *   - dev still running → judge "pending" (waiting its turn —
 *     matches PhaseIndicator showing dev as the active phase)
 *   - dev failed → judge "skipped" (loop's decision engine bails
 *     before spawning the judge)
 *   - dev done (exit 0), judge running → "running"
 *   - judge exit 0 → "completed"
 *   - judge non-zero → "failed"
 */
export function deriveJudgeRowStatus(event: IterationHistoryEvent): JudgeRowStatus {
  if (event.judgeExitCode === undefined) {
    if (event.devExitCode === undefined) return "pending";
    if (event.devExitCode !== 0) return "skipped";
    return "running";
  }
  return event.judgeExitCode === 0 ? "completed" : "failed";
}

/** Convenience: derive both rows in one call. */
export function deriveIterationRowStatuses(
  event: IterationHistoryEvent,
): IterationRowStatuses {
  return {
    dev: deriveDevRowStatus(event),
    judge: deriveJudgeRowStatus(event),
  };
}
