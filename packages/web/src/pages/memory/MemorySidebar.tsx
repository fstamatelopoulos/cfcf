import { useEffect, useState } from "react";
import {
  fetchClioStats,
  fetchClioProjects,
  type ClioStats,
  type ClioProject,
} from "../../api";

/**
 * Persistent left rail on every Memory tab (item 6.18). Shows DB stats +
 * a clickable project filter. Selected project is lifted to the parent
 * so each tab can scope its query.
 *
 * Stats are refetched whenever `refreshTick` increments — used by the
 * Ingest tab to refresh counts after a successful ingest.
 */
export function MemorySidebar({
  activeProject,
  onSelectProject,
  refreshTick,
}: {
  activeProject: string | null;
  onSelectProject: (project: string | null) => void;
  refreshTick?: number;
}) {
  const [stats, setStats] = useState<ClioStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ClioProject[]>([]);

  useEffect(() => {
    fetchClioStats()
      .then((s) => { setStats(s); setStatsError(null); })
      .catch((e) => setStatsError(e instanceof Error ? e.message : String(e)));
    fetchClioProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, [refreshTick]);

  return (
    <aside className="memory-page__sidebar">
      <section className="memory-stats">
        <h3 className="section-title" style={{ margin: "0 0 0.4rem 0", fontSize: "var(--text-md)" }}>
          Stats
        </h3>
        {statsError ? (
          <div className="form-row__error">{statsError}</div>
        ) : !stats ? (
          <div className="form-row__hint">loading…</div>
        ) : (
          <dl style={{ margin: 0 }}>
            <Row label="Documents" value={stats.documentCount.toLocaleString()} />
            <Row label="Chunks" value={stats.chunkCount.toLocaleString()} />
            <Row label="Projects" value={stats.projectCount.toLocaleString()} />
            <Row label="DB size" value={formatBytes(stats.dbSizeBytes)} />
            <Row
              label="Embedder"
              value={stats.activeEmbedder ? `${stats.activeEmbedder.name} (dim ${stats.activeEmbedder.dim})` : "(FTS-only)"}
            />
            {stats.dbPath && <Row label="DB location" value={stats.dbPath} />}
          </dl>
        )}
      </section>

      <section className="memory-projects">
        <h3 className="section-title" style={{ margin: "0 0 0.4rem 0", fontSize: "var(--text-md)" }}>
          Projects
        </h3>
        <ul className="memory-projects__list">
          <li
            className={`memory-projects__item ${activeProject === null ? "memory-projects__item--active" : ""}`}
            onClick={() => onSelectProject(null)}
          >
            <span>(all projects)</span>
          </li>
          {projects.map((p) => (
            <li
              key={p.id}
              className={`memory-projects__item ${activeProject === p.name ? "memory-projects__item--active" : ""}`}
              onClick={() => onSelectProject(p.name)}
              title={p.isSystem ? "System-managed Clio Project (cfcf-owned)" : undefined}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                {p.name}
                {p.isSystem && (
                  <span
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--color-info)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    sys
                  </span>
                )}
              </span>
              {p.documentCount !== undefined && (
                <span className="memory-projects__count">{p.documentCount}</span>
              )}
            </li>
          ))}
          {projects.length === 0 && (
            <li className="form-row__hint" style={{ padding: "0.4rem" }}>
              No projects yet. Create one from the <strong>Projects</strong> tab or via <code>cfcf clio projects create &lt;name&gt;</code>.
            </li>
          )}
        </ul>
      </section>
    </aside>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="memory-stats__row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
