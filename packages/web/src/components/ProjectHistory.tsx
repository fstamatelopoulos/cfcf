import { useState } from "react";
import type {
  HistoryEvent,
  IterationHistoryEvent,
  ReviewHistoryEvent,
  DocumentHistoryEvent,
  ReflectionHistoryEvent,
  IterationHealth,
} from "../types";
import type { LogTarget } from "./LogViewer";
import { ArchitectReview } from "./ArchitectReview";
import { JudgeDetail } from "./JudgeDetail";
import { ReflectionDetail } from "./ReflectionDetail";
import { formatDurationOrRunning } from "../utils/time";

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

const healthColor: Record<IterationHealth, string> = {
  converging: "var(--color-success)",
  stable: "var(--color-info)",
  stalled: "var(--color-warning)",
  diverging: "var(--color-error)",
  inconclusive: "var(--color-subtle, #888)",
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

// Duration formatter moved to ../utils/time so PhaseIndicator's live timer
// and this static column render identically.

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
      : event.type === "reflection"
      ? `Reflection${(event as ReflectionHistoryEvent).iteration ? ` · iter ${(event as ReflectionHistoryEvent).iteration}` : ""}`
      : "Document";

  const agentLabel = event.model ? `${event.agent}:${event.model}` : event.agent;

  const reviewEvent = event.type === "review" ? (event as ReviewHistoryEvent) : null;
  const iterationEvent = event.type === "iteration" ? (event as IterationHistoryEvent) : null;
  const reflectionEvent = event.type === "reflection" ? (event as ReflectionHistoryEvent) : null;

  const hasReviewDetail = !!reviewEvent?.signals;
  const hasIterationDetail = !!(iterationEvent?.judgeSignals || iterationEvent?.devSignals);
  const hasReflectionDetail = !!reflectionEvent; // always expandable once it exists
  const canExpand = hasReviewDetail || hasIterationDetail || hasReflectionDetail;

  const [expanded, setExpanded] = useState(false);
  const toggle = () => setExpanded((v) => !v);

  const readinessCell =
    reviewEvent?.readiness && (
      <span
        style={{ color: readinessColor[reviewEvent.readiness] || "inherit" }}
      >
        {hasReviewDetail ? (
          <button
            type="button"
            className="project-history__readiness-pill"
            onClick={toggle}
            title="Click to view gaps, suggestions, and risks"
          >
            {reviewEvent.readiness} {expanded ? "▾" : "▸"}
          </button>
        ) : (
          reviewEvent.readiness
        )}
      </span>
    );

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
          {readinessCell}
          {iterationEvent?.judgeDetermination && (() => {
            // Summarise judge result: quality + (when available) test counts.
            // E.g. "PROGRESS (8/10 · 5/5)". Tests come from judge signals if
            // persisted, otherwise dev signals as a fallback.
            const j = iterationEvent.judgeSignals;
            const d = iterationEvent.devSignals;
            const passed = j?.tests_passed ?? d?.tests_passed;
            const total = j?.tests_total ?? d?.tests_total;
            const hasQ = iterationEvent.judgeQuality !== undefined;
            const hasTests = passed !== undefined && total !== undefined;
            const summary = (
              <>
                {iterationEvent.judgeDetermination}
                {(hasQ || hasTests) && (
                  <>
                    {" "}(
                    {hasQ && <>{iterationEvent.judgeQuality}/10</>}
                    {hasQ && hasTests && " · "}
                    {hasTests && <>{passed}/{total}</>}
                    )
                  </>
                )}
              </>
            );
            const color = determinationColor[iterationEvent.judgeDetermination] || "inherit";
            return hasIterationDetail ? (
              <button
                type="button"
                className="project-history__readiness-pill"
                onClick={toggle}
                title="Click to view judge + dev signals"
                style={{ color }}
              >
                {summary} {expanded ? "▾" : "▸"}
              </button>
            ) : (
              <span style={{ color }}>{summary}</span>
            );
          })()}
          {iterationEvent?.merged && (
            <span className="project-history__merged"> ✓ merged</span>
          )}
          {event.type === "document" && event.status === "completed" && (
            <DocumentResult event={event as DocumentHistoryEvent} />
          )}
          {reflectionEvent && (
            <button
              type="button"
              className="project-history__readiness-pill"
              onClick={toggle}
              title="Click to view reflection details"
              style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }}
            >
              <ReflectionResult event={reflectionEvent} />
              <span style={{ color: "var(--color-text-muted)" }}> {expanded ? "▾" : "▸"}</span>
            </button>
          )}
        </td>
        <td>{formatDurationOrRunning(event.startedAt, event.completedAt)}</td>
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
      {expanded && canExpand && (
        <tr className="project-history__detail-row">
          <td colSpan={7}>
            {hasReviewDetail && reviewEvent?.signals && (
              <ArchitectReview signals={reviewEvent.signals} compact />
            )}
            {hasIterationDetail && iterationEvent && (
              <JudgeDetail
                judge={iterationEvent.judgeSignals}
                dev={iterationEvent.devSignals}
                meta={{ branch: iterationEvent.branch }}
              />
            )}
            {hasReflectionDetail && reflectionEvent && (
              <ReflectionDetail event={reflectionEvent} />
            )}
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

function ReflectionResult({ event }: { event: ReflectionHistoryEvent }) {
  const health = event.iterationHealth ?? event.signals?.iteration_health;
  if (!health && !event.signals) {
    return (
      <span style={{ color: "var(--color-text-muted)" }}>
        {event.exitCode === 0 ? "✓" : "—"}
      </span>
    );
  }
  return (
    <>
      {health && (
        <span style={{ color: healthColor[health] || "inherit" }}>{health}</span>
      )}
      {event.planModified || event.signals?.plan_modified ? (
        <span className="project-history__merged"> ✎ plan edited</span>
      ) : null}
      {event.signals?.recommend_stop && (
        <span
          style={{ color: "var(--color-error)", marginLeft: "0.5rem" }}
          title="Reflection recommends stopping the loop"
        >
          ! stop
        </span>
      )}
      {event.signals?.key_observation && (
        <div
          style={{ color: "var(--color-text-muted)", fontSize: "0.75rem", marginTop: "0.25rem" }}
        >
          {event.signals.key_observation}
        </div>
      )}
    </>
  );
}
