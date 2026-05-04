import { useEffect, useState } from "react";
import {
  createClioProject,
  fetchClioMetadataKeys,
  fetchClioProjects,
  ingestClio,
  type ClioMetadataKey,
  type ClioProject,
} from "../../api";

interface MetaRow {
  key: string;
  value: string;
}

/**
 * Text-paste ingest tab on the Memory page (item 6.18). The user-
 * facing complement to `cfcf clio ingest` -- file uploads stay in the
 * CLI for now (the UI doesn't yet have a multipart form path; revisit
 * when the use case appears).
 *
 * Project picker pre-populates from `/api/clio/projects` and includes a
 * "(create new)" sentinel that swaps to a text input -- same pattern
 * as the workspace creation modal in 6.12. The project is auto-created
 * server-side on submit if it doesn't exist (the backend's
 * resolveProject({ createIfMissing: true }) path); the explicit "create
 * new" affordance is mostly UX clarity, since simply typing a brand-new
 * project name in either the picker or a future text-only field would
 * also work.
 *
 * Metadata rows: dynamic key-value table with autocomplete on key from
 * `/api/clio/metadata-keys`. Empty rows are silently dropped on submit.
 */
export function IngestTab({
  activeProject,
  onIngested,
}: {
  /** Pre-selected project from the sidebar; null means no preselection. */
  activeProject: string | null;
  /** Called after a successful ingest so the sidebar/browse can refresh. */
  onIngested: (docId: string) => void;
}) {
  const [projects, setProjects] = useState<ClioProject[]>([]);
  const [project, setProject] = useState<string>(activeProject ?? "default");
  const [newProjectMode, setNewProjectMode] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [title, setTitle] = useState("");
  const [source, setSource] = useState("web-paste");
  const [author, setAuthor] = useState("user");
  const [content, setContent] = useState("");
  const [metaRows, setMetaRows] = useState<MetaRow[]>([{ key: "", value: "" }]);
  const [updateIfExists, setUpdateIfExists] = useState(false);
  const [knownKeys, setKnownKeys] = useState<ClioMetadataKey[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ id: string; title: string; action: "created" | "updated" } | null>(null);

  useEffect(() => {
    fetchClioProjects().then(setProjects).catch(() => setProjects([]));
    fetchClioMetadataKeys().then(setKnownKeys).catch(() => setKnownKeys([]));
  }, []);

  // If the sidebar's active project changes while this tab is open, sync.
  useEffect(() => {
    if (activeProject && !newProjectMode) setProject(activeProject);
  }, [activeProject, newProjectMode]);

  function buildMetadata(): Record<string, unknown> | undefined {
    const out: Record<string, unknown> = {};
    for (const r of metaRows) {
      const k = r.key.trim();
      const v = r.value.trim();
      if (!k || !v) continue;
      // Try to coerce numbers + booleans; otherwise keep as string.
      if (v === "true") out[k] = true;
      else if (v === "false") out[k] = false;
      else if (/^-?\d+(\.\d+)?$/.test(v)) out[k] = Number(v);
      else out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !content.trim()) return;
    const targetProject = newProjectMode ? newProjectName.trim() : project;
    if (!targetProject) {
      setError("Pick or type a project name.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      // If we're in "(create new)" mode, create the project first so the
      // doc lands in a known place even if the user is offline-ish (the
      // server's auto-create path also works, but doing it explicitly
      // gives a cleaner error message if the name conflicts with an
      // existing project).
      if (newProjectMode) {
        try { await createClioProject({ name: targetProject }); }
        catch (err) {
          // 409 (already exists) is fine -- fall through to ingest.
          if (!(err instanceof Error && err.message.toLowerCase().includes("already"))) {
            throw err;
          }
        }
      }
      const res = await ingestClio({
        project: targetProject,
        title: title.trim(),
        content,
        source: source.trim() || undefined,
        author: author.trim() || undefined,
        metadata: buildMetadata(),
        updateIfExists,
      });
      setSuccess({ id: res.id, title: res.document.title, action: res.action });
      onIngested(res.id);
      // Reset content but keep project / author / metadata as sticky.
      setTitle("");
      setContent("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function updateMetaRow(i: number, patch: Partial<MetaRow>) {
    setMetaRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function addMetaRow() {
    setMetaRows((rows) => [...rows, { key: "", value: "" }]);
  }

  function removeMetaRow(i: number) {
    setMetaRows((rows) => (rows.length === 1 ? [{ key: "", value: "" }] : rows.filter((_, idx) => idx !== i)));
  }

  return (
    <section className="memory-search">
      <h3 className="section-title" style={{ margin: "0 0 0.4rem 0", fontSize: "var(--text-md)" }}>
        Ingest
      </h3>
      <p className="form-row__hint" style={{ margin: "0 0 0.85rem 0" }}>
        Add a document to Clio by pasting its content. The CLI complement is{" "}
        <code>cfcf clio ingest</code> (which also handles file paths + stdin).
      </p>

      <form onSubmit={submit}>
        <div className="form-row">
          <label htmlFor="ingest-project">Project</label>
          {newProjectMode ? (
            <div className="form-row__inline">
              <input
                id="ingest-project"
                type="text"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="new project name"
                autoFocus
              />
              <button
                type="button"
                className="btn btn--small btn--secondary"
                onClick={() => { setNewProjectMode(false); setNewProjectName(""); }}
              >
                ↺
              </button>
            </div>
          ) : (
            <select
              id="ingest-project"
              value={project}
              onChange={(e) => {
                if (e.target.value === "__new__") { setNewProjectMode(true); return; }
                setProject(e.target.value);
              }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.name}>
                  {p.name}
                  {p.documentCount !== undefined ? ` — ${p.documentCount} docs` : ""}
                </option>
              ))}
              {!projects.some((p) => p.name === project) && project && (
                <option value={project}>{project} (new)</option>
              )}
              <option value="__new__">(create new project…)</option>
            </select>
          )}
        </div>

        <div className="form-row">
          <label htmlFor="ingest-title">Title</label>
          <input
            id="ingest-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            placeholder="Document title"
          />
        </div>

        <div className="form-row form-row__inline" style={{ gap: "1rem" }}>
          <div style={{ flex: 1 }}>
            <label htmlFor="ingest-source" style={{ display: "block", marginBottom: "0.35rem", fontSize: "var(--text-sm)", color: "var(--color-text)", fontWeight: 500 }}>
              Source
            </label>
            <input
              id="ingest-source"
              type="text"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="web-paste"
              style={{ width: "100%" }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label htmlFor="ingest-author" style={{ display: "block", marginBottom: "0.35rem", fontSize: "var(--text-sm)", color: "var(--color-text)", fontWeight: 500 }}>
              Author
            </label>
            <input
              id="ingest-author"
              type="text"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="user"
              style={{ width: "100%" }}
            />
          </div>
        </div>

        <div className="form-row">
          <label>Metadata (optional key/value pairs)</label>
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
                      list="ingest-meta-keys"
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
                    <button
                      type="button"
                      className="btn btn--small btn--secondary"
                      onClick={() => removeMetaRow(i)}
                      title="Remove this row"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <datalist id="ingest-meta-keys">
            {knownKeys.map((k) => (
              <option key={k.key} value={k.key}>
                {k.count} doc{k.count === 1 ? "" : "s"}
              </option>
            ))}
          </datalist>
          <button type="button" className="btn btn--small btn--secondary" onClick={addMetaRow} style={{ marginTop: "0.4rem" }}>
            + Add row
          </button>
          <span className="form-row__hint">
            Numbers (<code>3.14</code>) and booleans (<code>true</code>/<code>false</code>) are coerced; everything else is stored as a string.
          </span>
        </div>

        <div className="form-row">
          <label htmlFor="ingest-content">Content</label>
          <textarea
            id="ingest-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            required
            rows={16}
            placeholder="Paste markdown / text…"
            style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", lineHeight: 1.5, resize: "vertical" }}
          />
          <span className="form-row__hint">{content.length.toLocaleString()} chars</span>
        </div>

        <div className="form-row">
          <label style={{ display: "flex", gap: "0.4rem", alignItems: "center", cursor: "pointer", fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={updateIfExists}
              onChange={(e) => setUpdateIfExists(e.target.checked)}
            />
            <span>
              Update existing document if one with the same title is in this project
              {" "}
              <span className="form-row__hint" style={{ display: "inline" }}>
                (creates a version snapshot of the prior content)
              </span>
            </span>
          </label>
        </div>

        {error && <div className="form-row__error" style={{ marginBottom: "0.5rem" }}>{error}</div>}
        {success && (
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
            ✓ Document <strong>{success.title}</strong> {success.action} — id <code>{success.id}</code>
          </div>
        )}

        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={submitting || !title.trim() || !content.trim()}
          >
            {submitting ? "Ingesting…" : "Ingest"}
          </button>
        </div>
      </form>
    </section>
  );
}
