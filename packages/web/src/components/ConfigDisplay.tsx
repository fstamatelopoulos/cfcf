import { useEffect, useState } from "react";
import type { ProjectConfig } from "../types";
import type { NotificationChannelName, NotificationEventType } from "../types";
import { fetchGlobalConfig, saveProject } from "../api";

const ROLE_KEYS: (keyof Pick<
  ProjectConfig,
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
 * Editable per-project config tab (item 6.14). Mirrors the 5.9 global
 * settings page's structure adapted to `ProjectConfig`. Identity +
 * runtime fields (id, name, repoPath, currentIteration, status,
 * processTemplate) render read-only at the top; everything else is
 * editable and writes via `PUT /api/projects/:id`. A top banner makes
 * the scope explicit: "these override the global defaults; global
 * settings live in the top-bar Settings link."
 */
export function ConfigDisplay({
  project,
  onSaved,
}: {
  project: ProjectConfig;
  /** Called after a successful save with the returned (canonicalised) project config. */
  onSaved?: (p: ProjectConfig) => void;
}) {
  const [draft, setDraft] = useState<ProjectConfig>(() => structuredClone(project));
  const [availableAgents, setAvailableAgents] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Sync draft when the upstream project prop changes (e.g. after external refresh)
  useEffect(() => {
    setDraft(structuredClone(project));
    setSavedAt(null);
  }, [project]);

  useEffect(() => {
    fetchGlobalConfig()
      .then((cfg) => setAvailableAgents(cfg.availableAgents ?? []))
      .catch(() => setAvailableAgents([]));
  }, []);

  const isDirty = JSON.stringify(project) !== JSON.stringify(draft);
  const notificationsOverridden = !!draft.notifications;

  function update<K extends keyof ProjectConfig>(key: K, value: ProjectConfig[K]) {
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
      // explicitly clear a per-project override (treated as "inherit").
      const patch: Record<string, unknown> = {};
      const draftRec = draft as unknown as Record<string, unknown>;
      const projRec = project as unknown as Record<string, unknown>;
      for (const k of Object.keys(draftRec)) {
        const a = draftRec[k];
        const b = projRec[k];
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          patch[k] = a;
        }
      }
      // If notifications was removed (inherit), mark it null so the server
      // clears the override rather than ignoring the field.
      if (!draft.notifications && project.notifications) {
        patch.notifications = null;
      }
      const saved = await saveProject(draft.id, patch);
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
    setDraft(structuredClone(project));
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
          fontSize: "0.85rem",
          borderRadius: "4px",
        }}
      >
        These <strong>override the global defaults</strong> for this project only. Global settings live in the top-bar <strong>Settings</strong> link.
      </div>

      {error && (
        <div className="dashboard__error" style={{ marginBottom: "1rem" }}>
          {error}
        </div>
      )}

      {/* Identity + runtime (read-only) */}
      <section className="architect-review" style={{ marginBottom: "1.25rem" }}>
        <h3 className="architect-review__summary" style={{ fontSize: "1rem" }}>
          Identity
        </h3>
        <table className="config-display__table">
          <tbody>
            <InfoRow label="Project ID" value={project.id} />
            <InfoRow label="Name" value={project.name} />
            <InfoRow label="Repo path" value={project.repoPath} mono />
            {project.status && <InfoRow label="Status" value={project.status} />}
            <InfoRow
              label="Iterations completed"
              value={String(project.currentIteration || 0)}
            />
            <InfoRow label="Process template" value={project.processTemplate} />
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
                    <input
                      type="text"
                      placeholder="(use adapter default)"
                      value={agent.model ?? ""}
                      onChange={(e) => updateAgent(key, "model", e.target.value)}
                      style={{ minWidth: "12rem" }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
                    update("onStalled", e.target.value as ProjectConfig["onStalled"])
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
                      e.target.value as ProjectConfig["mergeStrategy"],
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
      <FormSection title="Behaviour flags (item 5.1)">
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
                        e.target.value as ProjectConfig["readinessGate"],
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
            Override global notifications for this project
          </label>
          {!notificationsOverridden && (
            <div style={{ color: "var(--color-text-muted)", fontSize: "0.8rem", marginTop: "0.25rem" }}>
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
          <span style={{ color: "var(--color-success)", fontSize: "0.85rem" }}>
            ✓ Saved
          </span>
        )}
        {isDirty && (
          <span style={{ color: "var(--color-text-muted)", fontSize: "0.8rem" }}>
            unsaved changes
          </span>
        )}
      </div>
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
      <h3 className="architect-review__summary" style={{ fontSize: "1rem" }}>
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
            <span style={{ color: "var(--color-text-muted)", fontSize: "0.8rem" }}>
              {hint}
            </span>
          )}
        </label>
      </td>
    </tr>
  );
}
