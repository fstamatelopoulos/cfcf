import type { LoopIterationRecord } from "../types";
import { JudgeAssessment } from "./JudgeAssessment";

function formatDuration(startedAt: string, completedAt?: string): string {
  if (!completedAt) return "running";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export function IterationHistory({
  iterations,
  onSelectIteration,
}: {
  iterations: LoopIterationRecord[];
  onSelectIteration?: (num: number) => void;
}) {
  if (iterations.length === 0) {
    return <div className="iteration-history__empty">No iterations yet.</div>;
  }

  return (
    <div className="iteration-history">
      <table className="iteration-history__table">
        <thead>
          <tr>
            <th>#</th>
            <th>Duration</th>
            <th>Dev Exit</th>
            <th>Judge</th>
            <th>Merged</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {iterations.map((iter) => (
            <tr key={iter.number} className="iteration-history__row">
              <td className="iteration-history__num">{iter.number}</td>
              <td>{formatDuration(iter.startedAt, iter.completedAt)}</td>
              <td>
                {iter.devExitCode !== undefined ? (
                  <span className={iter.devExitCode === 0 ? "text-success" : "text-error"}>
                    {iter.devExitCode}
                  </span>
                ) : (
                  "..."
                )}
              </td>
              <td>
                {iter.judgeSignals ? (
                  <JudgeAssessment signals={iter.judgeSignals} />
                ) : iter.judgeError ? (
                  <span className="text-error" title={iter.judgeError}>error</span>
                ) : (
                  "..."
                )}
              </td>
              <td>{iter.merged ? "yes" : ""}</td>
              <td>
                {onSelectIteration && (
                  <button
                    className="btn btn--small btn--secondary"
                    onClick={() => onSelectIteration(iter.number)}
                  >
                    logs
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
