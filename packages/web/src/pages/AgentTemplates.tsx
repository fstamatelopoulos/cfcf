/**
 * Agents page (item 6.8): role-template management UI.
 *
 * Top-level layout: a tab strip across the top (one tab per managed
 * role template), then the main panel for the selected role with:
 *   - Heading + "currently in production" indicator
 *   - Version selector dropdown
 *   - Editor (textarea) — read-only by default; toggle Edit to make
 *     it editable. Save creates a new version with a label.
 *   - Promote-to-production / Revert-to-default actions
 *   - Per-version delete affordance (disabled for default)
 *
 * State model: the currently-selected version is tracked locally
 * (`selectedVersionId`); when the user picks a different version
 * we re-fetch the content. The "promoted" version is whatever the
 * server says — independent of which version the user is viewing.
 */

import { useEffect, useState } from "react";
import {
  listRoleTemplates,
  getRoleTemplate,
  getRoleTemplateVersionContent,
  createRoleTemplateVersion,
  updateRoleTemplateVersion,
  deleteRoleTemplateVersion,
  promoteRoleTemplateVersion,
  type RoleTemplateSummary,
  type RoleTemplateFull,
  type RoleTemplateVersion,
} from "../api";
import { navigateTo } from "../hooks/useRoute";

const DEFAULT_VERSION_ID = "default";

interface Props {
  /** Optional preselected template name (from `?template=` query). */
  initialTemplate?: string;
}

export function AgentTemplatesPage({ initialTemplate }: Props) {
  const [summaries, setSummaries] = useState<RoleTemplateSummary[]>([]);
  const [activeName, setActiveName] = useState<string | null>(initialTemplate ?? null);
  const [template, setTemplate] = useState<RoleTemplateFull | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string>(DEFAULT_VERSION_ID);
  const [content, setContent] = useState<string>("");
  const [isEditing, setIsEditing] = useState(false);
  const [editingDirty, setEditingDirty] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Bumped after a save / delete / promote to refresh dependent data.
  const [rev, setRev] = useState(0);

  // Initial load: fetch summary list + auto-select first if none chosen
  // (or if the URL points at a template name that doesn't exist).
  useEffect(() => {
    listRoleTemplates()
      .then((r) => {
        setSummaries(r.templates);
        if (r.templates.length === 0) return;
        const requestedExists = activeName && r.templates.some((s) => s.name === activeName);
        if (!requestedExists) {
          setActiveName(r.templates[0].name);
        }
      })
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // React to back/forward navigation: when the URL's `?template=` query
  // changes, sync activeName so the page actually shows the new tab.
  // Without this effect, only the first mount's initialTemplate was
  // honoured; later hash changes were silently ignored.
  useEffect(() => {
    if (!initialTemplate) return;
    if (initialTemplate === activeName) return;
    if (summaries.some((s) => s.name === initialTemplate)) {
      setActiveName(initialTemplate);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTemplate, summaries]);

  // Whenever activeName or rev changes, fetch full template state.
  useEffect(() => {
    if (!activeName) return;
    setError(null);
    getRoleTemplate(activeName)
      .then((t) => {
        setTemplate(t);
        // Default to viewing the currently-promoted version.
        setSelectedVersionId(t.currentVersionId);
        setContent(t.currentContent);
        setIsEditing(false);
        setEditingDirty(false);
        // Update URL (without page reload) so the back button works.
        if (window.location.hash !== `#/agents?template=${encodeURIComponent(t.name)}`) {
          window.history.replaceState(null, "", `#/agents?template=${encodeURIComponent(t.name)}`);
        }
      })
      .catch((e) => setError(String(e)));
  }, [activeName, rev]);

  // When the user picks a different version (without editing), fetch its content.
  useEffect(() => {
    if (!activeName || !template) return;
    if (isEditing) return; // don't blow away in-flight edits
    if (selectedVersionId === template.currentVersionId) {
      setContent(template.currentContent);
      return;
    }
    if (selectedVersionId === DEFAULT_VERSION_ID) {
      setContent(template.defaultContent);
      return;
    }
    getRoleTemplateVersionContent(activeName, selectedVersionId)
      .then((r) => setContent(r.content))
      .catch((e) => setError(String(e)));
  }, [selectedVersionId, activeName, template, isEditing]);

  // --- Action handlers ---

  async function handleSaveAsNew() {
    if (!activeName) return;
    const label = window.prompt("Label for this version (e.g. 'stricter judge', 'opus run')");
    if (!label || !label.trim()) return;
    setBusy(true);
    setStatusMsg(null);
    try {
      const v = await createRoleTemplateVersion(activeName, { label: label.trim(), content });
      setStatusMsg(`✓ Saved as "${v.label}". (Not yet promoted — click Promote below.)`);
      setIsEditing(false);
      setEditingDirty(false);
      setRev((n) => n + 1);
      setSelectedVersionId(v.id);
    } catch (e) {
      setError(`Save failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveExisting() {
    if (!activeName || !template) return;
    if (selectedVersionId === DEFAULT_VERSION_ID) {
      setError("Cannot edit the bundled default. Save as a new version instead.");
      return;
    }
    setBusy(true);
    setStatusMsg(null);
    try {
      await updateRoleTemplateVersion(activeName, selectedVersionId, { content });
      setStatusMsg(
        selectedVersionId === template.currentVersionId
          ? "✓ Saved. (This version is currently promoted, so the change is live for the next agent run.)"
          : "✓ Saved. (Promote this version to make it live.)",
      );
      setIsEditing(false);
      setEditingDirty(false);
      setRev((n) => n + 1);
    } catch (e) {
      setError(`Save failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handlePromote() {
    if (!activeName) return;
    setBusy(true);
    setStatusMsg(null);
    try {
      const refreshed = await promoteRoleTemplateVersion(activeName, selectedVersionId);
      setTemplate(refreshed);
      setStatusMsg(
        selectedVersionId === DEFAULT_VERSION_ID
          ? "✓ Reverted to bundled default. The next agent run will use cf²'s default template."
          : `✓ Promoted to production. The next agent run will use this version.`,
      );
      setRev((n) => n + 1);
    } catch (e) {
      setError(`Promote failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!activeName || !template) return;
    if (selectedVersionId === DEFAULT_VERSION_ID) return; // can't happen UI-wise
    const v = template.versions.find((x) => x.id === selectedVersionId);
    if (!v) return;
    if (!window.confirm(`Delete version "${v.label}"? This cannot be undone.`)) return;
    setBusy(true);
    setStatusMsg(null);
    try {
      await deleteRoleTemplateVersion(activeName, selectedVersionId);
      setStatusMsg(`✓ Deleted "${v.label}".`);
      setSelectedVersionId(DEFAULT_VERSION_ID);
      setRev((n) => n + 1);
    } catch (e) {
      setError(`Delete failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  // --- Render ---

  if (!activeName) {
    return (
      <div style={{ padding: "1rem" }}>
        <h2>Agents</h2>
        <p>Loading role templates…</p>
        {error && <div className="dashboard__error">{error}</div>}
      </div>
    );
  }

  const promotedLabel = (() => {
    if (!template) return "—";
    if (template.currentVersionId === DEFAULT_VERSION_ID) return "Default (built-in)";
    const v = template.versions.find((x) => x.id === template.currentVersionId);
    return v ? v.label : template.currentVersionId;
  })();

  const selectionIsPromoted = template?.currentVersionId === selectedVersionId;
  const selectionIsDefault = selectedVersionId === DEFAULT_VERSION_ID;

  return (
    <div style={{ padding: "1rem", maxWidth: "1100px", margin: "0 auto" }}>
      <h2 style={{ marginTop: 0 }}>Agents</h2>
      <p style={{ marginTop: 0, color: "var(--color-text-muted, #888)", fontSize: "var(--text-sm)" }}>
        Manage the instruction templates each agent role reads. Each role has a built-in default
        (always available) and any number of saved versions you create. <strong>Promote</strong> a
        version to make cf² use it on the next agent run.
      </p>

      {/* Tab strip */}
      <div
        role="tablist"
        style={{
          display: "flex",
          gap: "0.25rem",
          borderBottom: "1px solid var(--color-border, #444)",
          marginBottom: "1rem",
          flexWrap: "wrap",
        }}
      >
        {summaries.map((s) => {
          const isActive = s.name === activeName;
          return (
            <button
              key={s.name}
              role="tab"
              aria-selected={isActive}
              onClick={() => {
                if (editingDirty && !window.confirm("Discard unsaved changes?")) return;
                setActiveName(s.name);
              }}
              style={{
                padding: "0.5rem 0.9rem",
                border: "none",
                borderBottom: isActive ? "2px solid var(--color-accent, #4a8ee6)" : "2px solid transparent",
                background: "transparent",
                color: isActive ? "var(--color-text)" : "var(--color-text-muted, #888)",
                cursor: "pointer",
                fontWeight: isActive ? "bold" : "normal",
                fontSize: "var(--text-sm)",
              }}
            >
              {s.displayName}
              {s.currentVersionId !== DEFAULT_VERSION_ID && (
                <span
                  title="Custom version is currently promoted"
                  style={{ marginLeft: "0.4rem", color: "var(--color-accent, #4a8ee6)" }}
                >
                  •
                </span>
              )}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="dashboard__error" style={{ marginBottom: "1rem" }}>
          {error}
        </div>
      )}

      {template && (
        <>
          {/* Heading + promoted indicator */}
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "0.75rem",
              marginBottom: "0.75rem",
            }}
          >
            <h3 style={{ margin: 0 }}>
              {template.displayName}
              {isEditing && editingDirty && (
                <span
                  style={{
                    marginLeft: "0.5rem",
                    fontSize: "var(--text-sm)",
                    color: "var(--color-warning, #c8861a)",
                    fontWeight: "normal",
                  }}
                  title="You have unsaved changes"
                >
                  • unsaved changes
                </span>
              )}
            </h3>
            <span style={{ fontSize: "var(--text-sm)", color: "var(--color-text-muted, #888)" }}>
              In production:{" "}
              <strong style={{ color: "var(--color-text)" }}>{promotedLabel}</strong>
            </span>
          </div>
          <p style={{ marginTop: 0, fontSize: "var(--text-sm)", color: "var(--color-text-muted, #888)" }}>
            Template file: <code>{template.name}</code>. Override path:{" "}
            <code>~/.cfcf/templates/{template.name}</code>{" "}
            <span style={{ opacity: 0.7 }}>
              (written by cf² when you promote a non-default version; deleted when you revert).
            </span>
          </p>

          {/* Version selector + actions */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              flexWrap: "wrap",
              marginBottom: "0.75rem",
            }}
          >
            <label htmlFor="version-select" style={{ fontSize: "var(--text-sm)" }}>
              Version:
            </label>
            <select
              id="version-select"
              value={selectedVersionId}
              disabled={isEditing}
              onChange={(e) => setSelectedVersionId(e.target.value)}
              style={{ minWidth: "16rem" }}
            >
              <option value={DEFAULT_VERSION_ID}>
                Default (built-in)
                {template.currentVersionId === DEFAULT_VERSION_ID ? " — promoted" : ""}
              </option>
              {template.versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} ({new Date(v.savedAt).toLocaleString()})
                  {template.currentVersionId === v.id ? " — promoted" : ""}
                </option>
              ))}
            </select>

            {!isEditing ? (
              <>
                <button
                  type="button"
                  className="btn btn--small btn--secondary"
                  disabled={busy}
                  onClick={() => setIsEditing(true)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn--small btn--primary"
                  disabled={busy || selectionIsPromoted}
                  onClick={handlePromote}
                  title={selectionIsPromoted ? "Already promoted" : "Make cf² use this version on the next agent run"}
                >
                  {selectionIsDefault ? "Revert to default" : "Promote to production"}
                </button>
                {!selectionIsDefault && (
                  <button
                    type="button"
                    className="btn btn--small btn--danger"
                    disabled={busy}
                    onClick={handleDelete}
                    title="Delete this saved version (cannot be undone)"
                  >
                    Delete version
                  </button>
                )}
              </>
            ) : (
              <>
                {!selectionIsDefault && (
                  <button
                    type="button"
                    className="btn btn--small btn--primary"
                    disabled={busy || !editingDirty}
                    onClick={handleSaveExisting}
                  >
                    Save changes
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn--small btn--primary"
                  disabled={busy || !editingDirty}
                  onClick={handleSaveAsNew}
                  title="Save as a new version (with a label) — original stays untouched"
                >
                  Save as new version
                </button>
                <button
                  type="button"
                  className="btn btn--small btn--secondary"
                  disabled={busy}
                  onClick={() => {
                    if (editingDirty && !window.confirm("Discard unsaved changes?")) return;
                    setIsEditing(false);
                    setEditingDirty(false);
                    // Re-fetch original content for the selected version.
                    setRev((n) => n + 1);
                  }}
                >
                  Cancel
                </button>
              </>
            )}
          </div>

          {statusMsg && (
            <div
              style={{
                marginBottom: "0.75rem",
                padding: "0.5rem 0.75rem",
                background: "color-mix(in srgb, var(--color-success, #6ec06e) 12%, transparent)",
                borderLeft: "3px solid var(--color-success, #6ec06e)",
                fontSize: "var(--text-sm)",
                borderRadius: "4px",
              }}
            >
              {statusMsg}
            </div>
          )}

          {/* Content editor.
              readOnly is gated ONLY by `!isEditing` — the bundled default
              "lives" on disk read-only (we never overwrite the embedded
              constant), but the user still needs to TYPE in this editor
              to draft a new version that gets saved via "Save as new
              version". The save action is what's gated, not the typing. */}
          <textarea
            value={content}
            readOnly={!isEditing}
            onChange={(e) => {
              setContent(e.target.value);
              setEditingDirty(true);
            }}
            spellCheck={false}
            style={{
              width: "100%",
              minHeight: "60vh",
              fontFamily: "var(--font-mono, monospace)",
              fontSize: "var(--text-sm)",
              padding: "0.75rem",
              border: "1px solid var(--color-border, #444)",
              borderRadius: "4px",
              background: isEditing
                ? "var(--color-bg)"
                : "var(--color-bg-muted, var(--color-bg))",
              color: "var(--color-text)",
              resize: "vertical",
            }}
          />
          {isEditing && selectionIsDefault && (
            <p
              style={{
                marginTop: "0.5rem",
                fontSize: "var(--text-sm)",
                color: "var(--color-text-muted, #888)",
              }}
            >
              You're editing a copy of the bundled default. Click{" "}
              <strong>Save as new version</strong> to fork your changes
              into a new version (the cf²-shipped default itself stays
              untouched and remains available in the dropdown).
            </p>
          )}

          {/* Inline help below editor */}
          <div
            style={{
              marginTop: "1rem",
              padding: "0.75rem 1rem",
              background: "color-mix(in srgb, var(--color-info, #4a8ee6) 8%, transparent)",
              borderLeft: "3px solid var(--color-info, #4a8ee6)",
              fontSize: "var(--text-sm)",
              borderRadius: "4px",
              lineHeight: 1.5,
            }}
            role="status"
          >
            <strong style={{ display: "block", marginBottom: "0.25rem" }}>How this works</strong>
            <div style={{ marginBottom: "0.4rem" }}>
              cf² ships a built-in default for every role. Saved versions live under{" "}
              <code>~/.cfcf/templates-managed/{template.name}/</code>. When you promote a version,
              its content is written to <code>~/.cfcf/templates/{template.name}</code> — the
              existing user-global override path that <code>getTemplate()</code> already reads.
            </div>
            <div style={{ marginBottom: "0.4rem" }}>
              <strong>"Promote to production"</strong> activates the selected version for the next
              agent run. <strong>"Revert to default"</strong> deletes the override file so cf²
              falls back to the bundled default.
            </div>
            <div>
              Existing per-project overrides at <code>&lt;repo&gt;/cfcf-templates/{template.name}</code>{" "}
              still take precedence over the user-global override — that's the power-user escape
              hatch and isn't managed from this UI.
            </div>
          </div>

          {/* Subtle skip-link to Settings (the user might be looking for the global config). */}
          <p style={{ marginTop: "1.5rem", fontSize: "var(--text-sm)", color: "var(--color-text-muted, #888)" }}>
            Looking for adapter / model settings?{" "}
            <a
              href="#/server"
              onClick={(e) => {
                e.preventDefault();
                navigateTo("/server");
              }}
              style={{ color: "var(--color-info)" }}
            >
              Go to Settings
            </a>
            .
          </p>
        </>
      )}
    </div>
  );
}
