import { useEffect, useRef } from "react";
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

  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines.length]);

  return (
    <div className="log-viewer">
      <div className="log-viewer__header">
        <span>
          Iteration {iteration} ({role})
        </span>
        <span className="log-viewer__status">
          {connected ? (
            <span className="status-dot status-dot--ok" title="streaming" />
          ) : done ? (
            "complete"
          ) : (
            <span className="status-dot status-dot--error" title="disconnected" />
          )}
        </span>
      </div>
      <div className="log-viewer__content" ref={containerRef}>
        {lines.length === 0 && !done && (
          <div className="log-viewer__empty">Waiting for log output...</div>
        )}
        {lines.map((line, i) => (
          <div key={i} className="log-viewer__line">
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}
