import { Header } from "./components/Header";
import { Dashboard } from "./pages/Dashboard";
import { ProjectDetail } from "./pages/ProjectDetail";
import { useRoute } from "./hooks/useRoute";

export function App() {
  const route = useRoute();

  return (
    <div className="app">
      <Header />
      <main className="app__content">
        {route.page === "project" && route.projectId ? (
          <ProjectDetail projectId={route.projectId} />
        ) : (
          <Dashboard />
        )}
      </main>
    </div>
  );
}
