import type { ProjectConfig } from "../types";
import { StatusBadge } from "./StatusBadge";
import { navigateTo } from "../hooks/useRoute";

function formatAgent(agent?: { adapter: string; model?: string }): string {
  if (!agent?.adapter) return "n/a";
  return agent.model ? `${agent.adapter}:${agent.model}` : agent.adapter;
}

export function ProjectCard({ project }: { project: ProjectConfig }) {
  return (
    <div
      className="project-card"
      onClick={() => navigateTo(`/projects/${project.id}`)}
    >
      <div className="project-card__header">
        <h3 className="project-card__name">{project.name}</h3>
        <StatusBadge status={project.status} />
      </div>
      <div className="project-card__details">
        <span className="project-card__repo" title={project.repoPath}>
          {project.repoPath}
        </span>
        <span className="project-card__iteration">
          Iteration {project.currentIteration || 0} / {project.maxIterations}
        </span>
      </div>
      <div className="project-card__agents">
        <span>Dev: {formatAgent(project.devAgent)}</span>
        <span>Judge: {formatAgent(project.judgeAgent)}</span>
      </div>
    </div>
  );
}
