import { useEffect, useState } from "react";
import {
  fetchClioDocuments,
  restoreClioDocument,
  purgeClioDocument,
  type ClioDocument,
} from "../../api";

/**
 * Trash bin tab for the Memory page (item 6.18 round-4). Mirrors
 * Cerefox's `/trash` page: lists soft-deleted documents with per-row
 * Restore + Purge actions. Cerefox parity at the surface level
 * (`?deleted_only=true` listing, `POST /restore`, `POST /purge`).
 *
 * Why a dedicated tab rather than just a "Show deleted" toggle on
 * Browse: deleted docs need their own action affordances (Restore,
 * Purge — neither of which makes sense on live docs), and grouping
 * them on a separate surface matches the trash-bin mental model
 * users carry from every other product. Browse's "Show deleted"
 * toggle stays for the side-by-side view.
 *
 * Refresh model: keys off `refreshTick` from the Memory page (same
 * tick that drives the sidebar stats), so other tabs' mutations
 * propagate; bumps it via `onChanged` after restore / purge so the
 * sidebar count stays in sync.
 *
 * Purge UX: row-level confirm via `window.confirm` rather than a
 * full-screen dialog. Justified by (a) the action is already gated
 * to soft-deleted docs (the user has expressed intent twice — they
 * already deleted it, then opened the trash), (b) per-row action
 * load makes a per-row dialog overkill, (c) Cerefox does the same.
 */
export function TrashTab({
  project,
  onSelect,
  refreshTick = 0,
  onChanged,
}: {
  project: string | null;
  onSelect: (id: string) => void;
  refreshTick?: number;
  onChanged: () => void;
}) {
  const [docs, setDocs] = useState<ClioDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchClioDocuments({
      project: project ?? undefined,
      limit: 200,
      deletedOnly: true,
    })
      .then(setDocs)
      .catch((e) => { setDocs([]); setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => setLoading(false));
  }, [project, refreshTick]);

  async function handleRestore(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await restoreClioDocument(id);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function handlePurge(id: string, title: string) {
    if (!window.confirm(
      `Permanently delete "${title}"?\n\n` +
      `This cannot be undone. Chunks + version history will be lost. ` +
      `An audit-log entry recording the purge will remain.`,
    )) return;
    setBusyId(id);
    setError(null);
    try {
      await purgeClioDocument(id);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="memory-docs">
      <h3 className="section-title" style={{ margin: "0 0 0.4rem 0", fontSize: "var(--text-md)" }}>
        Trash
        {project && (
          <span style={{ fontWeight: 400, color: "var(--color-text-muted)", marginLeft: "0.4rem" }}>
            in {project}
          </span>
        )}
      </h3>
      <p style={{ marginTop: 0, marginBottom: "0.75rem", fontSize: "var(--text-sm)", color: "var(--color-text-muted)" }}>
        Soft-deleted documents. Restore moves a doc back to the live set;
        Purge deletes it permanently (chunks + versions removed,
        audit-log entry retained).
      </p>
      {loading && <div className="form-row__hint">loading…</div>}
      {error && <div className="form-row__error">{error}</div>}
      {!loading && !error && docs.length === 0 && (
        <div className="form-row__hint">Trash is empty{project ? ` in ${project}` : ""}.</div>
      )}
      {docs.length > 0 && (
        <table className="project-history__table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Project</th>
              <th>Author</th>
              <th>Deleted</th>
              <th style={{ width: "12rem" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id} className="project-history__row">
                <td>
                  <button
                    type="button"
                    onClick={() => onSelect(d.id)}
                    style={{
                      background: "none",
                      border: "none",
                      padding: 0,
                      color: "var(--color-link, currentColor)",
                      cursor: "pointer",
                      textDecoration: "underline",
                      font: "inherit",
                      textAlign: "left",
                    }}
                  >
                    {d.title}
                  </button>
                </td>
                <td>{d.projectName ?? "(unknown)"}</td>
                <td>{d.author}</td>
                <td className="project-history__time">{d.deletedAt ?? ""}</td>
                <td>
                  <div style={{ display: "flex", gap: "0.4rem" }}>
                    <button
                      className="btn btn--small btn--secondary"
                      disabled={busyId === d.id}
                      onClick={() => handleRestore(d.id)}
                      title="Restore this document to the live set"
                    >
                      {busyId === d.id ? "…" : "Restore"}
                    </button>
                    <button
                      className="btn btn--small btn--danger"
                      disabled={busyId === d.id}
                      onClick={() => handlePurge(d.id, d.title)}
                      title="Permanently delete (cannot be undone)"
                    >
                      {busyId === d.id ? "…" : "Purge…"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
