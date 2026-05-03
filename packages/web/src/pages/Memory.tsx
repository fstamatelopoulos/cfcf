import { useEffect, useState } from "react";
import {
  fetchClioStats,
  fetchClioProjects,
  fetchClioDocuments,
  fetchClioDocumentContent,
  searchClio,
  type ClioStats,
  type ClioProject,
  type ClioDocument,
  type ClioDocumentContent,
  type ClioDocumentSearchHit,
  type ClioSearchMode,
} from "../api";

/**
 * Clio "Memory" page — item 6.12 prototype. Read-only browse + search
 * across the local Clio store. Item 6.18 will refine into a fuller
 * editorial surface (document edit / restore / version history /
 * embedder install / audit / metadata search), so the structure here
 * stays minimal: a stats panel, a projects sidebar, a search box, a
 * documents list, and a single-doc viewer.
 */
export function MemoryPage() {
  const [stats, setStats] = useState<ClioStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ClioProject[]>([]);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [docs, setDocs] = useState<ClioDocument[]>([]);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [docsLoading, setDocsLoading] = useState(false);
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const [activeDocContent, setActiveDocContent] = useState<ClioDocumentContent | null>(null);
  const [docContentError, setDocContentError] = useState<string | null>(null);

  // Load stats + projects on mount.
  useEffect(() => {
    fetchClioStats()
      .then((s) => { setStats(s); setStatsError(null); })
      .catch((e) => setStatsError(e instanceof Error ? e.message : String(e)));
    fetchClioProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, []);

  // Reload documents whenever the active project changes.
  useEffect(() => {
    setDocsLoading(true);
    setDocsError(null);
    fetchClioDocuments({ project: activeProject ?? undefined, limit: 200 })
      .then((d) => { setDocs(d); setActiveDocId(null); setActiveDocContent(null); })
      .catch((e) => { setDocs([]); setDocsError(e instanceof Error ? e.message : String(e)); })
      .finally(() => setDocsLoading(false));
  }, [activeProject]);

  // Load doc content lazily when a row is selected.
  useEffect(() => {
    if (!activeDocId) { setActiveDocContent(null); return; }
    setDocContentError(null);
    fetchClioDocumentContent(activeDocId)
      .then(setActiveDocContent)
      .catch((e) => setDocContentError(e instanceof Error ? e.message : String(e)));
  }, [activeDocId]);

  return (
    <div>
      <div style={{ marginBottom: "1rem" }}>
        <h2 style={{ margin: 0 }}>Memory</h2>
        <p style={{ marginTop: "0.25rem", marginBottom: 0, fontSize: "var(--text-sm)", color: "var(--color-text-muted)" }}>
          Browse + search Clio, the cross-workspace knowledge layer.
          Item 6.18 will add editing, version history, and admin tools.
        </p>
      </div>

      <div className="memory-page">
        <aside className="memory-page__sidebar">
          <StatsPanel stats={stats} error={statsError} />
          <ProjectsPanel
            projects={projects}
            activeProject={activeProject}
            onSelect={(p) => setActiveProject(p)}
          />
        </aside>

        <main className="memory-page__main">
          <SearchPanel
            activeProject={activeProject}
            onOpenDoc={(id) => setActiveDocId(id)}
          />
          <DocumentsPanel
            project={activeProject}
            docs={docs}
            loading={docsLoading}
            error={docsError}
            activeDocId={activeDocId}
            onSelect={setActiveDocId}
          />
          {activeDocId && (
            <DocViewer
              content={activeDocContent}
              error={docContentError}
              onClose={() => setActiveDocId(null)}
            />
          )}
        </main>
      </div>
    </div>
  );
}

// ── Stats ──────────────────────────────────────────────────────────────

function StatsPanel({ stats, error }: { stats: ClioStats | null; error: string | null }) {
  return (
    <section className="memory-stats">
      <h3 style={{ margin: "0 0 0.4rem 0", fontSize: "var(--text-md)" }}>Stats</h3>
      {error ? (
        <div className="form-row__error">{error}</div>
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
        </dl>
      )}
      {stats?.dbPath && (
        <div className="form-row__hint" style={{ marginTop: "0.4rem", wordBreak: "break-all" }}>
          {stats.dbPath}
        </div>
      )}
    </section>
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

// ── Projects ───────────────────────────────────────────────────────────

function ProjectsPanel({
  projects,
  activeProject,
  onSelect,
}: {
  projects: ClioProject[];
  activeProject: string | null;
  onSelect: (project: string | null) => void;
}) {
  return (
    <section className="memory-projects">
      <h3 style={{ margin: "0 0 0.4rem 0", fontSize: "var(--text-md)" }}>Projects</h3>
      <ul className="memory-projects__list">
        <li
          className={`memory-projects__item ${activeProject === null ? "memory-projects__item--active" : ""}`}
          onClick={() => onSelect(null)}
        >
          <span>(all projects)</span>
        </li>
        {projects.map((p) => (
          <li
            key={p.id}
            className={`memory-projects__item ${activeProject === p.name ? "memory-projects__item--active" : ""}`}
            onClick={() => onSelect(p.name)}
          >
            <span>{p.name}</span>
            {p.documentCount !== undefined && (
              <span className="memory-projects__count">{p.documentCount}</span>
            )}
          </li>
        ))}
        {projects.length === 0 && (
          <li className="form-row__hint" style={{ padding: "0.4rem" }}>
            No projects yet. Ingest a workspace's first iteration to bootstrap one, or run <code>cfcf clio projects create &lt;name&gt;</code>.
          </li>
        )}
      </ul>
    </section>
  );
}

// ── Search ─────────────────────────────────────────────────────────────

function SearchPanel({
  activeProject,
  onOpenDoc,
}: {
  activeProject: string | null;
  onOpenDoc: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<ClioSearchMode>("auto");
  const [hits, setHits] = useState<ClioDocumentSearchHit[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolvedMode, setResolvedMode] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setRunning(true);
    setError(null);
    try {
      const res = await searchClio(query.trim(), { mode, project: activeProject ?? undefined, matchCount: 20 });
      setHits(res.hits);
      setResolvedMode(res.mode);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setHits([]);
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="memory-search">
      <h3 style={{ margin: "0 0 0.4rem 0", fontSize: "var(--text-md)" }}>
        Search {activeProject && <span style={{ fontWeight: 400, color: "var(--color-text-muted)" }}>in {activeProject}</span>}
      </h3>
      <form className="memory-search__form" onSubmit={submit}>
        <input
          type="text"
          placeholder="Query… (e.g. iteration loop, judge verdict)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={mode} onChange={(e) => setMode(e.target.value as ClioSearchMode)} title="Search mode">
          <option value="auto">auto</option>
          <option value="fts">fts</option>
          <option value="semantic">semantic</option>
          <option value="hybrid">hybrid</option>
        </select>
        <button type="submit" className="btn btn--primary btn--small" disabled={running || !query.trim()}>
          {running ? "…" : "Search"}
        </button>
      </form>
      {resolvedMode && hits.length === 0 && !running && !error && query && (
        <div className="form-row__hint">No hits for "{query}" in <code>{resolvedMode}</code> mode.</div>
      )}
      {error && <div className="form-row__error">{error}</div>}
      {hits.length > 0 && (
        <>
          <div className="form-row__hint" style={{ marginBottom: "0.4rem" }}>
            {hits.length} hit{hits.length === 1 ? "" : "s"} via <code>{resolvedMode}</code>
          </div>
          <div className="memory-search__hits">
            {hits.map((h) => (
              <div key={h.documentId} className="memory-search__hit" onClick={() => onOpenDoc(h.documentId)}>
                <div className="memory-search__hit-meta">
                  <span><strong>{h.docTitle}</strong> — {h.docProjectName}</span>
                  <span>score {h.bestScore.toFixed(3)}</span>
                </div>
                {h.bestChunkHeadingPath.length > 0 && (
                  <div className="form-row__hint" style={{ marginBottom: "0.25rem" }}>
                    {h.bestChunkHeadingPath.join(" › ")}
                  </div>
                )}
                <div className="memory-search__hit-snippet">{truncate(h.bestChunkContent, 600)}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

// ── Documents list ─────────────────────────────────────────────────────

function DocumentsPanel({
  project,
  docs,
  loading,
  error,
  activeDocId,
  onSelect,
}: {
  project: string | null;
  docs: ClioDocument[];
  loading: boolean;
  error: string | null;
  activeDocId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="memory-docs">
      <h3 style={{ margin: "0 0 0.4rem 0", fontSize: "var(--text-md)" }}>
        Documents {project && <span style={{ fontWeight: 400, color: "var(--color-text-muted)" }}>in {project}</span>}
      </h3>
      {loading && <div className="form-row__hint">loading…</div>}
      {error && <div className="form-row__error">{error}</div>}
      {!loading && !error && docs.length === 0 && (
        <div className="form-row__hint">No documents{project ? ` in ${project}` : ""}.</div>
      )}
      {docs.length > 0 && (
        <ul className="memory-docs__list">
          {docs.map((d) => (
            <li
              key={d.id}
              className={`memory-docs__item ${activeDocId === d.id ? "memory-docs__item--active" : ""}`}
              onClick={() => onSelect(d.id)}
            >
              <div className="memory-docs__title">{d.title}</div>
              <div className="memory-docs__meta">
                {d.projectName ?? "(unknown project)"} · {d.author} · {d.chunkCount} chunk{d.chunkCount === 1 ? "" : "s"} · {d.totalChars.toLocaleString()} chars · {formatRelativeTime(d.updatedAt)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatRelativeTime(iso?: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const sec = (Date.now() - t) / 1000;
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400)}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

// ── Document viewer ────────────────────────────────────────────────────

function DocViewer({
  content,
  error,
  onClose,
}: {
  content: ClioDocumentContent | null;
  error: string | null;
  onClose: () => void;
}) {
  return (
    <section className="memory-doc-viewer">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <h3 style={{ margin: "0 0 0.4rem 0", fontSize: "var(--text-md)" }}>
          {content?.document.title ?? "loading…"}
        </h3>
        <button className="btn btn--small btn--secondary" onClick={onClose}>Close</button>
      </div>
      {error && <div className="form-row__error">{error}</div>}
      {content && (
        <>
          <div className="memory-doc-viewer__meta">
            {content.document.projectName ?? "(unknown project)"} · {content.document.author} ·{" "}
            {content.chunkCount} chunk{content.chunkCount === 1 ? "" : "s"} · {content.totalChars.toLocaleString()} chars
          </div>
          <pre className="memory-doc-viewer__content">{content.content}</pre>
        </>
      )}
    </section>
  );
}
