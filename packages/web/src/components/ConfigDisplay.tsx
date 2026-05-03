import { useEffect, useState } from "react";
import type { WorkspaceConfig } from "../types";
import type { NotificationChannelName, NotificationEventType } from "../types";
import { fetchAgentModels, fetchGlobalConfig, saveWorkspace } from "../api";
import { AgentModelSelect } from "./AgentModelSelect";
import { ClioProjectDialog } from "./ClioProjectDialog";
import { DeleteWorkspaceDialog } from "./DeleteWorkspaceDialog";
import { navigateTo } from "../hooks/useRoute";

const ROLE_KEYS: (keyof Pick<
  WorkspaceConfig,
  "devAgent" | "judgeAgent" | "architectAgent" | "documenterAgent" | "reflectionAgent"
>)[] = ["devAgent", "judgeAgent", "architectAgent", "documenterAgent", "reflectionAgent"];

const ROLE_LABEL: Record<string, string> = {
  devAgent: "Dev",
  judgeAgent: "Judge",
  architectAgent: "Architect",
  documenterAgent: "Documenter",
  reflectionAgent: "Reflection",
};

const NOTIFICATION_EVENTS: NotificationEventType[] = [
  "loop.paused",
  "loop.completed",
  "agent.failed",
];
const NOTIFICATION_CHANNELS: NotificationChannelName[] = [
  "terminal-bell",
  "macos",
  "linux",
  "log",
];

/**
 * Editable per-workspace config tab (item 6.14). Mirrors the 5.9 global
 * settings page's structure adapted to `WorkspaceConfig`. Identity +
 * runtime fields (id, name, repoPath, currentIteration, status,
 * processTemplate) render read-only at the top; everything else is
 * editable and writes via `PUT /api/workspaces/:id`. A top banner makes
 * the scope explicit: "these override the global defaults; global
 * settings live in the top-bar Settings link."
 */
export function ConfigDisplay({
  workspace,
  onSaved,
}: {
  workspace: WorkspaceConfig;
  /** Called after a successful save with the returned (canonicalised) workspace config. */
  onSaved?: (w: WorkspaceConfig) => void;
}) {
  const [draft, setDraft] = useState<WorkspaceConfig>(() => structuredClone(workspace));
  const [availableAgents, setAvailableAgents] = useState<string[]>([]);
  // 6.26: per-adapter model registry, fetched once on mount. Used by
  // AgentModelSelect to populate the model dropdown for each role's
  // currently-chosen adapter.
  const [agentModels, setAgentModels] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [clioDialogOpen, setClioDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Sync draft when the upstream workspace prop changes (e.g. after external refresh)
  useEffect(() => {
    setDraft(structuredClone(workspace));
    setSavedAt(null);
  }, [workspace]);

  useEffect(() => {
    fetchGlobalConfig()
      .then((cfg) => setAvailableAgents(cfg.availableAgents ?? []))
      .catch(() => setAvailableAgents([]));
    fetchAgentModels()
      .then((res) => setAgentModels(res.adapters))
      .catch(() => setAgentModels({}));
  }, []);

  const isDirty = JSON.stringify(workspace) !== JSON.stringify(draft);
  const notificationsOverridden = !!draft.notifications;

  function update<K extends keyof WorkspaceConfig>(key: K, value: WorkspaceConfig[K]) {
    setDraft({ ...draft, [key]: value });
    setSavedAt(null);
  }

  function updateAgent(
    roleKey: typeof ROLE_KEYS[number],
    field: "adapter" | "model",
    value: string,
  ) {
    const current = draft[roleKey] ?? { adapter: draft.devAgent.adapter };
    const next = { ...current, [field]: value };
    if (field === "model" && value === "") {
      delete (next as { model?: string }).model;
    }
    setDraft({ ...draft, [roleKey]: next });
    setSavedAt(null);
  }

  function toggleNotificationsOverride(override: boolean) {
    if (override) {
      // Start an override with sensible defaults (enabled + log channel only)
      setDraft({
        ...draft,
        notifications: {
          enabled: true,
          events: {
            "loop.paused": ["terminal-bell", "log"],
            "loop.completed": ["terminal-bell", "log"],
            "agent.failed": ["log"],
          },
        },
      });
    } else {
      // Clear the override -- inherit global
      const next = { ...draft };
      delete next.notifications;
      setDraft(next);
    }
    setSavedAt(null);
  }

  function updateNotificationEnabled(enabled: boolean) {
    if (!draft.notifications) return;
    setDraft({
      ...draft,
      notifications: { ...draft.notifications, enabled },
    });
    setSavedAt(null);
  }

  function toggleNotificationChannel(
    event: NotificationEventType,
    channel: NotificationChannelName,
  ) {
    if (!draft.notifications) return;
    const current = draft.notifications.events[event] ?? [];
    const next = current.includes(channel)
      ? current.filter((c) => c !== channel)
      : [...current, channel];
    setDraft({
      ...draft,
      notifications: {
        ...draft.notifications,
        events: { ...draft.notifications.events, [event]: next },
      },
    });
    setSavedAt(null);
  }

  async function onSave() {
    setSaving(true);
    setError(null);
    try {
      // Build patch of changed fields. Send `notifications: null` to
      // explicitly clear a per-workspace override (treated as "inherit").
      const patch: Record<string, unknown> = {};
      const draftRec = draft as unknown as Record<string, unknown>;
      const wsRec = workspace as unknown as Record<string, unknown>;
      for (const k of Object.keys(draftRec)) {
        const a = draftRec[k];
        const b = wsRec[k];
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          patch[k] = a;
        }
      }
      // If notifications was removed (inherit), mark it null so the server
      // clears the override rather than ignoring the field.
      if (!draft.notifications && workspace.notifications) {
        patch.notifications = null;
      }
      const saved = await saveWorkspace(draft.id, patch);
      setDraft(structuredClone(saved));
      setSavedAt(Date.now());
      onSaved?.(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function onCancel() {
    setDraft(structuredClone(workspace));
    setError(null);
    setSavedAt(null);
  }

  return (
    <div className="dashboard">
      <div
        style={{
          padding: "0.75rem 1rem",
          marginBottom: "1rem",
          background: "color-mix(in srgb, var(--color-info) 12%, transparent)",
          borderLeft: "3px solid var(--color-info)",
          color: "var(--color-text)",
          fontSize: "var(--text-sm)",
          borderRadius: "4px",
        }}
      >
        These <strong>override the global defaults</strong> for this workspace only. Global settings live in the top-bar <strong>Settings</strong> link.
      </div>

      {error && (
        <div className="dashboard__error" style={{ marginBottom: "1rem" }}>
          {error}
        </div>
      )}

      {/* Identity + runtime (read-only, except Clio Project which is changed via a dedicated dialog) */}
      <section className="architect-review" style={{ marginBottom: "1.25rem" }}>
        <h3 className="section-title" style={{ fontSize: "1rem" }}>
          Identity
        </h3>
        <table className="config-display__table">
          <tbody>
            <InfoRow label="Workspace ID" value={workspace.id} />
            <InfoRow label="Name" value={workspace.name} />
            <InfoRow label="Repo path" value={workspace.repoPath} mono />
            {workspace.status && <InfoRow label="Status" value={workspace.status} />}
            <InfoRow
              label="Iterations completed"
              value={String(workspace.currentIteration || 0)}
            />
            <InfoRow label="Process template" value={workspace.processTemplate} />
            {/* Clio Project: shown read-only with an inline change button.
                The reassignment uses a separate endpoint
                (PUT /api/workspaces/:id/clio-project) because it can
                migrate historical docs as a side-effect, so it doesn't
                belong in the bulk-save patch flow below. */}
            <tr>
              <th>Clio Project</th>
              <td>
                <span style={{ marginRight: "0.5rem" }}>{workspace.clioProject ?? "(none)"}</span>
                <button
                  className="btn btn--small btn--secondary"
                  onClick={() => setClioDialogOpen(true)}
                >
                  Change…
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* Editable: remote URL */}
      {/* Agent roles */}
      <FormSection title="Agent roles">
        <table className="config-display__table">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Role</th>
              <th style={{ textAlign: "left" }}>Adapter</th>
              <th style={{ textAlign: "left" }}>Model (optional)</th>
            </tr>
          </thead>
          <tbody>
            {ROLE_KEYS.map((key) => {
              const agent = draft[key] ?? { adapter: draft.devAgent.adapter };
              return (
                <tr key={key}>
                  <th>{ROLE_LABEL[key]}</th>
                  <td>
                    <select
                      value={agent.adapter}
                      onChange={(e) => updateAgent(key, "adapter", e.target.value)}
                    >
                      {availableAgents.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                      {!availableAgents.includes(agent.adapter) && (
                        <option value={agent.adapter}>
                          {agent.adapter} (not detected)
                        </option>
                      )}
                    </select>
                  </td>
                  <td>
                    <AgentModelSelect
                      adapter={agent.adapter}
                      models={agentModels[agent.adapter] ?? []}
                      value={agent.model ?? ""}
                      onChange={(v) => updateAgent(key, "model", v)}
                      minWidth="12rem"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p
          style={{
            marginTop: "0.75rem",
            marginBottom: 0,
            fontSize: "var(--text-sm)",
            color: "var(--color-text-muted, #888)",
            lineHeight: 1.5,
          }}
        >
          <strong>Product Architect</strong> (<code>cfcf spec</code>) and{" "}
          <strong>Help Assistant</strong> (<code>cfcf help assistant</code>) are
          configured globally — see{" "}
          <a href="#/server" style={{ color: "var(--color-info)" }}>
            Settings
          </a>
          . They run once per task (PA: spec authoring at the start of a
          workspace; HA: ad-hoc cf² Q&amp;A) and intentionally aren't
          per-workspace overridable; pick one agent you trust for those
          workloads and use it everywhere.
        </p>
      </FormSection>

      {/* Iteration defaults + loop policy */}
      <FormSection title="Iteration defaults">
        <table className="config-display__table">
          <tbody>
            <NumberRow
              label="Max iterations per run"
              value={draft.maxIterations}
              min={1}
              onChange={(n) => update("maxIterations", n)}
            />
            <NumberRow
              label="Pause every N iterations (0 = never)"
              value={draft.pauseEvery}
              min={0}
              onChange={(n) => update("pauseEvery", n)}
            />
            <NumberRow
              label="Reflection safeguard"
              value={draft.reflectSafeguardAfter ?? 3}
              min={1}
              onChange={(n) => update("reflectSafeguardAfter", n)}
            />
            <tr>
              <th>On stalled</th>
              <td>
                <select
                  value={draft.onStalled}
                  onChange={(e) =>
                    update("onStalled", e.target.value as WorkspaceConfig["onStalled"])
                  }
                >
                  <option value="continue">continue</option>
                  <option value="stop">stop</option>
                  <option value="alert">alert</option>
                </select>
              </td>
            </tr>
            <tr>
              <th>Merge strategy</th>
              <td>
                <select
                  value={draft.mergeStrategy}
                  onChange={(e) =>
                    update(
                      "mergeStrategy",
                      e.target.value as WorkspaceConfig["mergeStrategy"],
                    )
                  }
                >
                  <option value="auto">auto</option>
                  <option value="pr">pr</option>
                </select>
              </td>
            </tr>
          </tbody>
        </table>
      </FormSection>

      {/* Behaviour flags (item 5.1) */}
      <FormSection title="Behaviour flags">
        <table className="config-display__table">
          <tbody>
            <CheckboxRow
              label="autoReviewSpecs"
              hint="When on, Start Loop first runs the Solution Architect. Review button hidden; a leading 'Review (agent)' step appears in the phase indicator."
              checked={!!draft.autoReviewSpecs}
              onChange={(v) => update("autoReviewSpecs", v)}
            />
            {draft.autoReviewSpecs && (
              <tr>
                <th>readinessGate</th>
                <td>
                  <select
                    value={draft.readinessGate ?? "blocked"}
                    onChange={(e) =>
                      update(
                        "readinessGate",
                        e.target.value as WorkspaceConfig["readinessGate"],
                      )
                    }
                  >
                    <option value="never">never (proceed regardless)</option>
                    <option value="blocked">blocked (stop only on BLOCKED)</option>
                    <option value="needs_refinement_or_blocked">
                      needs_refinement_or_blocked (strict)
                    </option>
                  </select>
                </td>
              </tr>
            )}
            <CheckboxRow
              label="autoDocumenter"
              hint="When on, the loop runs the Documenter on SUCCESS. Off → skipped; run `cfcf document` manually."
              checked={draft.autoDocumenter !== false}
              onChange={(v) => update("autoDocumenter", v)}
            />
            <CheckboxRow
              label="cleanupMergedBranches"
              hint="Delete the cfcf/iteration-N branch after a successful auto-merge. Default off (kept for audit)."
              checked={!!draft.cleanupMergedBranches}
              onChange={(v) => update("cleanupMergedBranches", v)}
            />
          </tbody>
        </table>
      </FormSection>

      {/* Notifications override */}
      <FormSection title="Notifications">
        <div style={{ marginBottom: "0.75rem" }}>
          <label>
            <input
              type="checkbox"
              checked={notificationsOverridden}
              onChange={(e) => toggleNotificationsOverride(e.target.checked)}
            />{" "}
            Override global notifications for this workspace
          </label>
          {!notificationsOverridden && (
            <div style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)", marginTop: "0.25rem" }}>
              Currently inheriting the global notification settings.
            </div>
          )}
        </div>
        {notificationsOverridden && draft.notifications && (
          <>
            <div style={{ marginBottom: "0.75rem" }}>
              <label>
                <input
                  type="checkbox"
                  checked={draft.notifications.enabled !== false}
                  onChange={(e) => updateNotificationEnabled(e.target.checked)}
                />{" "}
                Enable notifications
              </label>
            </div>
            {draft.notifications.enabled !== false && (
              <table className="config-display__table">
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>Event</th>
                    {NOTIFICATION_CHANNELS.map((c) => (
                      <th key={c} style={{ textAlign: "center" }}>
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {NOTIFICATION_EVENTS.map((ev) => {
                    const channels = draft.notifications!.events[ev] ?? [];
                    return (
                      <tr key={ev}>
                        <th>
                          <code>{ev}</code>
                        </th>
                        {NOTIFICATION_CHANNELS.map((c) => (
                          <td key={c} style={{ textAlign: "center" }}>
                            <input
                              type="checkbox"
                              checked={channels.includes(c)}
                              onChange={() => toggleNotificationChannel(ev, c)}
                            />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
      </FormSection>

      <div
        style={{
          display: "flex",
          gap: "0.75rem",
          alignItems: "center",
          marginTop: "1rem",
        }}
      >
        <button
          className="btn btn--primary"
          disabled={!isDirty || saving}
          onClick={onSave}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          className="btn btn--secondary"
          disabled={!isDirty || saving}
          onClick={onCancel}
        >
          Cancel
        </button>
        {savedAt && !isDirty && (
          <span style={{ color: "var(--color-success)", fontSize: "var(--text-sm)" }}>
            ✓ Saved
          </span>
        )}
        {isDirty && (
          <span style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
            unsaved changes
          </span>
        )}
      </div>

      {/* Danger zone (item 6.12). Sits at the very bottom because the
          consequence is irreversible and we don't want it on the eye-line
          while users are editing routine config. */}
      <section style={{ marginTop: "2rem" }}>
        <div className="danger-zone">
          <h3 className="danger-zone__title">Delete workspace</h3>
          <div className="danger-zone__body">
            Removes <strong>{workspace.name}</strong> from cfcf's registry and per-workspace state.
            The repo folder at <code>{workspace.repoPath}</code> is <strong>not touched</strong>.
            iteration branches and ingested Clio docs are also left alone.
          </div>
          <button
            className="btn btn--danger btn--small"
            onClick={() => setDeleteDialogOpen(true)}
          >
            Delete workspace…
          </button>
        </div>
      </section>

      <ClioProjectDialog
        open={clioDialogOpen}
        onClose={() => setClioDialogOpen(false)}
        workspace={workspace}
        onSaved={(newProject) => {
          // Optimistic refresh: surface the new value immediately by
          // calling the parent's onSaved with a patched workspace
          // (server is the source of truth, but the workspace is
          // re-fetched on next poll regardless).
          onSaved?.({ ...workspace, clioProject: newProject });
        }}
      />
      <DeleteWorkspaceDialog
        open={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
        workspace={workspace}
        onDeleted={() => navigateTo("/")}
      />
    </div>
  );
}

function InfoRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <tr>
      <th>{label}</th>
      <td className={mono ? "config-display__path" : undefined}>{value}</td>
    </tr>
  );
}

function FormSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="architect-review" style={{ marginBottom: "1.25rem" }}>
      <h3 className="section-title" style={{ fontSize: "1rem" }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function NumberRow({
  label,
  value,
  min,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  onChange: (n: number) => void;
}) {
  return (
    <tr>
      <th>{label}</th>
      <td>
        <input
          type="number"
          min={min}
          value={value}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            if (!Number.isNaN(n)) onChange(n);
          }}
          style={{ width: "6rem" }}
        />
      </td>
    </tr>
  );
}

function CheckboxRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <tr>
      <th>
        <code>{label}</code>
      </th>
      <td>
        <label style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            style={{ marginTop: "0.25rem" }}
          />
          {hint && (
            <span style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
              {hint}
            </span>
          )}
        </label>
      </td>
    </tr>
  );
}
