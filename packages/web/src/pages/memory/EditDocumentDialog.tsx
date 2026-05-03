import { useEffect, useState } from "react";
import { Modal } from "../../components/Modal";
import {
  editClioDocumentMetadata,
  fetchClioMetadataKeys,
  fetchClioProjects,
  ingestClio,
  type ClioDocument,
  type ClioMetadataKey,
  type ClioProject,
} from "../../api";

interface MetaRow { key: string; value: string }

/**
 * Edit a Clio document (item 6.18 round-2). Combines the two existing
 * server endpoints behind one form:
 *
 *   - PATCH /api/clio/documents/:id        ← metadata-only edits
 *     (title / project / metadata): no version snapshot, single
 *     `edit-metadata` audit row.
 *   - POST  /api/clio/ingest with documentId  ← content edits:
 *     snapshots the outgoing chunks as a new version, replaces the
 *     live content, writes an `update-content` audit row. Routes
 *     through the content-unchanged short-circuit added in the same
 *     round, so a save with the original content + new metadata
 *     becomes a metadata-only update server-side too (no spurious
 *     version snapshot).
 *
 * On submit we diff the draft against the original and pick the right
 * path:
 *   - content unchanged                                 → PATCH only
 *   - content changed AND no metadata changed           → POST ingest only
 *   - both changed                                      → PATCH first
 *                                                          (metadata audit
 *                                                          row), then POST
 *                                                          ingest (content
 *                                                          audit row).
 *
 * The two-call shape keeps each audit entry semantically clean.
 */
export function EditDocumentDialog({
  open,
  onClose,
  doc,
  initialContent,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  doc: ClioDocument;
  /** Reconstructed content from /api/clio/documents/:id/content. Pre-loaded by the caller. */
  initialContent: string;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(doc.title);
  const [projectName, setProjectName] = useState<string>(doc.projectName ?? "");
  const [author, setAuthor] = useState(doc.author);
  const [content, setContent] = useState(initialContent);
  const [metaRows, setMetaRows] = useState<MetaRow[]>(metadataToRows(doc.metadata ?? {}));
  const [projects, setProjects] = useState<ClioProject[]>([]);
  const [knownKeys, setKnownKeys] = useState<ClioMetadataKey[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(doc.title);
    setProjectName(doc.projectName ?? "");
    setAuthor(doc.author);
    setContent(initialContent);
    setMetaRows(metadataToRows(doc.metadata ?? {}));
    setError(null);
    setSubmitting(false);
    fetchClioProjects().then(setProjects).catch(() => setProjects([]));
    fetchClioMetadataKeys().then(setKnownKeys).catch(() => setKnownKeys([]));
  }, [open, doc, initialContent]);

  const draftMetadata = rowsToMetadata(metaRows);

  const titleChanged = title.trim() !== doc.title;
  const authorChanged = author.trim() !== doc.author;
  const projectChanged = !!projectName && projectName !== doc.projectName;
  const metaChanged = JSON.stringify(draftMetadata) !== JSON.stringify(doc.metadata ?? {});
  const contentChanged = content !== initialContent;
  const anyChanged = titleChanged || authorChanged || projectChanged || metaChanged || contentChanged;

  function updateMetaRow(i: number, patch: Partial<MetaRow>) {
    setMetaRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addMetaRow() {
    setMetaRows((rows) => [...rows, { key: "", value: "" }]);
  }
  function removeMetaRow(i: number) {
    setMetaRows((rows) => (rows.length === 1 ? [{ key: "", value: "" }] : rows.filter((_, idx) => idx !== i)));
  }

  async function submit() {
    if (!anyChanged) return;
    setSubmitting(true);
    setError(null);
    try {
      // Diff against original to compute the patch payload.
      const metaSet: Record<string, unknown> | undefined = metaChanged ? draftMetadata : undefined;
      const metaUnset: string[] | undefined = metaChanged
        ? Object.keys(doc.metadata ?? {}).filter((k) => !(k in draftMetadata))
        : undefined;
      const metadataChangesExist = titleChanged || authorChanged || projectChanged || metaChanged;

      // Step 1: metadata patch (if there's any non-content change).
      if (metadataChangesExist) {
        await editClioDocumentMetadata(doc.id, {
          title: titleChanged ? title.trim() : undefined,
          author: authorChanged ? author.trim() : undefined,
          projectName: projectChanged ? projectName : undefined,
          metadataSet: metaSet,
          metadataUnset: metaUnset && metaUnset.length > 0 ? metaUnset : undefined,
        });
      }

      // Step 2: content ingest (if content changed). The server's
      // content-unchanged short-circuit means a no-op "rewrite" of
      // identical content + a metadata-only diff would also work via
      // a single ingest call, but routing through the explicit PATCH
      // first keeps each audit entry one-purpose.
      if (contentChanged) {
        await ingestClio({
          project: projectName || (doc.projectName ?? "default"),
          title: titleChanged ? title.trim() : doc.title,
          content,
          documentId: doc.id,
          author: author.trim() || undefined,
          metadata: metaChanged ? draftMetadata : undefined,
        } as Parameters<typeof ingestClio>[0] & { documentId: string });
      }

      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Edit document — ${doc.title}`}
      size="lg"
      footer={
        <>
          <button className="btn btn--secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={submit} disabled={!anyChanged || submitting}>
            {submitting ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="form-row">
        <label htmlFor="edit-doc-title">Title</label>
        <input
          id="edit-doc-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
      </div>

      <div className="form-row form-row__inline" style={{ gap: "1rem" }}>
        <div style={{ flex: 1 }}>
          <label htmlFor="edit-doc-project" style={{ display: "block", marginBottom: "0.35rem", fontSize: "var(--text-sm)", color: "var(--color-text)", fontWeight: 500 }}>
            Project
          </label>
          <select
            id="edit-doc-project"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            style={{ width: "100%" }}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.name}>{p.name}</option>
            ))}
            {projectName && !projects.some((p) => p.name === projectName) && (
              <option value={projectName}>{projectName} (current)</option>
            )}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label htmlFor="edit-doc-author" style={{ display: "block", marginBottom: "0.35rem", fontSize: "var(--text-sm)", color: "var(--color-text)", fontWeight: 500 }}>
            Author
          </label>
          <input
            id="edit-doc-author"
            type="text"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            style={{ width: "100%" }}
          />
        </div>
      </div>

      <div className="form-row">
        <label>Metadata</label>
        <table className="config-display__table">
          <tbody>
            {metaRows.map((r, i) => (
              <tr key={i}>
                <td style={{ width: "12rem" }}>
                  <input
                    type="text"
                    value={r.key}
                    onChange={(e) => updateMetaRow(i, { key: e.target.value })}
                    placeholder="key"
                    list="edit-doc-meta-keys"
                    style={{ width: "100%" }}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    value={r.value}
                    onChange={(e) => updateMetaRow(i, { value: e.target.value })}
                    placeholder="value"
                    style={{ width: "100%" }}
                  />
                </td>
                <td style={{ width: "3rem" }}>
                  <button type="button" className="btn btn--small btn--secondary" onClick={() => removeMetaRow(i)} title="Remove this row">×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <datalist id="edit-doc-meta-keys">
          {knownKeys.map((k) => (
            <option key={k.key} value={k.key}>{k.count} doc{k.count === 1 ? "" : "s"}</option>
          ))}
        </datalist>
        <button type="button" className="btn btn--small btn--secondary" onClick={addMetaRow} style={{ marginTop: "0.4rem" }}>
          + Add row
        </button>
      </div>

      <div className="form-row">
        <label htmlFor="edit-doc-content">Content</label>
        <textarea
          id="edit-doc-content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={20}
          style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", lineHeight: 1.5, resize: "vertical" }}
        />
        <span className="form-row__hint">
          {content.length.toLocaleString()} chars
          {contentChanged && " · content changed (will snapshot a new version)"}
          {!contentChanged && " · content unchanged (no version snapshot)"}
        </span>
      </div>

      {error && <div className="form-row__error" style={{ marginBottom: "0.5rem" }}>{error}</div>}
      {!anyChanged && (
        <div className="form-row__hint" style={{ marginBottom: "0.5rem" }}>
          Nothing changed yet. Edit a field above to enable Save.
        </div>
      )}
    </Modal>
  );
}

function metadataToRows(m: Record<string, unknown>): MetaRow[] {
  const entries = Object.entries(m ?? {});
  if (entries.length === 0) return [{ key: "", value: "" }];
  return entries.map(([k, v]) => ({ key: k, value: typeof v === "object" ? JSON.stringify(v) : String(v) }));
}

function rowsToMetadata(rows: MetaRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const k = r.key.trim();
    const v = r.value.trim();
    if (!k || !v) continue;
    if (v === "true") out[k] = true;
    else if (v === "false") out[k] = false;
    else if (/^-?\d+(\.\d+)?$/.test(v)) out[k] = Number(v);
    else out[k] = v;
  }
  return out;
}
