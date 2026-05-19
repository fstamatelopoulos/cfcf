import type { WorkspaceStatus, LoopPhase } from "../types";

type BadgeStatus = WorkspaceStatus | LoopPhase;

const statusColors: Record<string, string> = {
  idle: "var(--color-muted)",
  running: "var(--color-info)",
  preparing: "var(--color-info)",
  dev_executing: "var(--color-info)",
  judging: "var(--color-info)",
  deciding: "var(--color-info)",
  documenting: "var(--color-info)",
  paused: "var(--color-warning)",
  completed: "var(--color-success)",
  failed: "var(--color-error)",
  stopped: "var(--color-muted)",
};

const statusLabels: Record<string, string> = {
  // v0.24.5: "idle" covers both the fresh-workspace case ("ready"
  // to run for first time) AND the post-terminal case ("iterating"
  // between loops after running standalone SA). Single label
  // captures both intents without extra derive-from-history logic.
  // See architect-runner.ts:flipTerminalStatusToIdle for the
  // explicit-trigger transition.
  idle: "ready/iterating",
  dev_executing: "dev running",
  documenting: "documenting",
  user_input_needed: "needs input",
};

export function StatusBadge({ status }: { status?: BadgeStatus }) {
  const s = status || "idle";
  const color = statusColors[s] || "var(--color-muted)";
  const label = statusLabels[s] || s;

  return (
    <span className="status-badge" style={{ backgroundColor: color }}>
      {label}
    </span>
  );
}
