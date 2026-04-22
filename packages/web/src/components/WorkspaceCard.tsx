import type { WorkspaceConfig } from "../types";
import { StatusBadge } from "./StatusBadge";
import { navigateTo } from "../hooks/useRoute";

function formatAgent(agent?: { adapter: string; model?: string }): string {
  if (!agent?.adapter) return "n/a";
  return agent.model ? `${agent.adapter}:${agent.model}` : agent.adapter;
}

export function WorkspaceCard({ workspace }: { workspace: WorkspaceConfig }) {
  return (
    <div
      className="project-card"
      onClick={() => navigateTo(`/workspaces/${workspace.id}`)}
    >
      <div className="project-card__header">
        <h3 className="project-card__name">{workspace.name}</h3>
        <StatusBadge status={workspace.status} />
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
