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
    // Hide cfcf-managed projects (`cf-system-*` system memory + each
    // existing workspace's `cf-workspace-<id>` per-workspace project)
    // from the picker — they're cfcf-internal and shouldn't be picked
    // as the home for a new workspace's user-facing memory. Item 6.9.
    fetchClioProjects()
      .then((all) =>
        setProjects(
          all.filter((p) => !p.isSystem && !p.name.startsWith("cf-workspace-")),
        ),
      )
      .catch(() => setProjects([]));
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
          <label htmlFor="new-ws-project">Shared Clio Project (optional)</label>
          {/* Item 6.9: by default a workspace gets its own
              `cf-workspace-<id>` project, auto-created at registration.
              The picker below is for the cross-workspace SHARING case
              only -- pick an existing user-named project (e.g.
              "backend-services") to pool memory with other workspaces.
              `<select>` (not `<input list>` + `<datalist>`) so the
              dropdown looks identical to Settings → Agent Roles →
              Adapter. New-project creation isn't supported here -- create
              new shared projects from the Memory page (or via
              `cfcf clio projects create`) and then pick them here. */}
          <select
            id="new-ws-project"
            value={clioProject}
            onChange={(e) => setClioProject(e.target.value)}
          >
            <option value="">(default: per-workspace project, auto-created)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.name}>
                {p.name}
                {p.documentCount !== undefined ? ` — ${p.documentCount} docs` : ""}
              </option>
            ))}
          </select>
          <span className="form-row__hint">
            Leave on default — the workspace will get its own
            <code>cf-workspace-&lt;id&gt;</code> Clio Project. Pick a shared
            project here ONLY if you want this workspace to pool memory
            with sibling workspaces (e.g. multiple repos in the same
            problem domain).
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
