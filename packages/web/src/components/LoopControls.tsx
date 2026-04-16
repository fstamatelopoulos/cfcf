import { useState } from "react";
import type { LoopPhase } from "../types";
import * as api from "../api";

export type AgentAction = "review" | "start" | "resume" | "stop" | "document";

export function LoopControls({
  projectId,
  phase,
  onAction,
}: {
  projectId: string;
  phase?: LoopPhase | null;
  /** Called after an action is dispatched. For review/start/document, the
   *  caller should switch to the Logs tab and show the log for the new run. */
  onAction: (action: AgentAction) => void;
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

  const isRunning = phase && ["preparing", "dev_executing", "judging", "deciding", "documenting"].includes(phase);
  const isPaused = phase === "paused";
  const canStart = !phase || ["idle", "completed", "failed", "stopped"].includes(phase);

  return (
    <div className="loop-controls">
      <div className="loop-controls__buttons">
        <button
          className="btn btn--primary"
          disabled={loading !== null || !!isRunning}
          onClick={() => doAction("review", () => api.startReview(projectId))}
        >
          {loading === "review" ? "Starting review..." : "Review"}
        </button>
        {canStart && (
          <button
            className="btn btn--primary"
            disabled={loading !== null}
            onClick={() => doAction("start", () => api.startLoop(projectId))}
          >
            {loading === "start" ? "Starting..." : "Start Loop"}
          </button>
        )}
        {isRunning && (
          <button
            className="btn btn--danger"
            disabled={loading !== null}
            onClick={() => doAction("stop", () => api.stopLoop(projectId))}
          >
            {loading === "stop" ? "Stopping..." : "Stop"}
          </button>
        )}
        {isPaused && (
          <button
            className="btn btn--primary"
            disabled={loading !== null}
            onClick={() => doAction("resume", () => api.resumeLoop(projectId))}
          >
            {loading === "resume" ? "Resuming..." : "Resume"}
          </button>
        )}
        {isPaused && (
          <button
            className="btn btn--danger"
            disabled={loading !== null}
            onClick={() => doAction("stop", () => api.stopLoop(projectId))}
          >
            Stop
          </button>
        )}
        <button
          className="btn btn--primary"
          disabled={loading !== null || !!isRunning}
          onClick={() => doAction("document", () => api.startDocument(projectId))}
        >
          {loading === "document" ? "Starting document..." : "Document"}
        </button>
      </div>
      {error && <div className="loop-controls__error">{error}</div>}
    </div>
  );
}
