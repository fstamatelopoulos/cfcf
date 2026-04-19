import type { LoopPhase } from "../types";
import { useElapsed } from "../hooks/useElapsed";

/**
 * Phase indicators for different agent types.
 * Each agent type has its own sequence of phases.
 */

// Labels distinguish deterministic harness steps (cf²) from LLM agent steps
// (agent) so the user can see at a glance which phases are cfcf's plumbing
// vs. an actual agent invocation.
const loopPhases: { key: LoopPhase; label: string }[] = [
  { key: "preparing", label: "Prepare (cf²)" },
  { key: "dev_executing", label: "Dev (agent)" },
  { key: "judging", label: "Judge (agent)" },
  { key: "reflecting", label: "Reflect (agent)" },
  { key: "deciding", label: "Decide (cf²)" },
  { key: "documenting", label: "Document (agent)" },
];

// When `autoReviewSpecs=true` the Solution Architect runs as a pre-loop
// phase before iteration 1. When `autoDocumenter=false` the Documenter
// is skipped. These modifiers are applied in `PhaseIndicator` based on
// the project's config for this loop.
const reviewStep: { key: LoopPhase; label: string } = {
  key: "pre_loop_reviewing",
  label: "Review (agent)",
};

// Review + document runs follow the same cf²/agent split as the loop:
// "Prepare" is cfcf writing instructions + resetting signals, "Execute"
// is the agent process running, "Collect" is cfcf parsing signals back.
const reviewPhases: { key: string; label: string }[] = [
  { key: "preparing", label: "Prepare (cf²)" },
  { key: "executing", label: "Execute (agent)" },
  { key: "collecting", label: "Collect (cf²)" },
];

const documentPhases: { key: string; label: string }[] = [
  { key: "preparing", label: "Prepare (cf²)" },
  { key: "executing", label: "Execute (agent)" },
];

const terminalStates = new Set(["completed", "failed", "stopped", "paused"]);

export type AgentType = "loop" | "review" | "document";

export function PhaseIndicator({
  agentType,
  phase,
  title,
  startedAt,
  completedAt,
  autoReviewSpecs,
  autoDocumenter,
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
  /**
   * When `true`, the loop phase-indicator is prefixed with a leading
   * `Review (agent)` step for the pre-loop Solution Architect. Ignored
   * for `review` / `document` agent types. (item 5.1)
   */
  autoReviewSpecs?: boolean;
  /**
   * When explicitly `false`, the trailing `Document (agent)` step is
   * hidden -- the loop skips the documenter on SUCCESS. Default `true`.
   * (item 5.1)
   */
  autoDocumenter?: boolean;
}) {
  let phases: { key: string; label: string }[];
  if (agentType === "loop") {
    phases = [...loopPhases];
    if (autoReviewSpecs) phases = [reviewStep, ...phases];
    if (autoDocumenter === false) phases = phases.filter((p) => p.key !== "documenting");
  } else if (agentType === "review") {
    phases = reviewPhases;
  } else {
    phases = documentPhases;
  }

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
