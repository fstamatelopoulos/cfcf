import { usePolling } from "../hooks/usePolling";
import { fetchProjects } from "../api";
import { ProjectCard } from "../components/ProjectCard";

export function Dashboard() {
  const { data: projects, error, loading } = usePolling(fetchProjects, 5000);

  if (loading && !projects) {
    return <div className="dashboard__loading">Loading projects...</div>;
  }

  if (error) {
    return <div className="dashboard__error">Error: {error}</div>;
  }

  if (!projects || projects.length === 0) {
    return (
      <div className="dashboard__empty">
        <h2>No projects</h2>
        <p>Create a project with the CLI:</p>
        <code>cfcf project init --repo &lt;path&gt; --name &lt;name&gt;</code>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <h2 className="dashboard__title">Projects</h2>
      <div className="dashboard__grid">
        {projects.map((p) => (
          <ProjectCard key={p.id} project={p} />
        ))}
      </div>
    </div>
  );
}
