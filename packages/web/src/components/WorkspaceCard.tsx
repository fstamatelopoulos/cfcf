import type { WorkspaceConfig } from "../types";
import { StatusBadge } from "./StatusBadge";
import { navigateTo } from "../hooks/useRoute";

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
  return (
    <div
      className="project-card"
      onClick={() => navigateTo(`/workspaces/${workspace.id}`)}
    >
      <div className="project-card__header">
        <h3 className="project-card__name">{workspace.name}</h3>
        <div className="project-card__status-group">
          <StatusBadge status={workspace.status} />
          {activeLabel && (
            <span
              className="project-card__active-chip"
              title="An agent is actively running on this workspace right now (F.22)"
            >
              ● {activeLabel}
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
      </div>
      <div className="project-card__details">
        <span className="project-card__repo" title={workspace.repoPath}>
          {workspace.repoPath}
        </span>
        <span className="project-card__iteration">
          Iteration {workspace.currentIteration || 0} / {workspace.maxIterations}
        </span>
      </div>
      <div className="project-card__agents">
        <span>Dev: {formatAgent(workspace.devAgent)}</span>
        <span>Judge: {formatAgent(workspace.judgeAgent)}</span>
      </div>
    </div>
  );
}
