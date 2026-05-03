import { useState } from "react";
import { usePolling } from "../hooks/usePolling";
import { fetchWorkspaces } from "../api";
import { WorkspaceCard } from "../components/WorkspaceCard";
import { NewWorkspaceModal } from "../components/NewWorkspaceModal";
import { navigateTo } from "../hooks/useRoute";

function DashboardHeader({ onCreate }: { onCreate: () => void }) {
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
        className="btn btn--small btn--primary"
        onClick={onCreate}
        title="Create a new workspace (mirrors `cfcf workspace init`)"
      >
        + Create workspace
      </button>
    </div>
  );
}

export function Dashboard() {
  const { data: workspaces, error, loading, refresh } = usePolling(fetchWorkspaces, 5000);
  const [createOpen, setCreateOpen] = useState(false);

  if (loading && !workspaces) {
    return <div className="dashboard__loading">Loading workspaces...</div>;
  }

  if (error) {
    return <div className="dashboard__error">Error: {error}</div>;
  }

  const empty = !workspaces || workspaces.length === 0;

  return (
    <div className="dashboard">
      <DashboardHeader onCreate={() => setCreateOpen(true)} />
      {empty ? (
        <div className="dashboard__empty">
          <h2>No workspaces</h2>
          <p>
            Click <strong>+ Create workspace</strong> above, or use the CLI:
          </p>
          <code>cfcf workspace init --repo &lt;path&gt; --name &lt;name&gt;</code>
        </div>
      ) : (
        <div className="dashboard__grid">
          {workspaces.map((w) => (
            <WorkspaceCard key={w.id} workspace={w} />
          ))}
        </div>
      )}
      <NewWorkspaceModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(w) => {
          refresh();
          navigateTo(`/workspaces/${w.id}`);
        }}
      />
    </div>
  );
}
