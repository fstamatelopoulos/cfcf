import { useEffect, useState } from "react";
import { fetchClioDocuments, type ClioDocument } from "../../api";
import { DeletedBadge } from "./DeletedBadge";

/**
 * Per-project documents list on the Memory page (item 6.18).
 *
 * Rounds 1–3 had two omissions that round-4 (item 6.18 follow-up) closes:
 *   1. The list didn't refresh after a soft-delete from the document
 *      detail overlay; the user had to manually reload the page to see
 *      the doc disappear. Fixed by accepting a `refreshTick` prop the
 *      parent bumps whenever DocumentDetail mutates the corpus
 *      (delete / restore / purge / edit). useEffect re-fetches on tick.
 *   2. No way to surface soft-deleted docs in the list at all. Added a
 *      "Show deleted" toggle that flips the API to `include_deleted=true`
 *      and renders a `(deleted)` badge inline on tombstone rows.
 *
 * Pagination cap of 200 rows per fetch matches the previous 6.12 cap;
 * extending to a real paginator (next/prev) is deferred until corpora
 * grow past that.
 */
export function BrowseTab({
  project,
  onSelect,
  refreshTick = 0,
}: {
  project: string | null;
  onSelect: (id: string) => void;
  /**
   * Bumped by the Memory page whenever a document mutation lands so this
   * tab re-fetches its listing. Unsaved local edits don't apply here
   * (BrowseTab is read-only) — ticking unconditionally is fine.
   */
  refreshTick?: number;
}) {
  const [docs, setDocs] = useState<ClioDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchClioDocuments({
      project: project ?? undefined,
      limit: 200,
      includeDeleted: showDeleted,
    })
      .then(setDocs)
      .catch((e) => { setDocs([]); setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => setLoading(false));
  }, [project, showDeleted, refreshTick]);

  return (
    <section className="memory-docs">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.4rem" }}>
        <h3 className="section-title" style={{ margin: 0, fontSize: "var(--text-md)" }}>
          Documents
          {project && (
            <span style={{ fontWeight: 400, color: "var(--color-text-muted)", marginLeft: "0.4rem" }}>
              in {project}
            </span>
          )}
        </h3>
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.4rem",
            fontSize: "var(--text-sm)",
            color: "var(--color-text-muted)",
            cursor: "pointer",
          }}
          title="When on, soft-deleted docs are listed alongside live ones with a (deleted) badge. Default off, matching agent / search behaviour."
        >
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(e) => setShowDeleted(e.target.checked)}
          />
          Show deleted
        </label>
      </div>
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
              <div className="memory-docs__title">
                {d.title}
                {d.deletedAt && <DeletedBadge deletedAt={d.deletedAt} />}
              </div>
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
