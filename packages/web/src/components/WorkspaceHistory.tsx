import { useState } from "react";
import type {
  HistoryEvent,
  IterationHistoryEvent,
  ReviewHistoryEvent,
  DocumentHistoryEvent,
  ReflectionHistoryEvent,
  PaSessionHistoryEvent,
  LoopStoppedHistoryEvent,
  IterationHealth,
} from "../types";
import type { LogTarget } from "./LogViewer";
import { ArchitectReview } from "./ArchitectReview";
import { JudgeDetail } from "./JudgeDetail";
import { ReflectionDetail } from "./ReflectionDetail";
import { PaSessionDetail } from "./PaSessionDetail";
import { formatDurationOrRunning } from "../utils/time";
import {
  deriveDevRowStatus,
  deriveJudgeRowStatus,
} from "../utils/iteration-row-status";

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
  // SCOPE_COMPLETE (item 6.25 follow-up): not a problem state — the spec
  // is fine, there's just no work left. Render as info/neutral rather
  // than success (which would imply the loop ran successfully) or warning.
  SCOPE_COMPLETE: "var(--color-info)",
};

const healthColor: Record<IterationHealth, string> = {
  converging: "var(--color-success)",
  stable: "var(--color-info)",
  stalled: "var(--color-warning)",
  diverging: "var(--color-error)",
  inconclusive: "var(--color-text-subtle)",
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

export function WorkspaceHistory({
  events,
  workspaceId,
  onSelectLog,
}: {
  events: HistoryEvent[];
  workspaceId: string;
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
          {sorted.map((e) =>
            e.type === "iteration" ? (
              <IterationRowPair
                key={e.id}
                event={e as IterationHistoryEvent}
                workspaceId={workspaceId}
                onSelectLog={onSelectLog}
              />
            ) : (
              <HistoryRow
                key={e.id}
                event={e}
                workspaceId={workspaceId}
                onSelectLog={onSelectLog}
              />
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

function HistoryRow({
  event,
  workspaceId,
  onSelectLog,
}: {
  event: HistoryEvent;
  workspaceId: string;
  onSelectLog: (target: LogTarget) => void;
}) {
  const statusColor =
    event.status === "running"
      ? "var(--color-info)"
      : event.status === "completed"
      ? "var(--color-success)"
      : "var(--color-error)";

  // Type-column labels follow a consistent "<Role> · <task>" shape
  // (state is in its own column). When there's no per-event task
  // detail, just the role name is shown. Note: `iteration` events
  // route to `IterationRowPair` higher up — they never hit this
  // switch (F.21, v0.24+). The case is kept defensively for type
  // exhaustiveness; rendering it would show the legacy combined label.
  const typeLabel = (() => {
    switch (event.type) {
      case "iteration": {
        const e = event as IterationHistoryEvent;
        return `Dev + Judge · iter ${e.iteration}`;
      }
      case "review": {
        const e = event as ReviewHistoryEvent;
        return e.trigger === "loop"
          ? "Solution Architect · pre-loop review"
          : "Solution Architect · review";
      }
      case "reflection": {
        const e = event as ReflectionHistoryEvent;
        return e.iteration
          ? `Reflection · iter ${e.iteration}`
          : "Reflection (manual)";
      }
      case "document":
        return "Documenter";
      case "pa-session":
        return "Product Architect";
      case "loop-stopped": {
        const e = event as LoopStoppedHistoryEvent;
        return e.iteration
          ? `Loop stopped by user · after iter ${e.iteration}`
          : "Loop stopped by user";
      }
    }
  })();

  // For events that don't run an agent (loop-stopped — user action),
  // show "(user action)" in the Agent column instead of an empty cell.
  const agentLabel = event.agent
    ? event.model
      ? `${event.agent}:${event.model}`
      : event.agent
    : "(user action)";

  const reviewEvent = event.type === "review" ? (event as ReviewHistoryEvent) : null;
  const iterationEvent = event.type === "iteration" ? (event as IterationHistoryEvent) : null;
  const reflectionEvent = event.type === "reflection" ? (event as ReflectionHistoryEvent) : null;
  const paSessionEvent = event.type === "pa-session" ? (event as PaSessionHistoryEvent) : null;
  const loopStoppedEvent =
    event.type === "loop-stopped" ? (event as LoopStoppedHistoryEvent) : null;

  const hasReviewDetail = !!reviewEvent?.signals;
  const hasIterationDetail = !!(iterationEvent?.judgeSignals || iterationEvent?.devSignals);
  const hasReflectionDetail = !!reflectionEvent; // always expandable once it exists
  const hasPaSessionDetail = !!paSessionEvent; // always expandable
  // loop-stopped is only expandable when the user provided feedback —
  // otherwise the row already shows everything (iteration, status).
  const hasLoopStoppedDetail = !!loopStoppedEvent?.userFeedback?.trim();
  const canExpand =
    hasReviewDetail ||
    hasIterationDetail ||
    hasReflectionDetail ||
    hasPaSessionDetail ||
    hasLoopStoppedDetail;

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
          {/* Committed badge for MANUAL review runs (F.1, v0.24). The
              in-loop pre-loop review commits via the iteration-loop's
              own `cfcf pre-loop review (<readiness>)` commit and
              doesn't set `committed` on the event; only the manual
              architect-runner path sets it explicitly. */}
          {reviewEvent?.trigger === "manual" && reviewEvent?.committed === true && (
            <span className="project-history__merged" title="Review outputs committed to the current branch.">
              {" "}✓ committed
            </span>
          )}
          {reviewEvent?.trigger === "manual" && reviewEvent?.committed === false && event.status === "completed" && (
            <span
              style={{ color: "var(--color-text-muted)", fontSize: "var(--text-xs)", marginLeft: "0.5rem" }}
              title="Review ran successfully but produced no on-disk changes — nothing to commit."
            >
              (no changes to commit)
            </span>
          )}
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
          {paSessionEvent && (
            <button
              type="button"
              className="project-history__readiness-pill"
              onClick={toggle}
              title="Click to view Product Architect session details (scratchpad / workspace summary / meta)"
              style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }}
            >
              <PaSessionResult event={paSessionEvent} />
              <span style={{ color: "var(--color-text-muted)" }}> {expanded ? "▾" : "▸"}</span>
            </button>
          )}
          {loopStoppedEvent &&
            (hasLoopStoppedDetail ? (
              <button
                type="button"
                className="project-history__readiness-pill"
                onClick={toggle}
                title="Click to view the user's feedback on stop"
                style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }}
              >
                <LoopStoppedResult event={loopStoppedEvent} />
                <span style={{ color: "var(--color-text-muted)" }}> {expanded ? "▾" : "▸"}</span>
              </button>
            ) : (
              <LoopStoppedResult event={loopStoppedEvent} />
            ))}
        </td>
        <td>{formatDurationOrRunning(event.startedAt, event.completedAt)}</td>
        <td className="project-history__actions">
          {event.type === "iteration" ? (
            <>
              <button
                className="btn btn--small btn--secondary"
                onClick={() =>
                  onSelectLog({
                    workspaceId,
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
                    workspaceId,
                    logFile: (event as IterationHistoryEvent).judgeLogFile,
                    label: `Iteration ${(event as IterationHistoryEvent).iteration} (judge)`,
                  })
                }
              >
                judge
              </button>
            </>
          ) : event.type === "pa-session" ? (
            // PA sessions don't have a streamable agent log -- the
            // session scratchpad is part of the detail panel below.
            <button
              type="button"
              className="btn btn--small btn--secondary"
              onClick={toggle}
              title="Toggle Product Architect session detail (scratchpad / summary / meta)"
            >
              {expanded ? "hide" : "view"}
            </button>
          ) : event.type === "loop-stopped" ? (
            // No agent log to stream -- this is a user action. Offer
            // "view"/"hide" if the user provided feedback worth showing.
            hasLoopStoppedDetail ? (
              <button
                type="button"
                className="btn btn--small btn--secondary"
                onClick={toggle}
                title="Toggle user feedback detail"
              >
                {expanded ? "hide" : "view"}
              </button>
            ) : (
              <span style={{ color: "var(--color-text-muted)" }}>—</span>
            )
          ) : event.logFile ? (
            <button
              className="btn btn--small btn--secondary"
              onClick={() =>
                onSelectLog({
                  workspaceId,
                  logFile: event.logFile!,
                  label: `${typeLabel} (${event.agent ?? "agent"})`,
                })
              }
            >
              {/* Role-specific button label so the History tab's
                  log column is uniformly labelled by ROLE — matching
                  the iteration row's "dev" / "judge" buttons. F.21
                  follow-up (2026-05-12). */}
              {event.type === "review"
                ? "architect"
                : event.type === "document"
                  ? "documenter"
                  : event.type === "reflection"
                    ? "reflection"
                    : "log"}
            </button>
          ) : (
            <span style={{ color: "var(--color-text-muted)" }}>—</span>
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
            {hasPaSessionDetail && paSessionEvent && (
              <PaSessionDetail event={paSessionEvent} workspaceId={workspaceId} />
            )}
            {hasLoopStoppedDetail && loopStoppedEvent && (
              <LoopStoppedDetail event={loopStoppedEvent} />
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Render an iteration event as TWO sibling rows (Dev + Judge) instead
 * of one combined "Dev + Judge · iter N" row (item F.21, v0.24+).
 *
 * Rationale: the previous combined row hid the judge adapter (Agent
 * column only showed `event.devAgent`), conflated dev success / judge
 * verdict into a single status cell, and made it impossible to tell at
 * a glance which half failed when the row was red. The data model
 * already stores everything separately (`devAgent`/`judgeAgent`,
 * `devLogFile`/`judgeLogFile`, `devExitCode`/`judgeExitCode`,
 * `devSignals`/`judgeSignals`); this rendering change just surfaces
 * the existing split. PhaseIndicator's live status bar already
 * separates them (prepare → dev → judge → reflect → decide), so the
 * History tab now matches that mental model.
 *
 * No data migration: same `IterationHistoryEvent` shape, just rendered
 * as a pair. Each row has its own `expanded` state + its own targeted
 * detail panel. Old events without `devCompletedAt` (pre-F.21) render
 * the dev row's duration as "—" with a tooltip.
 */
function IterationRowPair({
  event,
  workspaceId,
  onSelectLog,
}: {
  event: IterationHistoryEvent;
  workspaceId: string;
  onSelectLog: (target: LogTarget) => void;
}) {
  const [devExpanded, setDevExpanded] = useState(false);
  const [judgeExpanded, setJudgeExpanded] = useState(false);

  // Per-half status — derived by the pure helper in
  // `../utils/iteration-row-status` so the per-state matrix is
  // unit-testable. Each row reflects only ITS half, matching how
  // the live PhaseIndicator highlights exactly one of [prepare →
  // dev → judge → reflect → decide] at a time.
  const devStatus = deriveDevRowStatus(event);
  const judgeStatus = deriveJudgeRowStatus(event);

  const devStatusColor =
    devStatus === "running"
      ? "var(--color-info)"
      : devStatus === "completed"
        ? "var(--color-success)"
        : "var(--color-error)";
  const judgeStatusColor =
    judgeStatus === "running"
      ? "var(--color-info)"
      : judgeStatus === "completed"
        ? "var(--color-success)"
        : judgeStatus === "pending" || judgeStatus === "skipped"
          ? "var(--color-text-muted)"
          : "var(--color-error)";

  // Dev duration: prefer the explicit `devCompletedAt` when present
  // (F.21 servers). Falls back to "—" for old events. NOT the same as
  // the whole-event duration — that's judge's territory.
  const devDuration = event.devCompletedAt
    ? formatDurationOrRunning(event.startedAt, event.devCompletedAt)
    : event.devExitCode !== undefined
      ? "—"
      : "running";
  // Judge duration: from devCompletedAt (judge's start, when available)
  // to completedAt (judge's end = iteration end). When the judge
  // hasn't started yet (pending), render "—" — there's nothing to
  // count. Falls back to the whole-event window for old events
  // missing devCompletedAt.
  const judgeStart = event.devCompletedAt ?? event.startedAt;
  const judgeDuration =
    judgeStatus === "pending" || judgeStatus === "skipped"
      ? "—"
      : event.completedAt
        ? formatDurationOrRunning(judgeStart, event.completedAt)
        : event.devCompletedAt
          ? "running"
          : "—";

  const hasDevSignals = !!event.devSignals;
  const hasJudgeSignals = !!event.judgeSignals;

  // Judge result summary (determination + quality + tests) — same shape
  // the pre-F.21 combined row showed in the Result column.
  const judgeResultCell = event.judgeDetermination ? (() => {
    const j = event.judgeSignals;
    const d = event.devSignals;
    const passed = j?.tests_passed ?? d?.tests_passed;
    const total = j?.tests_total ?? d?.tests_total;
    const hasQ = event.judgeQuality !== undefined;
    const hasTests = passed !== undefined && total !== undefined;
    const summary = (
      <>
        {event.judgeDetermination}
        {(hasQ || hasTests) && (
          <>
            {" "}(
            {hasQ && <>{event.judgeQuality}/10</>}
            {hasQ && hasTests && " · "}
            {hasTests && <>{passed}/{total}</>}
            )
          </>
        )}
      </>
    );
    const color = determinationColor[event.judgeDetermination] || "inherit";
    return hasJudgeSignals ? (
      <button
        type="button"
        className="project-history__readiness-pill"
        onClick={() => setJudgeExpanded((v) => !v)}
        title="Click to view judge signals"
        style={{ color }}
      >
        {summary} {judgeExpanded ? "▾" : "▸"}
      </button>
    ) : (
      <span style={{ color }}>{summary}</span>
    );
  })() : null;

  // Dev result summary: test counts + (when expandable) a click hint.
  // Falls back to "—" if dev signals haven't been parsed.
  const devTests = (() => {
    const d = event.devSignals;
    if (!d) return null;
    const passed = d.tests_passed;
    const total = d.tests_total;
    if (passed === undefined || total === undefined) return null;
    return <>{passed}/{total} tests</>;
  })();
  const devResultCell = devTests ? (
    hasDevSignals ? (
      <button
        type="button"
        className="project-history__readiness-pill"
        onClick={() => setDevExpanded((v) => !v)}
        title="Click to view dev signals"
        style={{ color: "var(--color-text-muted)" }}
      >
        {devTests} {devExpanded ? "▾" : "▸"}
      </button>
    ) : (
      <span style={{ color: "var(--color-text-muted)" }}>{devTests}</span>
    )
  ) : null;

  return (
    <>
      {/* Dev row */}
      <tr className="project-history__row project-history__row--iteration-dev">
        <td className="project-history__time">{formatTime(event.startedAt)}</td>
        <td>Dev · iter {event.iteration}</td>
        <td className="project-history__agent">
          {event.devAgent}
          {event.model && event.devAgent === event.agent && `:${event.model}`}
        </td>
        <td>
          <span style={{ color: devStatusColor }}>{devStatus}</span>
        </td>
        <td>{devResultCell}</td>
        <td title={event.devCompletedAt ? undefined : "Pre-F.21 event — per-half duration not tracked. The whole iteration duration is on the Judge row."}>{devDuration}</td>
        <td className="project-history__actions">
          <button
            className="btn btn--small btn--secondary"
            onClick={() =>
              onSelectLog({
                workspaceId,
                logFile: event.devLogFile,
                label: `Iteration ${event.iteration} (dev)`,
              })
            }
          >
            dev
          </button>
        </td>
      </tr>
      {/* Dev expanded detail */}
      {devExpanded && hasDevSignals && (
        <tr className="project-history__detail-row">
          <td colSpan={7}>
            <JudgeDetail
              dev={event.devSignals}
              judge={undefined}
              meta={{ branch: event.branch }}
            />
          </td>
        </tr>
      )}
      {/* Judge row */}
      <tr className="project-history__row project-history__row--iteration-judge">
        <td className="project-history__time">
          {/* Judge starts when dev completes — use that as its
              displayed time if we have it. Falls back to event
              start for old events. */}
          {event.devCompletedAt
            ? formatTime(event.devCompletedAt)
            : formatTime(event.startedAt)}
        </td>
        <td>Judge · iter {event.iteration}</td>
        <td className="project-history__agent">{event.judgeAgent}</td>
        <td>
          <span style={{ color: judgeStatusColor }}>{judgeStatus}</span>
        </td>
        <td>
          {judgeResultCell}
          {event.merged && (
            <span className="project-history__merged"> ✓ merged</span>
          )}
        </td>
        <td>{judgeDuration}</td>
        <td className="project-history__actions">
          <button
            className="btn btn--small btn--secondary"
            onClick={() =>
              onSelectLog({
                workspaceId,
                logFile: event.judgeLogFile,
                label: `Iteration ${event.iteration} (judge)`,
              })
            }
          >
            judge
          </button>
        </td>
      </tr>
      {/* Judge expanded detail */}
      {judgeExpanded && hasJudgeSignals && (
        <tr className="project-history__detail-row">
          <td colSpan={7}>
            <JudgeDetail
              judge={event.judgeSignals}
              dev={undefined}
              meta={{ branch: event.branch }}
            />
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

  // Committed flag. Set by both the in-loop documenter (after a
  // SUCCESS) and (since v0.24) the standalone documenter via the
  // F.1 commit-on-success path. The `committed=false && docs>0` case
  // is no longer "the harness forgot to commit" — it's "the
  // documenter re-wrote the same content that's already in git, so
  // there was nothing to commit". Pre-v0.24 the label read "(not
  // committed)" which implied a missed step; now it reflects what
  // actually happened ("no changes to commit"). Same wording change
  // applied to the parallel rendering on ReviewResult / ReflectionResult.
  if (event.committed) {
    parts.push(
      <span key="committed" className="project-history__merged">
        {" "}
        ✓ committed
      </span>,
    );
  } else if (event.committed === false && event.docsFileCount && event.docsFileCount > 0) {
    parts.push(
      <span
        key="no-changes"
        style={{ color: "var(--color-text-muted)", fontSize: "var(--text-xs)" }}
        title="The documenter ran successfully but produced no changes vs the working tree — nothing to commit."
      >
        {" "}(no changes to commit)
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
      {/* Committed badge — only present on manual / standalone runs
          (in-loop reflections commit via the iteration-loop's own
          gitManager call and don't surface `committed` on this event).
          F.1 v0.24. */}
      {event.committed === true && (
        <span className="project-history__merged" title="Reflection outputs committed to the current branch.">
          {" "}✓ committed
        </span>
      )}
      {event.committed === false && event.trigger === "manual" && event.exitCode === 0 && (
        <span
          style={{ color: "var(--color-text-muted)", fontSize: "var(--text-xs)", marginLeft: "0.5rem" }}
          title="Reflection ran successfully but produced no on-disk changes — nothing to commit."
        >
          (no changes to commit)
        </span>
      )}
      {event.signals?.key_observation && (
        <div
          style={{ color: "var(--color-text-muted)", fontSize: "var(--text-xs)", marginTop: "0.25rem" }}
        >
          {event.signals.key_observation}
        </div>
      )}
    </>
  );
}

/**
 * Summary cell content for a PA-session row in the History tab.
 * Shows the agent-written outcomeSummary inline (if present) plus
 * a small decisions-count badge. Falls back to a neutral status mark
 * when the agent didn't save any structured outcome.
 */
function PaSessionResult({ event }: { event: PaSessionHistoryEvent }) {
  const decisionsBadge =
    typeof event.decisionsCount === "number" && event.decisionsCount > 0 ? (
      <span style={{ color: "var(--color-info)", marginLeft: "0.5rem" }}>
        ✎ {event.decisionsCount} decision{event.decisionsCount === 1 ? "" : "s"}
      </span>
    ) : null;

  const outcomeBlurb = event.outcomeSummary?.trim();

  if (!outcomeBlurb && !decisionsBadge) {
    return (
      <span style={{ color: "var(--color-text-muted)" }}>
        {event.status === "completed"
          ? "session ended (no save)"
          : event.status === "running"
            ? "live"
            : "—"}
      </span>
    );
  }

  return (
    <>
      <span style={{ color: "var(--color-text)" }}>
        {outcomeBlurb || (event.status === "running" ? "live" : "session saved")}
      </span>
      {decisionsBadge}
    </>
  );
}

/**
 * Item 6.25: summary cell for a `loop-stopped` row. Shows a short
 * blurb (first ~80 chars of the user's feedback, if any) inline; if
 * no feedback, a neutral "stopped by user" mark. Always shows the
 * iteration the loop stopped at, so the user can correlate quickly.
 */
function LoopStoppedResult({ event }: { event: LoopStoppedHistoryEvent }) {
  const fb = event.userFeedback?.trim();
  const previewLen = 80;
  const preview = fb
    ? fb.length > previewLen
      ? fb.slice(0, previewLen).trimEnd() + "…"
      : fb
    : null;

  return (
    <span style={{ color: "var(--color-text)" }}>
      stopped by user
      {preview && (
        <>
          <span style={{ color: "var(--color-text-muted)" }}> · </span>
          <span style={{ color: "var(--color-text-muted)", fontStyle: "italic" }}>
            "{preview}"
          </span>
        </>
      )}
    </span>
  );
}

/**
 * Item 6.25: expanded detail row for a `loop-stopped` event — shows
 * the user's full feedback (preserved verbatim) plus the metadata
 * a user might want when reviewing why the loop stopped.
 */
function LoopStoppedDetail({ event }: { event: LoopStoppedHistoryEvent }) {
  const fb = event.userFeedback?.trim();
  return (
    <div
      style={{
        padding: "0.75rem 1rem",
        background: "color-mix(in srgb, var(--color-info) 6%, transparent)",
        borderLeft: "3px solid var(--color-text-muted)",
        borderRadius: "4px",
      }}
    >
      <div style={{ marginBottom: "0.5rem", fontSize: "var(--text-sm)" }}>
        <strong>Loop stopped by user</strong>
        {event.iteration ? ` after iteration ${event.iteration}` : ""}.{" "}
        {event.completedAt && (
          <span style={{ color: "var(--color-text-muted)" }}>
            ({formatTime(event.completedAt)})
          </span>
        )}
      </div>
      {fb ? (
        <div>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--color-text-muted)",
              marginBottom: "0.25rem",
            }}
          >
            User feedback:
          </div>
          <pre
            style={{
              margin: 0,
              padding: "0.5rem 0.75rem",
              background: "var(--color-surface, rgba(0,0,0,0.04))",
              borderRadius: "3px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontSize: "var(--text-sm)",
              fontFamily: "inherit",
              lineHeight: 1.5,
            }}
          >
            {fb}
          </pre>
        </div>
      ) : (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--color-text-muted)" }}>
          (No feedback provided.)
        </div>
      )}
    </div>
  );
}
