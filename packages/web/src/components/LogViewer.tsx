import { useEffect, useRef, useState } from "react";
import { useSSE } from "../hooks/useSSE";

export interface LogTarget {
  projectId: string;
  logFile: string;
  /** Human-readable label: "Iteration 2 (dev)", "Architect run 1", "Documenter run 1", etc. */
  label: string;
}

export function LogViewer({ target }: { target: LogTarget | null }) {
  const url = target
    ? `/api/projects/${encodeURIComponent(target.projectId)}/logs/${encodeURIComponent(target.logFile)}`
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
