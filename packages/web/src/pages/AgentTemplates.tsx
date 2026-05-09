/**
 * Agents page (item 6.8): role-template management UI.
 *
 * Round 2 (item 6.8 round 2 — augmented type added):
 *
 * Two version types coexist:
 *   - "full"      → the version body REPLACES the bundled default.
 *                   Maximum flexibility; no auto-upgrade.
 *   - "augmented" → the version body is APPENDED to the bundled default
 *                   at promote/recompose time. Auto-picks-up cf² upgrades.
 *
 * Two creation entry points:
 *   - "Edit"    button → enters full-edit mode (single textarea
 *                        prefilled with the currently-selected version).
 *   - "Augment" button → enters augmented-edit mode (split view: bundled
 *                        default read-only on top, empty extension below).
 *
 * Existing-version display:
 *   - Full version    → single textarea, the version's body.
 *   - Augmented version → split view: bundled default (read-only) on top,
 *                         the version's extension on bottom (read-only or
 *                         editable depending on isEditing).
 *
 * Save actions vary by editType:
 *   - Editing existing full      → Save changes / Save as new full version
 *   - Editing existing augmented → Save changes / Save as new augmented version
 *   - Creating new full          → Save as new full version
 *   - Creating new augmented     → Save as new augmented version
 *
 * Storage + composition + auto-recompose-on-cf²-upgrade live in
 * `@cfcf/core/role-templates` (`refreshAugmentedOverrides`); this
 * component is just the UI surface.
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
  type RoleTemplateVersionType,
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
  /**
   * Body content shown in the editor.
   * - For full-type display: the entire template body.
   * - For augmented-type display: just the user's EXTENSION
   *   (the bundled default is rendered separately above it).
   */
  const [content, setContent] = useState<string>("");
  const [isEditing, setIsEditing] = useState(false);
  /**
   * What kind of edit/creation flow the user is in. Only meaningful
   * while `isEditing === true`. Set by the Edit / Augment buttons.
   * For editing existing versions it mirrors the version's type.
   */
  const [editType, setEditType] = useState<RoleTemplateVersionType>("full");
  /** True when the user clicked Augment (creates new augmented from default). */
  const [creatingNew, setCreatingNew] = useState(false);
  const [editingDirty, setEditingDirty] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Bumped after a save / delete / promote to refresh dependent data.
  const [rev, setRev] = useState(0);

  // Initial load: fetch summary list + auto-select first.
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

  // React to back/forward navigation through `?template=...`.
  useEffect(() => {
    if (!initialTemplate) return;
    if (initialTemplate === activeName) return;
    if (summaries.some((s) => s.name === initialTemplate)) {
      setActiveName(initialTemplate);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTemplate, summaries]);

  // Load full state for the active template.
  useEffect(() => {
    if (!activeName) return;
    setError(null);
    getRoleTemplate(activeName)
      .then((t) => {
        setTemplate(t);
        setSelectedVersionId(t.currentVersionId);
        // Fetch the body for the currently-promoted version (just the
        // extension if it's augmented; the full body otherwise).
        return loadBodyForSelection(t, t.currentVersionId);
      })
      .then(() => {
        setIsEditing(false);
        setEditingDirty(false);
        setCreatingNew(false);
      })
      .catch((e) => setError(String(e)));

    if (window.location.hash !== `#/agents?template=${encodeURIComponent(activeName)}`) {
      window.history.replaceState(null, "", `#/agents?template=${encodeURIComponent(activeName)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeName, rev]);

  // When the user picks a different version (without editing), re-fetch
  // the body for that version.
  useEffect(() => {
    if (!activeName || !template) return;
    if (isEditing) return; // don't blow away in-flight edits
    loadBodyForSelection(template, selectedVersionId).catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVersionId, activeName]);

  async function loadBodyForSelection(t: RoleTemplateFull, versionId: string): Promise<void> {
    if (versionId === DEFAULT_VERSION_ID) {
      setContent(t.defaultContent);
      return;
    }
    const r = await getRoleTemplateVersionContent(t.name, versionId);
    setContent(r.content);
  }

  // --- Action handlers ---

  function startEdit() {
    if (!template) return;
    const v = template.versions.find((x) => x.id === selectedVersionId);
    setEditType(v ? v.type : "full");
    setCreatingNew(selectedVersionId === DEFAULT_VERSION_ID); // Edit on default = creating new
    setIsEditing(true);
    setEditingDirty(false);
    setStatusMsg(null);
  }

  function startAugment() {
    if (!template) return;
    if (editingDirty && !window.confirm("Discard unsaved changes?")) return;
    // Augment ALWAYS creates a new augmented version on top of the
    // bundled default — regardless of which version is currently
    // selected. This keeps the upgrade-friendly contract: augmented
    // versions ride along on whatever cf² ships next.
    setSelectedVersionId(DEFAULT_VERSION_ID);
    setEditType("augmented");
    setCreatingNew(true);
    setIsEditing(true);
    setEditingDirty(false);
    setContent(""); // empty extension; user types their additions
    setStatusMsg(null);
  }

  async function handleSaveAsNew() {
    if (!activeName) return;
    const promptText =
      editType === "augmented"
        ? "Label for this augmented version (e.g. 'jira-hint', 'team-style')"
        : "Label for this version (e.g. 'stricter judge', 'opus run')";
    const label = window.prompt(promptText);
    if (!label || !label.trim()) return;
    setBusy(true);
    setStatusMsg(null);
    try {
      const v = await createRoleTemplateVersion(activeName, {
        label: label.trim(),
        content,
        type: editType,
      });
      setStatusMsg(
        `✓ Saved as "${v.label}" (${v.type}). Not yet promoted — click Promote to make it live.`,
      );
      setIsEditing(false);
      setEditingDirty(false);
      setCreatingNew(false);
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
          : "✓ Saved. Promote this version to make it live.",
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
          : "✓ Promoted to production. The next agent run will use this version.",
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
    if (selectedVersionId === DEFAULT_VERSION_ID) return;
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

  // --- Derived state ---

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
    return v ? `${v.label} (${v.type})` : template.currentVersionId;
  })();

  const selectionIsPromoted = template?.currentVersionId === selectedVersionId;
  const selectionIsDefault = selectedVersionId === DEFAULT_VERSION_ID;
  const selectedVersion: RoleTemplateVersion | undefined = template?.versions.find(
    (x) => x.id === selectedVersionId,
  );
  /**
   * Type the editor should render in.
   * - When editing: editType (set by the Edit / Augment button).
   * - When viewing: the selected version's type, defaulting to "full"
   *   for the bundled default (single textarea read-only).
   */
  const displayType: RoleTemplateVersionType = isEditing
    ? editType
    : (selectedVersion?.type ?? "full");
  const showSplitView = displayType === "augmented";
  // The textarea(s) are editable only in edit mode AND when the user
  // is actually authoring the body (default tab is "view-only" for the
  // standard template even in augment mode — that's what the read-only
  // top panel is).
  const extensionEditable = isEditing && displayType === "augmented";
  const fullEditable = isEditing && displayType === "full";

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
                  title="A custom version is currently promoted"
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
              {creatingNew && isEditing && (
                <span
                  style={{
                    marginLeft: "0.5rem",
                    fontSize: "var(--text-sm)",
                    color: "var(--color-accent, #4a8ee6)",
                    fontWeight: "normal",
                  }}
                >
                  • creating new {editType} version
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
              (cf² writes the composed override file here when a non-default version is promoted;
              deletes it when you revert.)
            </span>
          </p>

          {/* Status message — moved ABOVE the version selector so the
              "Promote to make it live" hint is below the action buttons
              when the user reads it. */}
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
              style={{ minWidth: "20rem" }}
            >
              <option value={DEFAULT_VERSION_ID}>
                Default (built-in)
                {template.currentVersionId === DEFAULT_VERSION_ID ? " — promoted" : ""}
              </option>
              {template.versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} — {v.type} ({new Date(v.savedAt).toLocaleString()})
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
                  onClick={startEdit}
                  title={
                    selectionIsDefault
                      ? "Fork the bundled default into a new full version"
                      : selectedVersion?.type === "augmented"
                      ? "Edit this augmented version's extension"
                      : "Edit this full version's body"
                  }
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn--small btn--secondary"
                  disabled={busy}
                  onClick={startAugment}
                  title="Add custom directions on top of the bundled default (auto-upgrades when cf² ships a new default)"
                >
                  Augment
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
                {!creatingNew && !selectionIsDefault && (
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
                  disabled={busy || (!editingDirty && !creatingNew)}
                  onClick={handleSaveAsNew}
                  title={
                    editType === "augmented"
                      ? "Save as a new augmented version (extension only — auto-upgrades with cf²)"
                      : "Save as a new full version (frozen — does not auto-upgrade)"
                  }
                >
                  Save as new {editType} version
                </button>
                <button
                  type="button"
                  className="btn btn--small btn--secondary"
                  disabled={busy}
                  onClick={() => {
                    if (editingDirty && !window.confirm("Discard unsaved changes?")) return;
                    setIsEditing(false);
                    setEditingDirty(false);
                    setCreatingNew(false);
                    setRev((n) => n + 1);
                  }}
                >
                  Cancel
                </button>
              </>
            )}
          </div>

          {/* Forked-from-cf²-vX.Y.Z badge for full versions */}
          {!isEditing && selectedVersion?.type === "full" && selectedVersion.cfcfVersion && (
            <p
              style={{
                marginTop: "-0.25rem",
                marginBottom: "0.75rem",
                fontSize: "var(--text-sm)",
                color: "var(--color-text-muted, #888)",
              }}
            >
              ℹ Forked from cf² <code>v{selectedVersion.cfcfVersion}</code>'s bundled default. Full
              versions don't auto-upgrade — compare against the latest <strong>Default
              (built-in)</strong> if cf² has shipped a newer template since.
            </p>
          )}

          {/* Editor area — split for augmented, single for full */}
          {showSplitView ? (
            <SplitEditor
              defaultContent={template.defaultContent}
              extension={content}
              extensionEditable={extensionEditable}
              onExtensionChange={(next) => {
                setContent(next);
                setEditingDirty(true);
              }}
              creatingNew={creatingNew}
            />
          ) : (
            <FullEditor
              content={content}
              editable={fullEditable}
              onChange={(next) => {
                setContent(next);
                setEditingDirty(true);
              }}
              showFullEditFromDefaultHint={isEditing && selectionIsDefault && !creatingNew}
            />
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
            <strong style={{ display: "block", marginBottom: "0.4rem" }}>How this works</strong>
            <div style={{ marginBottom: "0.4rem" }}>
              <strong>Two ways to customise a role.</strong> <em>Edit</em> opens a single editor
              prefilled with the selected version's content; saving creates a <strong>full</strong>
              {" "}version that <strong>replaces</strong> the bundled default entirely. <em>Augment</em>
              {" "}keeps cf²'s default read-only and lets you add a section below it; saving creates
              an <strong>augmented</strong> version. The harness composes
              {" "}<code>&lt;default&gt; + separator + &lt;your additions&gt;</code> at promote
              time, and re-composes on every server boot — so when cf² ships a new default,
              your augmented additions automatically ride along. Full versions don't migrate.
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

// --- Sub-components ---

/**
 * Single-textarea editor for full-type versions (and the bundled
 * default, which renders here as a read-only full template).
 */
function FullEditor({
  content,
  editable,
  onChange,
  showFullEditFromDefaultHint,
}: {
  content: string;
  editable: boolean;
  onChange: (next: string) => void;
  showFullEditFromDefaultHint: boolean;
}) {
  return (
    <>
      <textarea
        value={content}
        readOnly={!editable}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        style={{
          width: "100%",
          // Match the augmented-mode "cf² standard template (read-only)"
          // panel height (~25vh). Users can drag taller via the
          // resize handle when editing a full template.
          minHeight: "25vh",
          fontFamily: "var(--font-mono, monospace)",
          fontSize: "var(--text-sm)",
          padding: "0.75rem",
          border: "1px solid var(--color-border, #444)",
          borderRadius: "4px",
          background: editable
            ? "var(--color-bg)"
            : "var(--color-bg-muted, var(--color-bg))",
          color: "var(--color-text)",
          resize: "vertical",
        }}
      />
      {showFullEditFromDefaultHint && (
        <p
          style={{
            marginTop: "0.5rem",
            fontSize: "var(--text-sm)",
            color: "var(--color-text-muted, #888)",
          }}
        >
          You're editing a copy of the bundled default. Click <strong>Save as new full
          version</strong> to fork your changes — the cf²-shipped default itself stays untouched
          and remains available in the dropdown.
        </p>
      )}
    </>
  );
}

/**
 * Split editor for augmented-type versions: bundled default at top
 * (always read-only — that's the whole point of the type) + extension
 * textarea at bottom (editable when `extensionEditable`).
 *
 * Shorter standard panel by design (~25vh) so the extension editor
 * has visual prominence, since that's what the user is actually
 * working with.
 */
function SplitEditor({
  defaultContent,
  extension,
  extensionEditable,
  onExtensionChange,
  creatingNew,
}: {
  defaultContent: string;
  extension: string;
  extensionEditable: boolean;
  onExtensionChange: (next: string) => void;
  creatingNew: boolean;
}) {
  return (
    <>
      <div
        style={{
          marginBottom: "0.5rem",
          fontSize: "var(--text-sm)",
          color: "var(--color-text-muted, #888)",
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "0.5rem",
          flexWrap: "wrap",
        }}
      >
        <strong style={{ color: "var(--color-text)" }}>cf² standard template (read-only)</strong>
        <span>
          Updated automatically when cf² ships a new default; your extension below rides along.
        </span>
      </div>
      <textarea
        value={defaultContent}
        readOnly
        spellCheck={false}
        style={{
          width: "100%",
          minHeight: "25vh",
          fontFamily: "var(--font-mono, monospace)",
          fontSize: "var(--text-sm)",
          padding: "0.75rem",
          border: "1px solid var(--color-border, #444)",
          borderRadius: "4px",
          background: "var(--color-bg-muted, var(--color-bg))",
          color: "var(--color-text)",
          resize: "vertical",
          marginBottom: "1rem",
        }}
      />
      <div
        style={{
          marginBottom: "0.5rem",
          fontSize: "var(--text-sm)",
          color: "var(--color-text-muted, #888)",
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "0.5rem",
          flexWrap: "wrap",
        }}
      >
        <strong style={{ color: "var(--color-text)" }}>
          Your custom additions{" "}
          {extensionEditable ? "" : "(read-only)"}
        </strong>
        <span>
          Appended after the standard template at promote time + every server boot.
        </span>
      </div>
      <textarea
        value={extension}
        readOnly={!extensionEditable}
        onChange={(e) => onExtensionChange(e.target.value)}
        spellCheck={false}
        placeholder={
          creatingNew
            ? "Write your custom directions here. Examples:\n• Always cite the Linear ticket ID in summaries.\n• Use AAA test naming.\n• Prefer functional patterns over classes."
            : ""
        }
        style={{
          width: "100%",
          minHeight: "30vh",
          fontFamily: "var(--font-mono, monospace)",
          fontSize: "var(--text-sm)",
          padding: "0.75rem",
          border: "1px solid var(--color-border, #444)",
          borderRadius: "4px",
          background: extensionEditable
            ? "var(--color-bg)"
            : "var(--color-bg-muted, var(--color-bg))",
          color: "var(--color-text)",
          resize: "vertical",
        }}
      />
    </>
  );
}
