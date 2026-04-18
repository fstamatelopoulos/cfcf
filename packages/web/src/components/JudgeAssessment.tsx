import type { JudgeSignals } from "../types";

const qualityColor = (score: number): string => {
  if (score >= 8) return "var(--color-success)";
  if (score >= 5) return "var(--color-warning)";
  return "var(--color-error)";
};

const determinationColor: Record<string, string> = {
  SUCCESS: "var(--color-success)",
  PROGRESS: "var(--color-info)",
  STALLED: "var(--color-warning)",
  ANOMALY: "var(--color-error)",
};

export function JudgeAssessment({ signals }: { signals: JudgeSignals }) {
  return (
    <div className="judge-assessment">
      <div className="judge-assessment__header">
        <span
          className="judge-assessment__determination"
          style={{ color: determinationColor[signals.determination] }}
        >
          {signals.determination}
        </span>
        <span
          className="judge-assessment__quality"
          style={{ color: qualityColor(signals.quality_score) }}
        >
          {signals.quality_score}/10
        </span>
      </div>
      {signals.tests_verified && signals.tests_total !== undefined && (
        <div className="judge-assessment__tests">
          Tests: {signals.tests_passed}/{signals.tests_total} passed
          {signals.tests_failed ? `, ${signals.tests_failed} failed` : ""}
        </div>
      )}
      {signals.key_concern && (
        <div className="judge-assessment__concern">
          {signals.key_concern}
        </div>
      )}
    </div>
  );
}
