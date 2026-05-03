import { useEffect, useState } from "react";
import { Modal } from "../../components/Modal";
import { ApiError, editClioProject, type ClioProject } from "../../api";

/**
 * Rename + re-describe a Clio Project (item 6.18 round-2).
 *
 * Server refuses (409) when one or more workspaces still pin the OLD
 * name in their config. The error response carries
 * `dependentWorkspaces: [{id, name}]` -- we render the list inline so
 * the user can navigate to the workspace's Config tab and reassign.
 */
export function EditProjectDialog({
  open,
  onClose,
  project,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  project: ClioProject;
  onSaved: (next: ClioProject) => void;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dependents, setDependents] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    if (open) {
      setName(project.name);
      setDescription(project.description ?? "");
      setError(null);
      setDependents([]);
      setSubmitting(false);
    }
  }, [open, project]);

  const trimmed = name.trim();
  const nameChanged = trimmed !== project.name;
  const descChanged = description !== (project.description ?? "");
  const enabled = !submitting && trimmed && (nameChanged || descChanged);

  async function submit() {
    if (!enabled) return;
    setSubmitting(true);
    setError(null);
    setDependents([]);
    try {
      const updated = await editClioProject(project.id, {
        name: nameChanged ? trimmed : undefined,
        description: descChanged ? description : undefined,
      });
      onSaved(updated);
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
      title="Edit Clio Project"
      size="sm"
      footer={
        <>
          <button className="btn btn--secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={submit} disabled={!enabled}>
            {submitting ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="form-row">
        <label htmlFor="proj-edit-name">Name</label>
        <input
          id="proj-edit-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </div>
      <div className="form-row">
        <label htmlFor="proj-edit-desc">Description</label>
        <input
          id="proj-edit-desc"
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="(optional)"
        />
      </div>
      {error && <div className="form-row__error" style={{ marginBottom: "0.5rem" }}>{error}</div>}
      {dependents.length > 0 && (
        <div className="form-row__hint" style={{ marginBottom: "0.5rem" }}>
          Workspaces still pinning the old name:
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
          Open each workspace's <strong>Config</strong> tab and change its Clio Project to the new name first.
        </div>
      )}
    </Modal>
  );
}
