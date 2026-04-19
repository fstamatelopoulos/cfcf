import { usePolling } from "../hooks/usePolling";
import { fetchProjects } from "../api";
import { ProjectCard } from "../components/ProjectCard";
import { navigateTo } from "../hooks/useRoute";

function DashboardHeader() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        marginBottom: "1rem",
      }}
    >
      <h2 className="dashboard__title" style={{ margin: 0 }}>
        Projects
      </h2>
      <button
        className="btn btn--small btn--secondary"
        onClick={() => navigateTo("/server")}
        title="View server status and global config"
      >
        server & config →
      </button>
    </div>
  );
}

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
      <div className="dashboard">
        <DashboardHeader />
        <div className="dashboard__empty">
          <h2>No projects</h2>
          <p>Create a project with the CLI:</p>
          <code>cfcf project init --repo &lt;path&gt; --name &lt;name&gt;</code>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <DashboardHeader />
      <div className="dashboard__grid">
        {projects.map((p) => (
          <ProjectCard key={p.id} project={p} />
        ))}
      </div>
    </div>
  );
}
