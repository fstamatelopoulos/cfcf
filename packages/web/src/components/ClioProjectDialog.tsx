import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import {
  fetchClioProjects,
  setWorkspaceClioProject,
  type ClioProject,
} from "../api";
import type { WorkspaceConfig } from "../types";

/**
 * Reassign a workspace's Clio Project (item 6.12; mirrors `cfcf
 * workspace set <name> --project <p>`).
 *
 * The server auto-creates the project if the typed name doesn't exist.
 * Two optional checkboxes control historical-doc rekeying:
 *
 * - **Migrate this workspace's docs**: rekeys docs whose
 *   `metadata.workspace_id` matches this workspace. Default off so the
 *   reassignment is a pure forward-going change.
 * - **Migrate ALL docs in the old project**: rekeys every doc in the
 *   old project, including those owned by other workspaces. Hidden
 *   behind an explicit second checkbox because the blast radius is
 *   different. Mirrors the CLI's `--all-in-project` flag.
 */
export function ClioProjectDialog({
  open,
  onClose,
  workspace,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  workspace: WorkspaceConfig;
  onSaved: (newProject: string, migrated: number) => void;
}) {
  const [project, setProject] = useState("");
  const [projects, setProjects] = useState<ClioProject[]>([]);
  const [migrateHistory, setMigrateHistory] = useState(false);
  const [allInProject, setAllInProject] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setProject(workspace.clioProject ?? "");
    setMigrateHistory(false);
    setAllInProject(false);
    setError(null);
    setSubmitting(false);
    fetchClioProjects().then(setProjects).catch(() => setProjects([]));
  }, [open, workspace.clioProject]);

  const trimmed = project.trim();
  const isUnchanged = trimmed === (workspace.clioProject ?? "");

  async function submit() {
    if (!trimmed || isUnchanged) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await setWorkspaceClioProject(workspace.id, {
        project: trimmed,
        migrateHistory: migrateHistory || allInProject,
        allInProject,
      });
      onSaved(res.clioProject, res.migrated);
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
      title="Change Clio Project"
      size="sm"
      footer={
        <>
          <button className="btn btn--secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            onClick={submit}
            disabled={submitting || !trimmed || isUnchanged}
          >
            {submitting ? "Saving…" : "Reassign"}
          </button>
        </>
      }
    >
      <div className="form-row">
        <label htmlFor="clio-project-input">Project name</label>
        <input
          id="clio-project-input"
          type="text"
          value={project}
          onChange={(e) => setProject(e.target.value)}
          list="clio-project-list"
          autoFocus
        />
        <datalist id="clio-project-list">
          {projects.map((p) => (
            <option key={p.id} value={p.name} />
          ))}
        </datalist>
        <span className="form-row__hint">
          Pick an existing project or type a new name (auto-created on save). Currently:{" "}
          <strong>{workspace.clioProject ?? "(none)"}</strong>.
        </span>
      </div>

      {workspace.clioProject && trimmed && trimmed !== workspace.clioProject && (
        <>
          <div className="form-row" style={{ marginBottom: "0.4rem" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={migrateHistory}
                onChange={(e) => setMigrateHistory(e.target.checked)}
              />
              <span>Migrate this workspace's existing docs to {trimmed}</span>
            </label>
            <span className="form-row__hint">
              Rekeys docs whose <code>metadata.workspace_id</code> matches this workspace.
              Off by default: the reassignment is a pure forward-going change unless you opt in.
            </span>
          </div>
          <div className="form-row">
            <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={allInProject}
                onChange={(e) => setAllInProject(e.target.checked)}
                disabled={!migrateHistory}
              />
              <span>Also migrate docs from other workspaces in {workspace.clioProject}</span>
            </label>
            <span className="form-row__hint">
              Wider blast radius — rekeys every doc in the old project, including those owned by other
              workspaces. Mirrors the CLI's <code>--all-in-project</code> flag.
            </span>
          </div>
        </>
      )}

      {error && <div className="form-row__error">{error}</div>}
    </Modal>
  );
}
