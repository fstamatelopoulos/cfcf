import type { WorkspaceConfig } from "../types";
import { StatusBadge } from "./StatusBadge";
import { navigateTo } from "../hooks/useRoute";
import { useElapsed } from "../hooks/useElapsed";

function formatAgent(agent?: { adapter: string; model?: string }): string {
  if (!agent?.adapter) return "n/a";
  return agent.model ? `${agent.adapter}:${agent.model}` : agent.adapter;
}

/**
 * Map the server-computed `activeAgent` to a user-visible chip label.
 * F.22 (v0.24.0): standalone Review / Document / Reflect runs don't
 * touch `workspace.status`, so the StatusBadge alone misses them. The
 * card surfaces a secondary chip when an agent is actively running.
 */
function activeAgentLabel(activeAgent: WorkspaceConfig["activeAgent"]): string | null {
  switch (activeAgent) {
    case "loop":     return "loop running";
    case "review":   return "review running";
    case "document": return "document running";
    case "reflect":  return "reflect running";
    default:         return null;
  }
}

export function WorkspaceCard({ workspace }: { workspace: WorkspaceConfig }) {
  const activeLabel = activeAgentLabel(workspace.activeAgent);
  // v0.24.5: independent chip for PA-session liveness. PA runs
  // outside the cfcf server (interactive `cfcf spec`), so it's
  // tracked separately from F.22's activeAgent and can coexist
  // with it on the card.
  const pa = workspace.paSession;
  const paTooltip = pa
    ? `PA session ${pa.sessionId} alive since ${new Date(pa.startedAt).toLocaleString()} (launcher PID ${pa.launcherPid})`
    : "";

  // v0.24.5 follow-up: live elapsed timer for the running loop.
  // Mirrors the workspace-detail PhaseIndicator's timer so the
  // dashboard answers "how long has this loop been alive?" without
  // a click-through. Returns null when not running — the timer span
  // is conditionally rendered.
  const loopElapsed = useElapsed(
    workspace.loopStartedAt ?? undefined,
    workspace.activeAgent === "loop",
  );

  return (
    <div
      className="project-card"
      onClick={() => navigateTo(`/workspaces/${workspace.id}`)}
    >
      {/* v0.24.5 layout change: chips moved BELOW the title+badge
          row. With two possible chips (loop + PA) coexisting, the
          original single-row header got crowded. Two-row layout
          gives each chip room to breathe. */}
      <div className="project-card__header">
        <h3 className="project-card__name">{workspace.name}</h3>
        <div className="project-card__status-group">
          <StatusBadge status={workspace.status} />
        </div>
      </div>
      {(activeLabel || pa) && (
        <div
          className="project-card__chips"
          style={{
            display: "flex",
            gap: "0.5rem",
            flexWrap: "wrap",
            margin: "0.25rem 0 0.5rem 0",
          }}
        >
          {activeLabel && (
            <span
              className="project-card__active-chip"
              title={
                workspace.activeAgent === "loop" && loopElapsed
                  ? `Loop has been running for ${loopElapsed}`
                  : "An agent is actively running on this workspace right now (F.22)"
              }
            >
              ● {activeLabel}
              {workspace.activeAgent === "loop" && loopElapsed && (
                <span style={{ marginLeft: "0.4rem", opacity: 0.75 }}>
                  · {loopElapsed}
                </span>
              )}
            </span>
          )}
          {pa && (
            <span
              className="project-card__active-chip"
              title={paTooltip}
              style={{
                // Distinct from the loop chip — interactive agents
                // get a different accent so two coexisting chips
                // are visually separable at a glance.
                color: "var(--color-accent, var(--color-info))",
                borderColor: "color-mix(in srgb, var(--color-accent, var(--color-info)) 40%, transparent)",
              }}
            >
              ● PA active
            </span>
          )}
        </div>
      )}
      <div className="project-card__details">
        <span className="project-card__repo" title={workspace.repoPath}>
          {workspace.repoPath}
        </span>
        <span className="project-card__iteration">
          Iteration {workspace.currentIteration || 0} / {workspace.maxIterations}
        </span>
      </div>
      {/* v0.24.5: agents row extended with Reflect (per-workspace,
          previously only visible deep in Config tab). PA is NOT
          shown here because it's a global config — would be
          identical on every card. Architect + Documenter omitted
          for now to keep the row scannable; can be added if
          dogfood shows they're useful at a glance. */}
      <div className="project-card__agents">
        <span>Dev: {formatAgent(workspace.devAgent)}</span>
        <span>Judge: {formatAgent(workspace.judgeAgent)}</span>
        {workspace.reflectionAgent && (
          <span>Reflect: {formatAgent(workspace.reflectionAgent)}</span>
        )}
      </div>
    </div>
  );
}
