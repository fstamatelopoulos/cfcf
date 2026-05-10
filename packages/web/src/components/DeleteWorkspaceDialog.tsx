import { useState, useEffect } from "react";
import { Modal } from "./Modal";
import { deleteWorkspace } from "../api";
import type { WorkspaceConfig } from "../types";

/**
 * Confirm-and-delete dialog for a workspace (item 6.12).
 *
 * **Scope: cfcf config only** -- removes the workspace registration
 * (and the per-workspace cfcf-state directory under the cfcf data dir).
 * The repo folder at `repoPath` is NEVER touched. The dialog spells
 * this out explicitly because the wording matters: users who type the
 * confirmation are agreeing to the cfcf-side wipe, not to losing their
 * code.
 *
 * Confirmation pattern: type the workspace name to enable Delete (the
 * standard "are you sure?" friction for destructive ops; matches the
 * GitHub repo-deletion UX users will already recognise).
 */
export function DeleteWorkspaceDialog({
  open,
  onClose,
  workspace,
  onDeleted,
}: {
  open: boolean;
  onClose: () => void;
  workspace: WorkspaceConfig;
  onDeleted: () => void;
}) {
  const [confirmText, setConfirmText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Item 6.35 follow-up (2026-05-10): cascade-delete the workspace's
  // dedicated `cf-workspace-<id>` Clio Project + force-purge any
  // soft-deleted documents in it. Default false so we don't surprise
  // users who want to preserve the workspace's memory after deleting
  // the workspace itself.
  const [cascadeClio, setCascadeClio] = useState(false);

  useEffect(() => {
    if (open) {
      setConfirmText("");
      setError(null);
      setSubmitting(false);
      setCascadeClio(false);
    }
  }, [open]);

  const enabled = confirmText.trim() === workspace.name && !submitting;

  // Cascade only matches the per-workspace project shape — shared
  // projects (e.g. `backend-services`) stay untouched even if the
  // checkbox is ticked, because sibling workspaces may pin them.
  const cascadeApplies = workspace.clioProject === `cf-workspace-${workspace.id}`;

  async function submit() {
    if (!enabled) return;
    setSubmitting(true);
    setError(null);
    try {
      await deleteWorkspace(workspace.id, { cascadeClio });
      onDeleted();
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
      title="Delete workspace?"
      size="sm"
      footer={
        <>
          <button className="btn btn--secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button className="btn btn--danger" onClick={submit} disabled={!enabled}>
            {submitting ? "Deleting…" : "Delete workspace"}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        This removes <strong>{workspace.name}</strong> from cfcf's registry.
      </p>
      <ul style={{ paddingLeft: "1.25rem", margin: "0.5rem 0", fontSize: "var(--text-sm)", lineHeight: 1.55 }}>
        <li>The repo folder at <code>{workspace.repoPath}</code> is <strong>not touched</strong>.</li>
        <li>cfcf-state files (history, signals, logs) for this workspace are removed.</li>
        <li>Iteration branches in your repo (<code>cfcf/iteration-N</code>) are <strong>not touched</strong>.</li>
        <li>By default, Clio docs ingested under this workspace are <strong>not touched</strong>; they stay in the Clio Project. Tick the cascade box below to also delete the dedicated project.</li>
      </ul>
      {cascadeApplies && (
        <div className="form-row" style={{ marginTop: "0.75rem" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={cascadeClio}
              onChange={(e) => setCascadeClio(e.target.checked)}
            />
            <span>
              Also delete the dedicated Clio Project <code>{workspace.clioProject}</code>
              {" "}(force-purges any soft-deleted documents)
            </span>
          </label>
          <span className="form-row__hint">
            The cascade only applies to per-workspace projects
            (<code>cf-workspace-&lt;id&gt;</code>). If you'd shared this
            workspace's memory with siblings under a named project, the
            cascade would be skipped automatically.
          </span>
        </div>
      )}
      {!cascadeApplies && workspace.clioProject && (
        <div className="form-row__hint" style={{ marginTop: "0.75rem" }}>
          This workspace uses the shared Clio Project{" "}
          <code>{workspace.clioProject}</code> — sibling workspaces may
          still pin it, so cfcf won't auto-delete it. Use the Memory
          page's Projects tab to delete it manually if you want.
        </div>
      )}
      <div className="form-row" style={{ marginTop: "1rem" }}>
        <label htmlFor="delete-ws-confirm">
          Type <code>{workspace.name}</code> to confirm:
        </label>
        <input
          id="delete-ws-confirm"
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          autoFocus
        />
      </div>
      {error && <div className="form-row__error">{error}</div>}
    </Modal>
  );
}
