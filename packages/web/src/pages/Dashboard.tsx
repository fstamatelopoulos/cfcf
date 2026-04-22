import { usePolling } from "../hooks/usePolling";
import { fetchWorkspaces } from "../api";
import { WorkspaceCard } from "../components/WorkspaceCard";
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
        Workspaces
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
  const { data: workspaces, error, loading } = usePolling(fetchWorkspaces, 5000);

  if (loading && !workspaces) {
    return <div className="dashboard__loading">Loading workspaces...</div>;
  }

  if (error) {
    return <div className="dashboard__error">Error: {error}</div>;
  }

  if (!workspaces || workspaces.length === 0) {
    return (
      <div className="dashboard">
        <DashboardHeader />
        <div className="dashboard__empty">
          <h2>No workspaces</h2>
          <p>Create a workspace with the CLI:</p>
          <code>cfcf workspace init --repo &lt;path&gt; --name &lt;name&gt;</code>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <DashboardHeader />
      <div className="dashboard__grid">
        {workspaces.map((w) => (
          <WorkspaceCard key={w.id} workspace={w} />
        ))}
      </div>
    </div>
  );
}
