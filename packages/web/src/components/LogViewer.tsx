import { useEffect, useRef, useState } from "react";
import { useSSE } from "../hooks/useSSE";

export interface LogTarget {
  workspaceId: string;
  logFile: string;
  /** Human-readable label: "Iteration 2 (dev)", "Architect run 1", "Documenter run 1", etc. */
  label: string;
}

export function LogViewer({ target }: { target: LogTarget | null }) {
  // Item 6.35 follow-up (2026-05-10): a manual refresh counter
  // bumped by the user lets them re-fetch the log when the SSE
  // stream finished prematurely. Real dogfood: claude-code-ollama
  // buffers stdout for the entire run; the agent transitions
  // through "executing" → "collecting" → "completed" with file
  // flushing intermixed; an SSE poll that happens between flush
  // and status-transition can emit `done` before the late-arriving
  // buffer makes it through the network. Workaround until the
  // server-side race is closed: a Refresh button that resets the
  // EventSource by changing the URL key.
  const [refreshCounter, setRefreshCounter] = useState(0);
  const url = target
    ? `/api/workspaces/${encodeURIComponent(target.workspaceId)}/logs/${encodeURIComponent(target.logFile)}` +
      (refreshCounter > 0 ? `?_=${refreshCounter}` : "")
    : null;
  const { lines, connected, done } = useSSE(url);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);

  // Auto-scroll to bottom when new lines arrive (if user hasn't scrolled up)
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines.length, autoScroll]);

  // Update scroll position state after content loads
  useEffect(() => {
    if (containerRef.current) {
      const el = containerRef.current;
      setAtTop(el.scrollTop < 50);
      setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 50);
    }
  }, [lines.length]);

  function handleScroll() {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    const isAtTop = scrollTop < 50;
    setAtBottom(isAtBottom);
    setAtTop(isAtTop);
    setAutoScroll(isAtBottom);
  }

  if (!target) {
    return (
      <div className="log-viewer__empty">
        No log selected. Pick an event from History, or start a Review / Start Loop / Document.
      </div>
    );
  }

  const text = lines.join("\n");
  const isLoading = !done && lines.length === 0;
  const isStreaming = connected && !done;

  return (
    <div className={`log-viewer ${isStreaming ? "log-viewer--loading" : ""}`}>
      <div className="log-viewer__header">
        <span>
          {target.label}
          {lines.length > 0 && ` — ${lines.length.toLocaleString()} lines`}
          {isStreaming && " (loading...)"}
        </span>
        <span className="log-viewer__actions">
          {isLoading && <span className="log-viewer__spinner" />}
          {/* Refresh button — re-opens the EventSource against the
              same log file. Useful when the stream completed
              prematurely (e.g. claude-code-ollama buffering race;
              see useSSE / SSE handler in app.ts). Always visible
              once the stream is done so the user has a recovery
              path without navigating away + back. */}
          {done && target && (
            <button
              className="btn btn--small btn--secondary"
              title="Re-fetch the log file from disk (workaround for buffered-output races)"
              onClick={() => setRefreshCounter((n) => n + 1)}
            >
              refresh
            </button>
          )}
          {!atTop && (
            <button
              className="btn btn--small btn--secondary"
              onClick={() => {
                if (containerRef.current) {
                  containerRef.current.scrollTop = 0;
                  setAutoScroll(false);
                }
              }}
            >
              top
            </button>
          )}
          {!atBottom && (
            <button
              className="btn btn--small btn--secondary"
              onClick={() => {
                setAutoScroll(true);
                if (containerRef.current) {
                  containerRef.current.scrollTop = containerRef.current.scrollHeight;
                }
              }}
            >
              bottom
            </button>
          )}
        </span>
      </div>
      <div
        className="log-viewer__content"
        ref={containerRef}
        onScroll={handleScroll}
      >
        {lines.length === 0 && !done && (
          <div className="log-viewer__empty">Waiting for log output...</div>
        )}
        <pre className="log-viewer__pre">{text}</pre>
      </div>
    </div>
  );
}
