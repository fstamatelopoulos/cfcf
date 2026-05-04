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

  useEffect(() => {
    if (open) {
      setConfirmText("");
      setError(null);
      setDependents([]);
      setSubmitting(false);
    }
  }, [open]);

  const enabled = confirmText.trim() === project.name && !submitting;

  async function submit() {
    if (!enabled) return;
    setSubmitting(true);
    setError(null);
    setDependents([]);
    try {
      await deleteClioProject(project.id);
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
        <li>The server refuses if any documents (live or soft-deleted) still belong to it -- reassign or remove docs first.</li>
        <li>The server also refuses if any cfcf workspace still pins this project's name -- reassign each workspace via its <strong>Config</strong> tab first.</li>
        <li>This action is <strong>not</strong> reversible.</li>
      </ul>
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
