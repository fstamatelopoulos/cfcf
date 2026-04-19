import type { JudgeSignalsWeb, DevSignalsWeb } from "../types";

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
}: {
  judge: JudgeSignalsWeb | undefined;
  dev: DevSignalsWeb | undefined;
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

  const meta = judge ? determinationMeta[judge.determination] : null;

  return (
    <div className="architect-review architect-review--compact">
      {judge && (
        <>
          <div className="architect-review__header">
            <span className="architect-review__readiness" style={{ color: meta?.color }}>
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

          {meta?.guidance && (
            <div
              className="architect-review__guidance"
              style={{ borderLeftColor: meta.color }}
            >
              {meta.guidance}
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
        </>
      )}

      {dev && (
        <details className="architect-review__section">
          <summary className="architect-review__summary">
            Dev self-assessment ({dev.self_assessment}, status: {dev.status})
          </summary>
          <ul className="architect-review__list">
            {dev.blockers && dev.blockers.length > 0 && (
              <li>
                <strong>Blockers:</strong>
                <ul>
                  {dev.blockers.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              </li>
            )}
            {dev.user_input_needed && (
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
            {(!dev.blockers || dev.blockers.length === 0) && !dev.user_input_needed && (
              <li>No blockers, no user input needed.</li>
            )}
          </ul>
        </details>
      )}
    </div>
  );
}
