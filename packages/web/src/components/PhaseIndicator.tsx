import type { LoopPhase } from "../types";
import { useElapsed } from "../hooks/useElapsed";

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
  startedAt,
  completedAt,
}: {
  agentType: AgentType;
  phase: string;
  /** Optional header text, e.g. "Iteration 2" or "Review run 1" */
  title?: string;
  /**
   * ISO timestamp when the current agent run (iteration / review / document)
   * started. When provided together with a non-terminal phase, a live timer
   * is rendered next to the title.
   */
  startedAt?: string;
  /** Completion timestamp (only used for the paused case to show frozen elapsed). */
  completedAt?: string;
}) {
  const phases =
    agentType === "loop" ? loopPhases : agentType === "review" ? reviewPhases : documentPhases;

  const isTerminal = terminalStates.has(phase);
  const currentIdx = phases.findIndex((x) => x.key === phase);

  // Freeze the timer once the run is in a terminal state, but keep it
  // visible during "paused" so the user sees how long the current iteration
  // has taken so far. Hide entirely for other terminal states (completed /
  // failed / stopped) -- the History tab already shows the final duration.
  const isPaused = phase === "paused";
  const isRunning = !isTerminal;
  const showTimer = (isRunning || isPaused) && !!startedAt;
  const elapsed = useElapsed(startedAt, isRunning, completedAt);

  return (
    <div className="phase-indicator">
      {(title || showTimer) && (
        <div className="phase-indicator__iteration">
          {title}
          {showTimer && elapsed && (
            <>
              <span className="phase-indicator__sep"> · </span>
              <span className="phase-indicator__timer" title="Elapsed time">
                {elapsed}
              </span>
            </>
          )}
        </div>
      )}
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
