import type { JudgeSignalsWeb, DevSignalsWeb } from "../types";

export interface JudgeDetailMeta {
  branch?: string;
}

const determinationMeta: Record<
  string,
  { color: string; guidance: string }
> = {
  SUCCESS: {
    color: "var(--color-success)",
    guidance: "All success criteria are met. The loop stopped and cfcf ran the documenter.",
  },
  PROGRESS: {
    color: "var(--color-info)",
    guidance: "Meaningful progress was made. The loop continues unless paused for cadence.",
  },
  STALLED: {
    color: "var(--color-warning)",
    guidance:
      "The judge saw no meaningful progress or a regression. The onStalled policy decides whether to continue / alert / stop.",
  },
  ANOMALY: {
    color: "var(--color-error)",
    guidance: "The judge flagged abnormal behavior. The loop is paused for user review.",
  },
};

function fmtTests(
  passed: number | undefined,
  failed: number | undefined,
  total: number | undefined,
  verified: boolean | undefined,
): string {
  if (passed === undefined && failed === undefined && total === undefined) return "—";
  const base = `${passed ?? 0}/${total ?? 0} passed`;
  const failStr = failed ? `, ${failed} failed` : "";
  const vrf = verified === false ? " (not verified by judge)" : "";
  return base + failStr + vrf;
}

export function JudgeDetail({
  judge,
  dev,
  meta,
}: {
  judge: JudgeSignalsWeb | undefined;
  dev: DevSignalsWeb | undefined;
  meta?: JudgeDetailMeta;
}) {
  if (!judge && !dev) {
    return (
      <div className="architect-review architect-review--compact">
        <div className="architect-review__guidance">
          No parsed signals persisted for this iteration yet.
        </div>
      </div>
    );
  }

  const dm = judge ? determinationMeta[judge.determination] : null;

  return (
    <div className="architect-review architect-review--compact">
      {judge && (
        <>
          <div className="architect-review__header">
            <span className="architect-review__readiness" style={{ color: dm?.color }}>
              {judge.determination}
              <span style={{ color: "var(--color-text-muted)", fontWeight: "normal" }}>
                {" · "}quality {judge.quality_score}/10
              </span>
            </span>
            {judge.anomaly_type && (
              <span className="architect-review__counts" style={{ color: "var(--color-error)" }}>
                anomaly: {judge.anomaly_type}
              </span>
            )}
          </div>

          {dm?.guidance && (
            <div
              className="architect-review__guidance"
              style={{ borderLeftColor: dm.color }}
            >
              {dm.guidance}
            </div>
          )}

          <details className="architect-review__section" open>
            <summary className="architect-review__summary">Tests</summary>
            <ul className="architect-review__list">
              <li>Judge: {fmtTests(judge.tests_passed, judge.tests_failed, judge.tests_total, judge.tests_verified)}</li>
              {dev && (
                <li>
                  Dev self-report: {fmtTests(dev.tests_passed, dev.tests_failed, dev.tests_total, dev.tests_run)}
                </li>
              )}
            </ul>
          </details>

          {judge.key_concern && (
            <details className="architect-review__section">
              <summary className="architect-review__summary">Key concern</summary>
              <p className="architect-review__approach">{judge.key_concern}</p>
            </details>
          )}

          {judge.user_input_needed && (
            <details
              className="architect-review__section"
              open
              style={{ borderLeftColor: "var(--color-warning)" }}
            >
              <summary
                className="architect-review__summary"
                style={{ color: "var(--color-warning)" }}
              >
                Judge requests user input
              </summary>
              <p className="architect-review__approach">
                {judge.key_concern ?? "No specific question supplied."}
              </p>
            </details>
          )}

          <details className="architect-review__section">
            <summary className="architect-review__summary">Reflection opt-out signal</summary>
            <ul className="architect-review__list">
              <li>
                <code>reflection_needed</code>:{" "}
                {judge.reflection_needed === false
                  ? "false (judge vouched for the plan)"
                  : judge.reflection_needed === true
                    ? "true (judge asked for reflection)"
                    : "unset (default — reflection runs)"}
              </li>
              {judge.reflection_reason && (
                <li>
                  <code>reflection_reason</code>: {judge.reflection_reason}
                </li>
              )}
            </ul>
          </details>

          {/* should_continue diverges from determination only on edge cases
              (e.g. STALLED + onStalled policy = continue). Show it in a
              footnote-style section for transparency -- collapsed by default. */}
          <details className="architect-review__section">
            <summary className="architect-review__summary">Decision flags</summary>
            <ul className="architect-review__list">
              <li>
                <code>should_continue</code>:{" "}
                {judge.should_continue ? "true" : "false"}
              </li>
              {meta?.branch && (
                <li>
                  <code>branch</code>: <code>{meta.branch}</code>
                </li>
              )}
            </ul>
          </details>
        </>
      )}

      {dev && (() => {
        const hasBlockers = dev.blockers && dev.blockers.length > 0;
        const needsInput = dev.user_input_needed;
        // Happy path -- no blockers, no user input needed: the section's
        // title already tells the whole story, so skip rendering entirely
        // rather than repeat "No blockers, no user input needed." as a body.
        const isHappy = !hasBlockers && !needsInput;
        if (isHappy) {
          return (
            <div
              className="architect-review__section"
              style={{ color: "var(--color-text-muted)", fontSize: "0.85rem" }}
            >
              Dev self-reported <strong>{dev.self_assessment}</strong> quality ·
              status: <strong>{dev.status}</strong> · no blockers, no user input
              needed.
            </div>
          );
        }
        return (
          <details className="architect-review__section" open={needsInput}>
            <summary className="architect-review__summary">
              Dev self-assessment ({dev.self_assessment}, status: {dev.status})
            </summary>
            <ul className="architect-review__list">
              {hasBlockers && (
                <li>
                  <strong>Blockers:</strong>
                  <ul>
                    {dev.blockers!.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                </li>
              )}
              {needsInput && (
                <li style={{ color: "var(--color-warning)" }}>
                  user_input_needed: true
                  {dev.questions && dev.questions.length > 0 && (
                    <ul>
                      {dev.questions.map((q, i) => (
                        <li key={i}>{q}</li>
                      ))}
                    </ul>
                  )}
                </li>
              )}
            </ul>
          </details>
        );
      })()}
    </div>
  );
}
