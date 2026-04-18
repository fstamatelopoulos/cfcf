import type { ProjectConfig } from "../types";

function formatAgent(agent?: { adapter: string; model?: string }): string {
  if (!agent?.adapter) return "(not configured)";
  return agent.model ? `${agent.adapter}:${agent.model}` : `${agent.adapter}:default`;
}

export function ConfigDisplay({ project }: { project: ProjectConfig }) {
  return (
    <div className="config-display">
      <table className="config-display__table">
        <tbody>
          <tr>
            <th>Project ID</th>
            <td>{project.id}</td>
          </tr>
          <tr>
            <th>Repository</th>
            <td className="config-display__path">{project.repoPath}</td>
          </tr>
          {project.repoUrl && (
            <tr>
              <th>Remote</th>
              <td>{project.repoUrl}</td>
            </tr>
          )}
          <tr>
            <th>Dev Agent</th>
            <td>{formatAgent(project.devAgent)}</td>
          </tr>
          <tr>
            <th>Judge Agent</th>
            <td>{formatAgent(project.judgeAgent)}</td>
          </tr>
          <tr>
            <th>Architect</th>
            <td>{formatAgent(project.architectAgent)}</td>
          </tr>
          <tr>
            <th>Documenter</th>
            <td>{formatAgent(project.documenterAgent)}</td>
          </tr>
          <tr>
            <th>Max Iterations</th>
            <td>{project.maxIterations}</td>
          </tr>
          <tr>
            <th>Pause Every</th>
            <td>{project.pauseEvery === 0 ? "never" : `${project.pauseEvery} iterations`}</td>
          </tr>
          <tr>
            <th>On Stalled</th>
            <td>{project.onStalled}</td>
          </tr>
          <tr>
            <th>Merge Strategy</th>
            <td>{project.mergeStrategy}</td>
          </tr>
          <tr>
            <th>Iterations Completed</th>
            <td>{project.currentIteration || 0}</td>
          </tr>
          {project.notifications && (
            <tr>
              <th>Notifications</th>
              <td>
                {project.notifications.enabled ? "enabled (project override)" : "disabled (project override)"}
              </td>
            </tr>
          )}
          {!project.notifications && (
            <tr>
              <th>Notifications</th>
              <td style={{ color: "var(--color-text-muted)", fontStyle: "italic" }}>
                inheriting from global config
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
