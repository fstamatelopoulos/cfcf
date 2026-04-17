import type { LoopPhase } from "../types";

/**
 * Phase indicators for different agent types.
 * Each agent type has its own sequence of phases.
 */

const loopPhases: { key: LoopPhase; label: string }[] = [
  { key: "preparing", label: "Prepare" },
  { key: "dev_executing", label: "Dev" },
  { key: "judging", label: "Judge" },
  { key: "deciding", label: "Decide" },
  { key: "documenting", label: "Document" },
];

const reviewPhases: { key: string; label: string }[] = [
  { key: "preparing", label: "Prepare" },
  { key: "executing", label: "Executing" },
  { key: "collecting", label: "Collecting" },
];

const documentPhases: { key: string; label: string }[] = [
  { key: "preparing", label: "Prepare" },
  { key: "executing", label: "Executing" },
];

const terminalStates = new Set(["completed", "failed", "stopped", "paused"]);

export type AgentType = "loop" | "review" | "document";

export function PhaseIndicator({
  agentType,
  phase,
  title,
}: {
  agentType: AgentType;
  phase: string;
  /** Optional header text, e.g. "Iteration 2" or "Review run 1" */
  title?: string;
}) {
  const phases =
    agentType === "loop" ? loopPhases : agentType === "review" ? reviewPhases : documentPhases;

  const isTerminal = terminalStates.has(phase);
  const currentIdx = phases.findIndex((x) => x.key === phase);

  return (
    <div className="phase-indicator">
      {title && <div className="phase-indicator__iteration">{title}</div>}
      <div className="phase-indicator__steps">
        {phases.map((p, i) => {
          const isActive = p.key === phase;
          const isPast = !isTerminal && currentIdx > i;

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
