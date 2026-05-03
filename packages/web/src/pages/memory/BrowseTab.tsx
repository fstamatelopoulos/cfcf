import { useEffect, useState } from "react";
import { fetchClioDocuments, type ClioDocument } from "../../api";

/**
 * Per-project documents list on the Memory page (item 6.18). Click a
 * row opens the Document detail overlay (handled by the parent via
 * onSelect).
 *
 * Pagination cap of 200 rows per fetch matches the previous 6.12 cap;
 * extending to a real paginator (next/prev) is deferred until corpora
 * grow past that.
 */
export function BrowseTab({
  project,
  onSelect,
}: {
  project: string | null;
  onSelect: (id: string) => void;
}) {
  const [docs, setDocs] = useState<ClioDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchClioDocuments({ project: project ?? undefined, limit: 200 })
      .then(setDocs)
      .catch((e) => { setDocs([]); setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => setLoading(false));
  }, [project]);

  return (
    <section className="memory-docs">
      <h3 className="section-title" style={{ margin: "0 0 0.4rem 0", fontSize: "var(--text-md)" }}>
        Documents
        {project && (
          <span style={{ fontWeight: 400, color: "var(--color-text-muted)", marginLeft: "0.4rem" }}>
            in {project}
          </span>
        )}
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
              className="memory-docs__item"
              onClick={() => onSelect(d.id)}
            >
              <div className="memory-docs__title">{d.title}</div>
              <div className="memory-docs__meta">
                {d.projectName ?? "(unknown project)"} · {d.author} · {d.chunkCount} chunk{d.chunkCount === 1 ? "" : "s"} · {d.totalChars.toLocaleString()} chars
                {d.versionCount && d.versionCount > 0 ? ` · ${d.versionCount} version${d.versionCount === 1 ? "" : "s"}` : ""} · {formatRelativeTime(d.updatedAt)}
              </div>
            </li>
          ))}
        </ul>
      )}
      {docs.length === 200 && (
        <div className="form-row__hint" style={{ marginTop: "0.5rem" }}>
          Showing first 200 documents. Pagination beyond this cap is deferred until corpora grow.
        </div>
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
