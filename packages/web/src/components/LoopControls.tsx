import { useState } from "react";
import type { LoopPhase } from "../types";
import * as api from "../api";

export type AgentAction = "review" | "start" | "resume" | "stop" | "document" | "stopReview" | "stopDocument";

/**
 * Which agent is currently active (running).
 * - "loop": the dev/judge/decide/documenting cycle is running
 * - "review": the architect is running
 * - "document": the documenter is running (standalone, not in-loop)
 * - null: nothing is running
 */
export type ActiveAgent = "loop" | "review" | "document" | null;

export function LoopControls({
  workspaceId,
  phase,
  activeAgent,
  onAction,
  autoReviewSpecs,
}: {
  workspaceId: string;
  phase?: LoopPhase | null;
  /** Which agent is currently active (derived in ProjectDetail). */
  activeAgent: ActiveAgent;
  /** Called after an action is dispatched. The caller should switch to the
   *  Logs tab and show the log for the new run where applicable. */
  onAction: (action: AgentAction) => void;
  /** When true (item 5.1), the standalone Review button is hidden because
   *  Review runs as a pre-loop phase of Start Loop instead. A hint is
   *  shown under the button row explaining this. The Document button is
   *  kept visible regardless of `autoDocumenter` -- when auto is off, the
   *  user still needs a way to invoke the Documenter manually. */
  autoReviewSpecs?: boolean;
}) {
  const [loading, setLoading] = useState<AgentAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function doAction(name: AgentAction, fn: () => Promise<unknown>) {
    setLoading(name);
    setError(null);
    try {
      await fn();
      onAction(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(null);
    }
  }

  const isLoopRunning = activeAgent === "loop";
  const isReviewRunning = activeAgent === "review";
  const isDocumentRunning = activeAgent === "document";
  const isPaused = phase === "paused";
  const isBusy = activeAgent !== null;
  const canStart = !phase || ["idle", "completed", "failed", "stopped"].includes(phase);

  return (
    <div className="loop-controls">
      <div className="loop-controls__buttons">
        {/* Review: hidden when autoReviewSpecs=true (Review becomes part of
            Start Loop). While running, button becomes Stop Review (red). */}
        {!autoReviewSpecs && (
          isReviewRunning ? (
            <button
              className="btn btn--danger"
              disabled={loading !== null}
              onClick={() => doAction("stopReview", () => api.stopReview(workspaceId))}
            >
              {loading === "stopReview" ? "Stopping..." : "Stop Review"}
            </button>
          ) : (
            <button
              className="btn btn--primary"
              disabled={loading !== null || isBusy}
              onClick={() => doAction("review", () => api.startReview(workspaceId))}
            >
              {loading === "review" ? "Starting review..." : "Review"}
            </button>
          )
        )}

        {/* Start Loop / Stop Loop / Resume */}
        {canStart && (
          <button
            className="btn btn--primary"
            disabled={loading !== null || isBusy}
            onClick={() => doAction("start", () => api.startLoop(workspaceId))}
          >
            {loading === "start" ? "Starting..." : "Start Loop"}
          </button>
        )}
        {isLoopRunning && (
          <button
            className="btn btn--danger"
            disabled={loading !== null}
            onClick={() => doAction("stop", () => api.stopLoop(workspaceId))}
          >
            {loading === "stop" ? "Stopping..." : "Stop"}
          </button>
        )}
        {/* Resume / Stop / Document buttons are hidden when the loop is
            paused (item 6.25, fix 2026-05-02). The FeedbackForm's 5
            action buttons (Continue / Finish loop / Stop loop now /
            Refine plan / Ask Reflection to decide) cover every case
            and route correctly through the structured ResumeAction
            enum. The legacy buttons here would call resumeLoop without
            an action (defaulting server-side to "continue") or stopLoop
            (skipping the audit-feedback capture path) — both are wrong
            routing surfaces while the FeedbackForm is showing. */}

        {/* Document button: visible when loop is NOT paused (post-loop
            manual run is a sensible action). When paused, "Finish loop"
            in the FeedbackForm runs the documenter as part of resuming. */}
        {!isPaused && (
          isDocumentRunning ? (
            <button
              className="btn btn--danger"
              disabled={loading !== null}
              onClick={() => doAction("stopDocument", () => api.stopDocument(workspaceId))}
            >
              {loading === "stopDocument" ? "Stopping..." : "Stop Document"}
            </button>
          ) : (
            <button
              className="btn btn--primary"
              disabled={loading !== null || isBusy}
              onClick={() => doAction("document", () => api.startDocument(workspaceId))}
            >
              {loading === "document" ? "Starting document..." : "Document"}
            </button>
          )
        )}
      </div>
      {autoReviewSpecs && (
        <div
          style={{
            fontSize: "0.8rem",
            color: "var(--color-text-muted)",
            marginTop: "0.5rem",
          }}
        >
          Review is part of the Loop (autoReviewSpecs is on). Change in Settings.
        </div>
      )}
      {error && <div className="loop-controls__error">{error}</div>}
    </div>
  );
}
