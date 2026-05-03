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
 * Repo-path entry: a text input + a "Browse…" button that uses the
 * File System Access API's `showDirectoryPicker()` when the browser
 * supports it (Chrome / Edge as of 2026). The text input remains the
 * source of truth and works in every browser; "Browse…" is a
 * convenience that fills it in. The picker doesn't expose a real OS
 * path -- it returns a `FileSystemDirectoryHandle` whose `.name` is
 * just the basename -- so the field is editable after picking and
 * users can paste a full path manually if they prefer.
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

  const supportsDirectoryPicker = typeof window !== "undefined" &&
    typeof (window as unknown as { showDirectoryPicker?: () => Promise<unknown> }).showDirectoryPicker === "function";

  async function browse() {
    try {
      const win = window as unknown as {
        showDirectoryPicker: (opts?: { mode?: "read" | "readwrite" }) => Promise<{ name: string }>;
      };
      const handle = await win.showDirectoryPicker({ mode: "read" });
      // The picker exposes only the directory name, NOT a real OS path.
      // We populate just the basename to give the user a starting point;
      // they typically need to paste the absolute path manually anyway,
      // since cfcf needs the host-side absolute path (the server runs
      // outside the browser sandbox).
      if (handle?.name && !repoPath) setRepoPath(handle.name);
    } catch (err: unknown) {
      // User-cancel is a no-op; only surface real errors.
      if (err instanceof Error && err.name !== "AbortError") {
        setError(err.message);
      }
    }
  }

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
          <div className="form-row__inline">
            <input
              id="new-ws-repo"
              type="text"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="/absolute/path/to/repo"
              required
            />
            {supportsDirectoryPicker && (
              <button
                type="button"
                className="btn btn--secondary btn--small"
                onClick={browse}
                disabled={submitting}
                title="Open the browser's directory picker (fills the basename only; paste the full absolute path)"
              >
                Browse…
              </button>
            )}
          </div>
          <span className="form-row__hint">
            Absolute path to a git working tree on this machine. The server (not your browser) opens the path,
            so it must be accessible from where <code>cfcf server</code> is running.
            {!supportsDirectoryPicker && " Your browser doesn't support a directory picker — paste the path manually."}
          </span>
        </div>

        <div className="form-row">
          <label htmlFor="new-ws-project">Clio Project (optional)</label>
          <input
            id="new-ws-project"
            type="text"
            value={clioProject}
            onChange={(e) => setClioProject(e.target.value)}
            placeholder="(defaults to the workspace name)"
            list="new-ws-project-list"
          />
          <datalist id="new-ws-project-list">
            {projects.map((p) => (
              <option key={p.id} value={p.name}>
                {p.documentCount !== undefined ? `${p.documentCount} docs` : ""}
              </option>
            ))}
          </datalist>
          <span className="form-row__hint">
            Cross-workspace memory bucket. Pick an existing project to share docs with other workspaces, or leave blank for a fresh per-workspace project.
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
