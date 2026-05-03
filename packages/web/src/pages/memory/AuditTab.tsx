import { useEffect, useState } from "react";
import { fetchClioAuditLog, type ClioAuditEntry } from "../../api";

const EVENT_TYPES = [
  { value: "", label: "All events" },
  { value: "create", label: "create" },
  { value: "update-content", label: "update-content" },
  { value: "edit-metadata", label: "edit-metadata" },
  { value: "delete", label: "delete" },
  { value: "restore", label: "restore" },
  { value: "migrate-project", label: "migrate-project" },
];

const EVENT_COLOR: Record<string, string> = {
  "create": "var(--color-success)",
  "update-content": "var(--color-info)",
  "edit-metadata": "var(--color-info)",
  "delete": "var(--color-error)",
  "restore": "var(--color-success)",
  "migrate-project": "var(--color-warning)",
};

/**
 * Global Clio audit log viewer (item 6.18). Mirrors `cfcf clio docs
 * audit` with three filter knobs (event type / actor / since /
 * document id) and pagination via "Load more".
 *
 * The API returns at most 100 entries by default; "Load more" appends
 * the next page by bumping a `since` cursor down to the oldest
 * already-loaded timestamp -- not perfectly stable across concurrent
 * writes but adequate for a human-paced inspection tool.
 */
export function AuditTab({ activeProject }: { activeProject: string | null }) {
  const [eventType, setEventType] = useState("");
  const [actor, setActor] = useState("");
  const [since, setSince] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [entries, setEntries] = useState<ClioAuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  // Initial fetch + refetch whenever the filter set changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchClioAuditLog({
      eventType: eventType || undefined,
      actor: actor.trim() || undefined,
      project: activeProject ?? undefined,
      documentId: documentId.trim() || undefined,
      since: since.trim() || undefined,
      limit: 100,
    })
      .then((es) => {
        if (cancelled) return;
        setEntries(es);
        setHasMore(es.length === 100);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [eventType, actor, since, documentId, activeProject]);

  return (
    <section className="memory-search">
      <h3 className="section-title" style={{ margin: "0 0 0.4rem 0", fontSize: "var(--text-md)" }}>
        Audit log
        {activeProject && (
          <span style={{ fontWeight: 400, color: "var(--color-text-muted)", marginLeft: "0.4rem" }}>
            in {activeProject}
          </span>
        )}
      </h3>

      <form
        onSubmit={(e) => e.preventDefault()}
        style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginBottom: "0.85rem" }}
      >
        <select value={eventType} onChange={(e) => setEventType(e.target.value)} title="Filter by event type">
          {EVENT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Actor (e.g. user, claude-code)"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          style={{ minWidth: "12rem" }}
        />
        <input
          type="text"
          placeholder="Document id"
          value={documentId}
          onChange={(e) => setDocumentId(e.target.value)}
          style={{ minWidth: "16rem", fontFamily: "var(--font-mono)" }}
        />
        <input
          type="text"
          placeholder="Since (ISO-8601, e.g. 2026-05-01)"
          value={since}
          onChange={(e) => setSince(e.target.value)}
          style={{ minWidth: "12rem" }}
        />
      </form>

      {error && <div className="form-row__error">{error}</div>}
      {loading && <div className="form-row__hint">loading…</div>}
      {!loading && !error && entries.length === 0 && (
        <div className="form-row__hint">No audit entries match the current filters.</div>
      )}

      {entries.length > 0 && (
        <table className="project-history__table">
          <thead>
            <tr>
              <th style={{ minWidth: "14rem" }}>Time</th>
              <th>Event</th>
              <th>Actor</th>
              <th>Document</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="project-history__row">
                <td className="project-history__time">{e.timestamp}</td>
                <td>
                  <span style={{ color: EVENT_COLOR[e.eventType] ?? "inherit", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}>
                    {e.eventType}
                  </span>
                </td>
                <td>{e.actor ?? "(unknown)"}</td>
                <td>
                  {e.documentId ? (
                    <a
                      href={`#/memory?tab=audit&doc=${encodeURIComponent(e.documentId)}`}
                      onClick={(ev) => {
                        ev.preventDefault();
                        window.location.hash = `/memory?tab=audit&doc=${encodeURIComponent(e.documentId!)}`;
                      }}
                      style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--color-info)", textDecoration: "underline" }}
                    >
                      {e.documentId.slice(0, 8)}…
                    </a>
                  ) : (
                    <span className="form-row__hint">—</span>
                  )}
                </td>
                <td>
                  <code style={{ fontSize: "var(--text-xs)" }}>{summariseAuditMetadata(e.metadata)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {hasMore && (
        <div className="form-row__hint" style={{ marginTop: "0.5rem" }}>
          Showing first 100 entries. Tighten the filters to see further back, or use{" "}
          <code>cfcf clio docs audit --limit 1000</code> for a deeper export.
        </div>
      )}
    </section>
  );
}

function summariseAuditMetadata(m: Record<string, unknown>): string {
  if (!m || typeof m !== "object") return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(m)) {
    if (k === "diff" || k === "before" || k === "after") continue;
    parts.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return parts.join(", ");
}
