import { useEffect, useState } from "react";
import {
  deleteClioDocument,
  fetchClioAuditLog,
  fetchClioDocumentContent,
  fetchClioDocumentVersions,
  purgeClioDocument,
  restoreClioDocument,
  type ClioAuditEntry,
  type ClioDocumentContent,
  type ClioDocumentVersion,
} from "../../api";
import { Modal } from "../../components/Modal";
import { EditDocumentDialog } from "./EditDocumentDialog";

/**
 * Document detail overlay (item 6.18). Replaces the bare doc viewer
 * from 6.12 with a fuller picture: header (title / project / author /
 * timestamps / counts / version count / soft-delete banner), metadata
 * key-value table, version history list (newest-first), audit trail
 * scoped to this doc, full content body, and Delete + Restore action
 * buttons.
 *
 * Edit (title/content/metadata) deferred -- the metadata-edit path
 * exists via `cfcf clio docs edit`, and content edit is well-served
 * by re-ingesting with `updateIfExists` from the Ingest tab.
 *
 * Sections render lazily on accordion open to avoid loading versions
 * + audit log for docs the user just glances at.
 */
export function DocumentDetail({
  documentId,
  onClose,
  onChanged,
}: {
  documentId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [content, setContent] = useState<ClioDocumentContent | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<ClioDocumentVersion[] | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [audit, setAudit] = useState<ClioAuditEntry[] | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Load full content on open / id change.
  useEffect(() => {
    setContentError(null);
    setContent(null);
    fetchClioDocumentContent(documentId)
      .then(setContent)
      .catch((e) => setContentError(e instanceof Error ? e.message : String(e)));
    setVersionsOpen(false);
    setVersions(null);
    setAuditOpen(false);
    setAudit(null);
    setConfirmDelete(false);
    setActionError(null);
  }, [documentId]);

  // Lazy-load versions when the section opens.
  useEffect(() => {
    if (!versionsOpen || versions !== null) return;
    fetchClioDocumentVersions(documentId)
      .then(setVersions)
      .catch((e) => setVersionsError(e instanceof Error ? e.message : String(e)));
  }, [versionsOpen, versions, documentId]);

  // Lazy-load audit when the section opens.
  useEffect(() => {
    if (!auditOpen || audit !== null) return;
    fetchClioAuditLog({ documentId, limit: 50 })
      .then(setAudit)
      .catch((e) => setAuditError(e instanceof Error ? e.message : String(e)));
  }, [auditOpen, audit, documentId]);

  async function handleDelete() {
    setActing(true);
    setActionError(null);
    try {
      await deleteClioDocument(documentId);
      onChanged();
      onClose();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      setActing(false);
    }
  }

  async function handleRestore() {
    setActing(true);
    setActionError(null);
    try {
      const r = await restoreClioDocument(documentId);
      onChanged();
      // Refresh inline so the deleted-banner clears.
      if (content) {
        setContent({ ...content, document: r.document });
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(false);
    }
  }

  async function handlePurge() {
    if (!doc) return;
    if (!window.confirm(
      `Permanently delete "${doc.title}"?\n\n` +
      `This cannot be undone. Chunks + version history will be lost. ` +
      `An audit-log entry recording the purge will remain.`,
    )) return;
    setActing(true);
    setActionError(null);
    try {
      await purgeClioDocument(documentId);
      onChanged();
      onClose();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      setActing(false);
    }
  }

  const doc = content?.document;
  const isDeleted = !!doc?.deletedAt;

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={doc?.title ?? "Loading…"}
      size="lg"
      footer={
        <>
          {isDeleted ? (
            <>
              <button
                className="btn btn--danger"
                disabled={acting}
                onClick={handlePurge}
                title="Permanently delete (cannot be undone). Chunks + versions removed; audit-log entry retained."
              >
                {acting ? "…" : "Purge…"}
              </button>
              <button
                className="btn btn--primary"
                disabled={acting}
                onClick={handleRestore}
              >
                {acting ? "Restoring…" : "Restore"}
              </button>
            </>
          ) : (
            <>
              <button
                className="btn btn--secondary"
                disabled={acting || !content}
                onClick={() => setEditOpen(true)}
              >
                Edit…
              </button>
              <button
                className="btn btn--danger"
                disabled={acting}
                onClick={() => setConfirmDelete(true)}
              >
                Delete…
              </button>
            </>
          )}
          <button className="btn btn--secondary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {contentError && <div className="form-row__error">{contentError}</div>}
      {!contentError && !content && <div className="form-row__hint">loading…</div>}

      {content && doc && (
        <>
          {isDeleted && (
            <div
              style={{
                padding: "0.6rem 0.85rem",
                marginBottom: "0.85rem",
                background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
                border: "1px solid color-mix(in srgb, var(--color-error) 40%, var(--color-border))",
                borderRadius: 4,
                color: "var(--color-text)",
                fontSize: "var(--text-sm)",
              }}
            >
              <strong style={{ color: "var(--color-error)" }}>Deleted</strong> on {doc.deletedAt}.
              Click <strong>Restore</strong> to bring this document back into search results.
            </div>
          )}

          <DetailHeader doc={doc} totalChars={content.totalChars} chunkCount={content.chunkCount} />

          {Object.keys(doc.metadata ?? {}).length > 0 && (
            <details open style={{ marginBottom: "0.85rem" }}>
              <summary className="section-title" style={{ cursor: "pointer", padding: "0.4rem 0", fontSize: "var(--text-sm)" }}>
                Metadata
              </summary>
              <table className="config-display__table" style={{ marginTop: "0.4rem" }}>
                <tbody>
                  {Object.entries(doc.metadata ?? {}).map(([k, v]) => (
                    <tr key={k}>
                      <th style={{ width: "12rem" }}>{k}</th>
                      <td><code>{typeof v === "object" ? JSON.stringify(v) : String(v)}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}

          <details onToggle={(e) => setVersionsOpen((e.currentTarget as HTMLDetailsElement).open)}
            style={{ marginBottom: "0.85rem" }}>
            <summary className="section-title" style={{ cursor: "pointer", padding: "0.4rem 0", fontSize: "var(--text-sm)" }}>
              Version history {(doc.versionCount ?? 0) > 0 ? `(${doc.versionCount})` : "(none)"}
            </summary>
            {versionsOpen && (
              versionsError ? (
                <div className="form-row__error">{versionsError}</div>
              ) : versions === null ? (
                <div className="form-row__hint">loading…</div>
              ) : versions.length === 0 ? (
                <div className="form-row__hint">No archived versions. The current content is the only state.</div>
              ) : (
                <table className="config-display__table" style={{ marginTop: "0.4rem" }}>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Created</th>
                      <th>Author / source</th>
                      <th>Chunks</th>
                      <th>Chars</th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions.map((v) => (
                      <tr key={v.id}>
                        <td>v{v.versionNumber}</td>
                        <td>{v.createdAt}</td>
                        <td><code>{v.source ?? "(unknown)"}</code></td>
                        <td>{v.chunkCount}</td>
                        <td>{v.totalChars.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            )}
          </details>

          <details onToggle={(e) => setAuditOpen((e.currentTarget as HTMLDetailsElement).open)}
            style={{ marginBottom: "0.85rem" }}>
            <summary className="section-title" style={{ cursor: "pointer", padding: "0.4rem 0", fontSize: "var(--text-sm)" }}>
              Audit trail
            </summary>
            {auditOpen && (
              auditError ? (
                <div className="form-row__error">{auditError}</div>
              ) : audit === null ? (
                <div className="form-row__hint">loading…</div>
              ) : audit.length === 0 ? (
                <div className="form-row__hint">No audit events.</div>
              ) : (
                <AuditTable entries={audit} />
              )
            )}
          </details>

          <details open>
            <summary className="section-title" style={{ cursor: "pointer", padding: "0.4rem 0", fontSize: "var(--text-sm)" }}>
              Content ({content.totalChars.toLocaleString()} chars, {content.chunkCount} chunk{content.chunkCount === 1 ? "" : "s"})
            </summary>
            <pre className="memory-doc-viewer__content" style={{ marginTop: "0.4rem" }}>{content.content}</pre>
          </details>
        </>
      )}

      {actionError && <div className="form-row__error" style={{ marginTop: "0.5rem" }}>{actionError}</div>}

      {editOpen && content && doc && (
        <EditDocumentDialog
          open={true}
          onClose={() => setEditOpen(false)}
          doc={doc}
          initialContent={content.content}
          onSaved={() => {
            // Re-fetch content + nudge sidebar so version count etc. refresh.
            onChanged();
            // Force a content reload by clearing cached state.
            setContent(null);
            // useEffect on documentId reloads content; bump key by re-setting
            // documentId is overkill -- just re-trigger the fetch:
            void fetchClioDocumentContent(documentId).then(setContent).catch((e) =>
              setContentError(e instanceof Error ? e.message : String(e)),
            );
            // Reset audit + versions so the next open re-fetches them.
            setAudit(null);
            setVersions(null);
          }}
        />
      )}

      {confirmDelete && doc && (
        <Modal
          open={true}
          onClose={() => setConfirmDelete(false)}
          title="Delete document?"
          size="sm"
          footer={
            <>
              <button className="btn btn--secondary" onClick={() => setConfirmDelete(false)} disabled={acting}>
                Cancel
              </button>
              <button className="btn btn--danger" onClick={handleDelete} disabled={acting}>
                {acting ? "Deleting…" : "Delete"}
              </button>
            </>
          }
        >
          <p style={{ marginTop: 0 }}>
            Soft-delete <strong>{doc.title}</strong>?
          </p>
          <ul style={{ paddingLeft: "1.25rem", margin: "0.5rem 0", fontSize: "var(--text-sm)", lineHeight: 1.55 }}>
            <li>The document is removed from search results immediately.</li>
            <li>Content + metadata + chunks + versions are <strong>preserved</strong> (soft-delete only).</li>
            <li>You can <strong>restore</strong> from the document detail at any time.</li>
            <li>Hard-delete (purge) requires direct DB / CLI access.</li>
          </ul>
        </Modal>
      )}
    </Modal>
  );
}

function DetailHeader({ doc, totalChars, chunkCount }: { doc: { title: string; projectName?: string; author: string; createdAt: string; updatedAt: string; versionCount?: number; reviewStatus: string }; totalChars: number; chunkCount: number }) {
  return (
    <div style={{ marginBottom: "0.85rem", color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
      <span><strong>{doc.projectName ?? "(unknown project)"}</strong></span>
      <span> · author <code>{doc.author}</code></span>
      <span> · created {doc.createdAt}</span>
      <span> · updated {doc.updatedAt}</span>
      <span> · {chunkCount} chunk{chunkCount === 1 ? "" : "s"}</span>
      <span> · {totalChars.toLocaleString()} chars</span>
      {(doc.versionCount ?? 0) > 0 && <span> · {doc.versionCount} version{doc.versionCount === 1 ? "" : "s"}</span>}
      {doc.reviewStatus !== "approved" && <span> · review: {doc.reviewStatus}</span>}
    </div>
  );
}

function AuditTable({ entries }: { entries: ClioAuditEntry[] }) {
  return (
    <table className="project-history__table" style={{ marginTop: "0.4rem" }}>
      <thead>
        <tr>
          <th style={{ minWidth: "12rem" }}>Time</th>
          <th>Event</th>
          <th>Actor</th>
          <th>Detail</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.id} className="project-history__row">
            <td className="project-history__time">{e.timestamp}</td>
            <td><EventBadge type={e.eventType} /></td>
            <td>{e.actor ?? "(unknown)"}</td>
            <td><code style={{ fontSize: "var(--text-xs)" }}>{summariseAuditMetadata(e.metadata)}</code></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const EVENT_COLOR: Record<string, string> = {
  "create": "var(--color-success)",
  "update-content": "var(--color-info)",
  "edit-metadata": "var(--color-info)",
  "delete": "var(--color-error)",
  "restore": "var(--color-success)",
  "migrate-project": "var(--color-warning)",
};

function EventBadge({ type }: { type: string }) {
  return <span style={{ color: EVENT_COLOR[type] ?? "inherit", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}>{type}</span>;
}

function summariseAuditMetadata(m: Record<string, unknown>): string {
  if (!m || typeof m !== "object") return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(m)) {
    if (k === "diff" || k === "before" || k === "after") continue; // verbose
    parts.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return parts.join(", ");
}
