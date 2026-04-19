import type { ReflectionHistoryEvent, IterationHealth } from "../types";

const healthMeta: Record<IterationHealth, { color: string; guidance: string }> = {
  converging: {
    color: "var(--color-success)",
    guidance: "Progress is accelerating; fewer regressions, scope narrowing.",
  },
  stable: {
    color: "var(--color-info)",
    guidance: "Steady progress, no drift, but no acceleration either.",
  },
  stalled: {
    color: "var(--color-warning)",
    guidance:
      "Multiple iterations in the same area without measurable progress. Consider manual intervention.",
  },
  diverging: {
    color: "var(--color-error)",
    guidance: "The loop is drifting away from success criteria.",
  },
  inconclusive: {
    color: "var(--color-text-muted, #888)",
    guidance: "Not enough history yet to classify -- typical on iterations 1-2.",
  },
};

export function ReflectionDetail({ event }: { event: ReflectionHistoryEvent }) {
  const signals = event.signals;
  const health = (event.iterationHealth ?? signals?.iteration_health) as
    | IterationHealth
    | undefined;
  const meta = health ? healthMeta[health] : null;

  const agentClaimedModified = signals?.plan_modified === true;
  const actuallyModified = event.planModified === true;
  const rewriteRejected = agentClaimedModified && !actuallyModified;

  return (
    <div className="architect-review architect-review--compact">
      <div className="architect-review__header">
        <span className="architect-review__readiness" style={{ color: meta?.color }}>
          {health ?? "—"}
        </span>
        <span className="architect-review__counts">
          trigger: {event.trigger}
          {event.iteration ? ` · iter ${event.iteration}` : ""}
        </span>
      </div>

      {meta?.guidance && (
        <div className="architect-review__guidance" style={{ borderLeftColor: meta.color }}>
          {meta.guidance}
        </div>
      )}

      {signals?.key_observation && (
        <details className="architect-review__section" open>
          <summary className="architect-review__summary">Key observation</summary>
          <p className="architect-review__approach">{signals.key_observation}</p>
        </details>
      )}

      <details className="architect-review__section" open={rewriteRejected}>
        <summary className="architect-review__summary">
          Plan {actuallyModified ? "modified" : "unchanged"}
        </summary>
        <ul className="architect-review__list">
          {actuallyModified && (
            <li>
              The reflection agent rewrote the pending portion of{" "}
              <code>cfcf-docs/plan.md</code>. Completed items and iteration
              headers were preserved.
            </li>
          )}
          {!actuallyModified && agentClaimedModified && (
            <li style={{ color: "var(--color-warning)" }}>
              <strong>Rewrite rejected by non-destructive validator.</strong>
              <br />
              The agent produced a new plan but it removed a completed item or
              dropped an iteration header. cfcf reverted to the previous plan.
              {event.planRejectionReason && (
                <>
                  <br />
                  <span style={{ color: "var(--color-text-muted)" }}>
                    Reason: {event.planRejectionReason}
                  </span>
                </>
              )}
            </li>
          )}
          {!actuallyModified && !agentClaimedModified && (
            <li>The agent left the plan as-is.</li>
          )}
        </ul>
      </details>

      {signals?.recommend_stop && (
        <div
          className="architect-review__guidance"
          style={{ borderLeftColor: "var(--color-error)", color: "var(--color-error)" }}
        >
          <strong>recommend_stop = true.</strong> Reflection believes the loop
          is fundamentally stuck. cfcf pauses for you to arbitrate.
        </div>
      )}

      {event.error && (
        <details className="architect-review__section">
          <summary className="architect-review__summary">Error</summary>
          <p className="architect-review__approach">{event.error}</p>
        </details>
      )}
    </div>
  );
}
