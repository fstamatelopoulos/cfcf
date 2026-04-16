import { useState, useEffect } from "react";
import type { LoopPhase } from "../types";
import * as api from "../api";

export function LoopControls({
  projectId,
  phase,
  onAction,
}: {
  projectId: string;
  phase?: LoopPhase | null;
  onAction: () => void;
}) {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewRunning, setReviewRunning] = useState(false);
  const [documentRunning, setDocumentRunning] = useState(false);

  // Poll review status when running
  useEffect(() => {
    if (!reviewRunning) return;
    const id = setInterval(async () => {
      try {
        const status = await api.fetchReviewStatus(projectId);
        if (status.status === "completed" || status.status === "failed") {
          setReviewRunning(false);
          onAction();
        }
      } catch {
        // Review status not found — it finished or was never started
        setReviewRunning(false);
      }
    }, 3000);
    return () => clearInterval(id);
  }, [reviewRunning, projectId, onAction]);

  // Poll document status when running
  useEffect(() => {
    if (!documentRunning) return;
    const id = setInterval(async () => {
      try {
        const status = await api.fetchDocumentStatus(projectId);
        if (status.status === "completed" || status.status === "failed") {
          setDocumentRunning(false);
          onAction();
        }
      } catch {
        setDocumentRunning(false);
      }
    }, 3000);
    return () => clearInterval(id);
  }, [documentRunning, projectId, onAction]);

  async function doAction(name: string, action: () => Promise<unknown>) {
    setLoading(name);
    setError(null);
    try {
      await action();
      if (name === "review") setReviewRunning(true);
      if (name === "document") setDocumentRunning(true);
      onAction();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(null);
    }
  }

  const isRunning = phase && ["preparing", "dev_executing", "judging", "deciding"].includes(phase);
  const isPaused = phase === "paused";
  const canStart = !phase || ["idle", "completed", "failed", "stopped"].includes(phase);
  const isBusy = !!isRunning || reviewRunning || documentRunning;

  return (
    <div className="loop-controls">
      <div className="loop-controls__buttons">
        <button
          className="btn btn--primary"
          disabled={loading !== null || isBusy}
          onClick={() => doAction("review", () => api.startReview(projectId))}
        >
          {loading === "review" || reviewRunning ? "Reviewing..." : "Review"}
        </button>
        {canStart && (
          <button
            className="btn btn--primary"
            disabled={loading !== null || isBusy}
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
          disabled={loading !== null || isBusy}
          onClick={() => doAction("document", () => api.startDocument(projectId))}
        >
          {loading === "document" || documentRunning ? "Documenting..." : "Document"}
        </button>
      </div>
      {(reviewRunning || documentRunning) && (
        <div className="loop-controls__status">
          {reviewRunning && "Architect review in progress..."}
          {documentRunning && "Generating documentation..."}
        </div>
      )}
      {error && <div className="loop-controls__error">{error}</div>}
    </div>
  );
}
