import { Header } from "./components/Header";
import { Dashboard } from "./pages/Dashboard";
import { WorkspaceDetail } from "./pages/WorkspaceDetail";
import { ServerInfo } from "./pages/ServerInfo";
import { HelpPage } from "./pages/Help";
import { useRoute } from "./hooks/useRoute";

export function App() {
  const route = useRoute();

  return (
    <div className="app">
      <Header />
      <main className="app__content">
        {route.page === "workspace" && route.workspaceId ? (
          <WorkspaceDetail workspaceId={route.workspaceId} />
        ) : route.page === "server" ? (
          <ServerInfo />
        ) : route.page === "help" ? (
          <HelpPage />
        ) : (
          <Dashboard />
        )}
      </main>
    </div>
  );
}
