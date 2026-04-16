import type { LoopPhase } from "../types";

const phases: { key: LoopPhase; label: string }[] = [
  { key: "preparing", label: "Prepare" },
  { key: "dev_executing", label: "Dev" },
  { key: "judging", label: "Judge" },
  { key: "deciding", label: "Decide" },
];

export function PhaseIndicator({
  phase,
  iteration,
}: {
  phase: LoopPhase;
  iteration: number;
}) {
  const isTerminal = ["completed", "failed", "stopped", "paused"].includes(phase);

  return (
    <div className="phase-indicator">
      <div className="phase-indicator__iteration">Iteration {iteration}</div>
      <div className="phase-indicator__steps">
        {phases.map((p) => {
          const isActive = p.key === phase;
          const isPast =
            !isTerminal &&
            phases.findIndex((x) => x.key === phase) >
              phases.findIndex((x) => x.key === p.key);

          return (
            <div
              key={p.key}
              className={`phase-step ${isActive ? "phase-step--active" : ""} ${isPast ? "phase-step--done" : ""}`}
            >
              <div className="phase-step__dot" />
              <span className="phase-step__label">{p.label}</span>
            </div>
          );
        })}
      </div>
      {isTerminal && (
        <div className={`phase-indicator__terminal phase-indicator__terminal--${phase}`}>
          {phase}
        </div>
      )}
    </div>
  );
}
