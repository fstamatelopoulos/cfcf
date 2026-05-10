import { useEffect, useState } from "react";
import { Modal } from "../../components/Modal";
import { ApiError, deleteClioProject, type ClioProject } from "../../api";

/**
 * Confirm + delete a Clio Project (item 6.18 round-2).
 *
 * Server refuses (409) when:
 *   (a) one or more workspaces pin the project name in their config
 *       (carries `dependentWorkspaces: [{id, name}]` for inline render)
 *   (b) any documents (live or soft-deleted) still belong to the
 *       project (the server's friendly error message includes the
 *       counts; we just surface it)
 *
 * Type-the-name confirm matches the workspace-delete pattern from
 * 6.12 -- the same friction discourages accidental clicks on a
 * destructive action.
 */
export function DeleteProjectDialog({
  open,
  onClose,
  project,
  onDeleted,
}: {
  open: boolean;
  onClose: () => void;
  project: ClioProject;
  onDeleted: () => void;
}) {
  const [confirmText, setConfirmText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dependents, setDependents] = useState<{ id: string; name: string }[]>([]);
  // Item 6.35 follow-up (2026-05-10): force-mode also purges soft-
  // deleted tombstones in the project. Surfaced from dogfood: user
  // soft-deleted docs to clean up, then couldn't delete the project
  // because the FK gate counts tombstones too. Live docs still block.
  const [forceMode, setForceMode] = useState(false);

  useEffect(() => {
    if (open) {
      setConfirmText("");
      setError(null);
      setDependents([]);
      setSubmitting(false);
      setForceMode(false);
    }
  }, [open]);

  const enabled = confirmText.trim() === project.name && !submitting;

  async function submit() {
    if (!enabled) return;
    setSubmitting(true);
    setError(null);
    setDependents([]);
    try {
      const result = await deleteClioProject(project.id, { force: forceMode });
      if (result.purgedTombstones && result.purgedTombstones > 0) {
        // Surface the side-effect so the user sees what force mode did.
        // Brief inline notice — the dialog is about to close on success
        // anyway, but the toast is a nicety we can add later.
        // For now we just log; onDeleted() will refresh the project list.
        console.info(`Purged ${result.purgedTombstones} soft-deleted document(s) along with the project.`);
      }
      onDeleted();
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        const d = err.payload?.dependentWorkspaces;
        if (Array.isArray(d)) setDependents(d as { id: string; name: string }[]);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Delete Clio Project?"
      size="sm"
      footer={
        <>
          <button className="btn btn--secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button className="btn btn--danger" onClick={submit} disabled={!enabled}>
            {submitting ? "Deleting…" : "Delete project"}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        Hard-delete <strong>{project.name}</strong>?
      </p>
      <ul style={{ paddingLeft: "1.25rem", margin: "0.5rem 0", fontSize: "var(--text-sm)", lineHeight: 1.55 }}>
        <li>The project row is removed from the Clio DB.</li>
        <li>The server refuses if any <strong>live</strong> documents still belong to it — reassign or remove them first.</li>
        <li>By default, <strong>soft-deleted</strong> tombstones also block; tick the box below to purge them along with the project.</li>
        <li>The server also refuses if any cfcf workspace still pins this project's name — reassign each workspace via its <strong>Config</strong> tab first.</li>
        <li>This action is <strong>not</strong> reversible.</li>
      </ul>
      <div className="form-row" style={{ marginTop: "0.75rem" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={forceMode}
            onChange={(e) => setForceMode(e.target.checked)}
          />
          <span>
            <strong>Force mode</strong> — also purge soft-deleted (recoverable) documents in this project
          </span>
        </label>
        <span className="form-row__hint">
          Use this to clean up after a workspace deletion when documents
          were soft-deleted but their tombstones still pin the project.
          Live documents still block — force only purges tombstones.
        </span>
      </div>
      <div className="form-row" style={{ marginTop: "1rem" }}>
        <label htmlFor="proj-delete-confirm">
          Type <code>{project.name}</code> to confirm:
        </label>
        <input
          id="proj-delete-confirm"
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          autoFocus
        />
      </div>
      {error && <div className="form-row__error" style={{ marginTop: "0.5rem" }}>{error}</div>}
      {dependents.length > 0 && (
        <div className="form-row__hint" style={{ marginTop: "0.5rem" }}>
          Workspaces still pinning this project:
          <ul style={{ paddingLeft: "1.25rem", margin: "0.35rem 0" }}>
            {dependents.map((w) => (
              <li key={w.id}>
                <a
                  href={`#/workspaces/${encodeURIComponent(w.id)}`}
                  onClick={(ev) => { ev.preventDefault(); window.location.hash = `/workspaces/${encodeURIComponent(w.id)}`; }}
                  style={{ color: "var(--color-info)", textDecoration: "underline" }}
                >
                  {w.name}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}
