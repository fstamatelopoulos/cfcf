import type {
  HistoryEvent,
  IterationHistoryEvent,
  ReviewHistoryEvent,
  DocumentHistoryEvent,
} from "../types";
import type { LogTarget } from "./LogViewer";

const determinationColor: Record<string, string> = {
  SUCCESS: "var(--color-success)",
  PROGRESS: "var(--color-info)",
  STALLED: "var(--color-warning)",
  ANOMALY: "var(--color-error)",
};

const readinessColor: Record<string, string> = {
  READY: "var(--color-success)",
  NEEDS_REFINEMENT: "var(--color-warning)",
  BLOCKED: "var(--color-error)",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(startedAt: string, completedAt?: string): string {
  if (!completedAt) return "running";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export function ProjectHistory({
  events,
  projectId,
  onSelectLog,
}: {
  events: HistoryEvent[];
  projectId: string;
  onSelectLog: (target: LogTarget) => void;
}) {
  if (events.length === 0) {
    return (
      <div className="project-history__empty">
        No history yet. Click Review, Start Loop, or Document to begin.
      </div>
    );
  }

  // Sort newest first
  const sorted = [...events].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );

  return (
    <div className="project-history">
      <table className="project-history__table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Type</th>
            <th>Agent</th>
            <th>Status</th>
            <th>Result</th>
            <th>Duration</th>
            <th>Log</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((e) => (
            <HistoryRow key={e.id} event={e} projectId={projectId} onSelectLog={onSelectLog} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HistoryRow({
  event,
  projectId,
  onSelectLog,
}: {
  event: HistoryEvent;
  projectId: string;
  onSelectLog: (target: LogTarget) => void;
}) {
  const statusColor =
    event.status === "running"
      ? "var(--color-info)"
      : event.status === "completed"
      ? "var(--color-success)"
      : "var(--color-error)";

  const typeLabel =
    event.type === "iteration"
      ? `Iteration ${(event as IterationHistoryEvent).iteration}`
      : event.type === "review"
      ? "Review"
      : "Document";

  const agentLabel = event.model ? `${event.agent}:${event.model}` : event.agent;

  return (
    <>
      <tr className="project-history__row">
        <td className="project-history__time">{formatTime(event.startedAt)}</td>
        <td>{typeLabel}</td>
        <td className="project-history__agent">{agentLabel}</td>
        <td>
          <span style={{ color: statusColor }}>{event.status}</span>
        </td>
        <td>
          {event.type === "review" && (event as ReviewHistoryEvent).readiness && (
            <span style={{ color: readinessColor[(event as ReviewHistoryEvent).readiness!] || "inherit" }}>
              {(event as ReviewHistoryEvent).readiness}
            </span>
          )}
          {event.type === "iteration" && (event as IterationHistoryEvent).judgeDetermination && (
            <span
              style={{
                color:
                  determinationColor[(event as IterationHistoryEvent).judgeDetermination!] ||
                  "inherit",
              }}
            >
              {(event as IterationHistoryEvent).judgeDetermination}
              {(event as IterationHistoryEvent).judgeQuality !== undefined && (
                <> ({(event as IterationHistoryEvent).judgeQuality}/10)</>
              )}
            </span>
          )}
          {event.type === "iteration" && (event as IterationHistoryEvent).merged && (
            <span className="project-history__merged"> ✓ merged</span>
          )}
          {event.type === "document" && event.status === "completed" && (
            <DocumentResult event={event as DocumentHistoryEvent} />
          )}
        </td>
        <td>{formatDuration(event.startedAt, event.completedAt)}</td>
        <td className="project-history__actions">
          {event.type === "iteration" ? (
            <>
              <button
                className="btn btn--small btn--secondary"
                onClick={() =>
                  onSelectLog({
                    projectId,
                    logFile: (event as IterationHistoryEvent).devLogFile,
                    label: `Iteration ${(event as IterationHistoryEvent).iteration} (dev)`,
                  })
                }
              >
                dev
              </button>
              <button
                className="btn btn--small btn--secondary"
                onClick={() =>
                  onSelectLog({
                    projectId,
                    logFile: (event as IterationHistoryEvent).judgeLogFile,
                    label: `Iteration ${(event as IterationHistoryEvent).iteration} (judge)`,
                  })
                }
              >
                judge
              </button>
            </>
          ) : (
            <button
              className="btn btn--small btn--secondary"
              onClick={() =>
                onSelectLog({
                  projectId,
                  logFile: event.logFile,
                  label: `${typeLabel} (${event.agent})`,
                })
              }
            >
              log
            </button>
          )}
        </td>
      </tr>
      {event.error && (
        <tr className="project-history__error-row">
          <td colSpan={7} className="project-history__error">
            Error: {event.error}
          </td>
        </tr>
      )}
    </>
  );
}

function DocumentResult({ event }: { event: DocumentHistoryEvent }) {
  const parts: React.ReactNode[] = [];

  // File count in docs/
  if (event.docsFileCount !== undefined) {
    parts.push(
      <span key="files" style={{ color: "var(--color-success)" }}>
        {event.docsFileCount} doc{event.docsFileCount === 1 ? "" : "s"}
      </span>,
    );
  }

  // Committed flag (only set when run via iteration loop post-SUCCESS)
  if (event.committed) {
    parts.push(
      <span key="committed" className="project-history__merged">
        {" "}
        ✓ committed
      </span>,
    );
  } else if (event.committed === false && event.docsFileCount && event.docsFileCount > 0) {
    parts.push(
      <span key="uncommitted" style={{ color: "var(--color-text-muted)", fontSize: "0.75rem" }}>
        {" "}(not committed)
      </span>,
    );
  }

  if (parts.length === 0) {
    return (
      <span style={{ color: "var(--color-text-muted)" }}>
        {event.exitCode === 0 ? "✓" : "—"}
      </span>
    );
  }

  return <>{parts}</>;
}
