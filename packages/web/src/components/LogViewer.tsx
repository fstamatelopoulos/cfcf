import { useEffect, useRef, useState } from "react";
import { useSSE } from "../hooks/useSSE";

const MAX_RENDERED_LINES = 500;

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

  // Only render the last MAX_RENDERED_LINES to keep the DOM manageable
  const truncated = lines.length > MAX_RENDERED_LINES;
  const visibleLines = truncated
    ? lines.slice(lines.length - MAX_RENDERED_LINES)
    : lines;

  return (
    <div className="log-viewer">
      <div className="log-viewer__header">
        <span>
          Iteration {iteration} ({role}) — {lines.length} lines
        </span>
        <span className="log-viewer__status">
          {connected ? (
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
        {truncated && (
          <div className="log-viewer__truncated">
            ... {lines.length - MAX_RENDERED_LINES} earlier lines hidden ...
          </div>
        )}
        <pre className="log-viewer__pre">
          {visibleLines.join("\n")}
        </pre>
      </div>
    </div>
  );
}
