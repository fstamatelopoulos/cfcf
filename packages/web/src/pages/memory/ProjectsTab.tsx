import { useEffect, useState } from "react";
import { createClioProject, fetchClioProjects, type ClioProject } from "../../api";
import { EditProjectDialog } from "./EditProjectDialog";
import { DeleteProjectDialog } from "./DeleteProjectDialog";

/**
 * Project listing + create on the Memory page (item 6.18). Mirrors
 * `cfcf clio projects list` + `cfcf clio projects create`. Rename and
 * delete are deferred (server endpoints don't exist; the CLI doesn't
 * surface them either; adding them is its own scope).
 *
 * Refreshes the parent's sidebar after a successful create so the
 * project picker shows the new entry immediately.
 */
export function ProjectsTab({ onCreated }: { onCreated: () => void }) {
  const [projects, setProjects] = useState<ClioProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [createdName, setCreatedName] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<ClioProject | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ClioProject | null>(null);

  function reload() {
    setLoading(true);
    setLoadError(null);
    fetchClioProjects()
      .then(setProjects)
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(reload, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await createClioProject({
        name: name.trim(),
        description: description.trim() || undefined,
      });
      setCreatedName(created.name);
      setName("");
      setDescription("");
      reload();
      onCreated();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "1rem" }}>
      <section className="memory-search">
        <h3 className="section-title" style={{ margin: "0 0 0.4rem 0", fontSize: "var(--text-md)" }}>
          Create project
        </h3>
        <form onSubmit={submit}>
          <div className="form-row">
            <label htmlFor="proj-name">Name</label>
            <input
              id="proj-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-project"
              required
            />
          </div>
          <div className="form-row">
            <label htmlFor="proj-desc">Description (optional)</label>
            <input
              id="proj-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this memory bucket is for"
            />
          </div>
          {submitError && <div className="form-row__error" style={{ marginBottom: "0.5rem" }}>{submitError}</div>}
          {createdName && (
            <div
              className="form-row__hint"
              style={{
                padding: "0.45rem 0.65rem",
                marginBottom: "0.5rem",
                background: "color-mix(in srgb, var(--color-success) 12%, transparent)",
                borderLeft: "3px solid var(--color-success)",
                color: "var(--color-text)",
              }}
            >
              ✓ Project <strong>{createdName}</strong> created
            </div>
          )}
          <button type="submit" className="btn btn--primary" disabled={submitting || !name.trim()}>
            {submitting ? "Creating…" : "Create project"}
          </button>
        </form>
      </section>

      <section className="memory-search">
        <h3 className="section-title" style={{ margin: "0 0 0.4rem 0", fontSize: "var(--text-md)" }}>
          All projects
        </h3>
        {loading && <div className="form-row__hint">loading…</div>}
        {loadError && <div className="form-row__error">{loadError}</div>}
        {!loading && !loadError && projects.length === 0 && (
          <div className="form-row__hint">No projects yet.</div>
        )}
        {projects.length > 0 && (
          <table className="project-history__table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Documents</th>
                <th>Description</th>
                <th>Created</th>
                <th style={{ width: "10rem" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} className="project-history__row">
                  <td>
                    <strong>{p.name}</strong>
                  </td>
                  <td>{p.documentCount ?? "—"}</td>
                  <td>{p.description ?? <span className="form-row__hint">—</span>}</td>
                  <td className="project-history__time">{p.createdAt}</td>
                  <td>
                    {p.isSystem ? (
                      <span
                        title="System-managed by cfcf — agent prompts hardcode this name. Renaming or deleting is blocked. Doc ingest is allowed."
                        style={{
                          display: "inline-block",
                          padding: "0.05rem 0.4rem",
                          fontSize: "var(--text-xs)",
                          background: "color-mix(in srgb, var(--color-info) 18%, transparent)",
                          color: "var(--color-info)",
                          borderRadius: 3,
                          fontFamily: "var(--font-mono)",
                        }}
                      >
                        system
                      </span>
                    ) : (
                      <div style={{ display: "flex", gap: "0.4rem" }}>
                        <button
                          className="btn btn--small btn--secondary"
                          onClick={() => setEditTarget(p)}
                          title="Rename or re-describe this project"
                        >
                          Edit…
                        </button>
                        <button
                          className="btn btn--small btn--danger"
                          onClick={() => setDeleteTarget(p)}
                          title="Delete this project (server refuses if any docs/workspaces still reference it)"
                        >
                          Delete…
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="form-row__hint" style={{ marginTop: "0.5rem" }}>
          Edit + delete via the API; the CLI doesn't surface these yet (use <code>cfcf clio projects list</code> to inspect).
          Both refuse if any cfcf workspaces still pin the project name -- reassign each workspace via its <strong>Config</strong> tab first.
        </div>
      </section>

      {editTarget && (
        <EditProjectDialog
          open={true}
          onClose={() => setEditTarget(null)}
          project={editTarget}
          onSaved={(_p) => { reload(); onCreated(); }}
        />
      )}
      {deleteTarget && (
        <DeleteProjectDialog
          open={true}
          onClose={() => setDeleteTarget(null)}
          project={deleteTarget}
          onDeleted={() => { reload(); onCreated(); }}
        />
      )}
    </div>
  );
}
