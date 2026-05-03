import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import {
  createWorkspace,
  fetchClioProjects,
  type ClioProject,
} from "../api";
import type { WorkspaceConfig } from "../types";

/**
 * Create-workspace modal (item 6.12). Mirrors `cfcf workspace init` --
 * the server backfills any agent-role config from the global defaults
 * when fields are omitted, so we only ask for the essentials: name,
 * repo path, and an optional Clio Project.
 *
 * Repo path is a plain text field -- the user pastes an absolute path.
 * We previously had a `showDirectoryPicker()`-backed "Browse…" button
 * but the browser sandbox only exposes the directory's basename (no
 * absolute OS path is ever returned to the page), which made the
 * affordance misleading. Removed in the 6.12 polish pass.
 */
export function NewWorkspaceModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (workspace: WorkspaceConfig) => void;
}) {
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [clioProject, setClioProject] = useState("");
  const [projects, setProjects] = useState<ClioProject[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setRepoPath("");
    setClioProject("");
    setError(null);
    setSubmitting(false);
    fetchClioProjects().then(setProjects).catch(() => setProjects([]));
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !repoPath.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const workspace = await createWorkspace({
        name: name.trim(),
        repoPath: repoPath.trim(),
        clioProject: clioProject.trim() || undefined,
      });
      onCreated(workspace);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create workspace"
      footer={
        <>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="new-workspace-form"
            className="btn btn--primary"
            disabled={submitting || !name.trim() || !repoPath.trim()}
          >
            {submitting ? "Creating…" : "Create"}
          </button>
        </>
      }
    >
      <form id="new-workspace-form" onSubmit={submit}>
        <div className="form-row">
          <label htmlFor="new-ws-name">Name</label>
          <input
            id="new-ws-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-project"
            autoFocus
            required
          />
          <span className="form-row__hint">
            Short identifier; used in URLs, branch names, and CLI commands.
          </span>
        </div>

        <div className="form-row">
          <label htmlFor="new-ws-repo">Repository path</label>
          <input
            id="new-ws-repo"
            type="text"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="/absolute/path/to/repo"
            required
          />
          <span className="form-row__hint">
            Paste the absolute path to a git working tree on this machine. The server (not your browser) opens the path,
            so it must be accessible from where <code>cfcf server</code> is running.
          </span>
        </div>

        <div className="form-row">
          <label htmlFor="new-ws-project">Clio Project (optional)</label>
          {/* `<select>` (not `<input list>` + `<datalist>`) so the dropdown
              looks identical to Settings → Agent Roles → Adapter. The
              datalist popup is browser-chrome and varies in width across
              dialogs; <select> uses our themed CSS chevron consistently.
              New-project creation isn't supported here -- leave blank to
              auto-create from the workspace name; create new projects
              from the Memory page (or via `cfcf clio projects create`). */}
          <select
            id="new-ws-project"
            value={clioProject}
            onChange={(e) => setClioProject(e.target.value)}
          >
            <option value="">(auto: defaults to workspace name)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.name}>
                {p.name}
                {p.documentCount !== undefined ? ` — ${p.documentCount} docs` : ""}
              </option>
            ))}
          </select>
          <span className="form-row__hint">
            Cross-workspace memory bucket. Pick an existing project to share docs with other workspaces, or leave on auto for a fresh per-workspace project.
          </span>
        </div>

        <div className="form-row__hint" style={{ marginTop: "0.5rem" }}>
          Agent roles, iteration defaults, and notification config are inherited from your global settings.
          Edit them per-workspace from the workspace's <strong>Config</strong> tab once it's created.
        </div>

        {error && <div className="form-row__error" style={{ marginTop: "0.75rem" }}>{error}</div>}
      </form>
    </Modal>
  );
}
