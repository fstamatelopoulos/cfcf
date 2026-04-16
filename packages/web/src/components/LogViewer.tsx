import { useEffect, useRef, useState } from "react";
import { useSSE } from "../hooks/useSSE";

export function LogViewer({
  projectId,
  iteration,
  role,
}: {
  projectId: string;
  iteration: number;
  role: "dev" | "judge";
}) {
  const url = `/api/projects/${encodeURIComponent(projectId)}/iterations/${iteration}/logs`;
  const { lines, connected, done } = useSSE(url);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Auto-scroll to bottom when new lines arrive (if user hasn't scrolled up)
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines.length, autoScroll]);

  // Detect if user scrolled up (disable auto-scroll)
  function handleScroll() {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 50;
    setAutoScroll(atBottom);
  }

  // Join all lines into a single string for the <pre> element.
  // Browsers handle large text in a single <pre> far better than
  // thousands of individual DOM elements.
  const text = lines.join("\n");
  const isLoading = !done && lines.length === 0;
  const isStreaming = connected && !done;

  return (
    <div className={`log-viewer ${isStreaming ? "log-viewer--loading" : ""}`}>
      <div className="log-viewer__header">
        <span>
          Iteration {iteration} ({role})
          {lines.length > 0 && ` — ${lines.length.toLocaleString()} lines`}
          {isStreaming && " (loading...)"}
        </span>
        <span className="log-viewer__status">
          {isLoading ? (
            <span className="log-viewer__spinner" />
          ) : connected ? (
            <span className="status-dot status-dot--ok" title="streaming" />
          ) : done ? (
            "complete"
          ) : (
            <span className="status-dot status-dot--error" title="disconnected" />
          )}
          {!autoScroll && (
            <button
              className="btn btn--small btn--secondary"
              onClick={() => {
                setAutoScroll(true);
                if (containerRef.current) {
                  containerRef.current.scrollTop = containerRef.current.scrollHeight;
                }
              }}
            >
              scroll to bottom
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
