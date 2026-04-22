import { useEffect, useState } from "react";
import {
  fetchServerStatus,
  fetchGlobalConfig,
  saveGlobalConfig,
  type ServerStatus,
  type GlobalConfig,
} from "../api";
import { navigateTo } from "../hooks/useRoute";
import type { NotificationChannelName, NotificationEventType } from "../types";

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  return `${h}h ${m % 60}m`;
}

const ROLE_KEYS: (keyof Pick<
  GlobalConfig,
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
 * Editable global settings page (item 5.9). Reads `/api/config`, lets the
 * user edit everything that `cfcf config edit` covers, and writes back via
 * `PUT /api/config`. Agent adapters are constrained to the detected
 * `availableAgents` list (fixed during `cfcf init`). Server-owned fields
 * (version, permissionsAcknowledged, availableAgents) are not editable.
 * Per-workspace overrides live in each workspace's Config tab (editable as
 * of v0.7.4).
 */
export function ServerInfo() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [original, setOriginal] = useState<GlobalConfig | null>(null);
  const [draft, setDraft] = useState<GlobalConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Initial + periodic fetch of read-only server status (version, uptime, etc.)
  useEffect(() => {
    const load = () => {
      fetchServerStatus().then(setStatus).catch((e) => setError(String(e)));
    };
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, []);

  // Initial fetch of the config (editable). Only fetched once; the user
  // is the source of truth while editing.
  useEffect(() => {
    fetchGlobalConfig()
      .then((cfg) => {
        setOriginal(cfg);
        setDraft(structuredClone(cfg));
      })
      .catch((e) => setError(String(e)));
  }, []);

  const isDirty =
    !!original && !!draft && JSON.stringify(original) !== JSON.stringify(draft);

  function update<K extends keyof GlobalConfig>(key: K, value: GlobalConfig[K]) {
    if (!draft) return;
    setDraft({ ...draft, [key]: value });
    setSavedAt(null);
  }

  function updateAgent(
    roleKey: typeof ROLE_KEYS[number],
    field: "adapter" | "model",
    value: string,
  ) {
    if (!draft) return;
    const current = draft[roleKey] ?? { adapter: draft.devAgent.adapter };
    const next = { ...current, [field]: value };
    // Empty model string -> drop the field so it reads as "default model"
    if (field === "model" && value === "") {
      delete (next as { model?: string }).model;
    }
    setDraft({ ...draft, [roleKey]: next });
    setSavedAt(null);
  }

  function updateNotificationEnabled(enabled: boolean) {
    if (!draft) return;
    const n = draft.notifications ?? { enabled: true, events: {} };
    setDraft({ ...draft, notifications: { ...n, enabled } });
    setSavedAt(null);
  }

  function toggleNotificationChannel(
    event: NotificationEventType,
    channel: NotificationChannelName,
  ) {
    if (!draft) return;
    const n = draft.notifications ?? { enabled: true, events: {} };
    const current = n.events[event] ?? [];
    const next = current.includes(channel)
      ? current.filter((c) => c !== channel)
      : [...current, channel];
    setDraft({
      ...draft,
      notifications: { ...n, events: { ...n.events, [event]: next } },
    });
    setSavedAt(null);
  }

  async function onSave() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveGlobalConfig(draft);
      setOriginal(saved);
      setDraft(structuredClone(saved));
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function onCancel() {
    if (!original) return;
    setDraft(structuredClone(original));
    setError(null);
    setSavedAt(null);
  }

  return (
    <div className="dashboard">
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: "0.5rem",
        }}
      >
        <h2 className="dashboard__title" style={{ margin: 0 }}>
          Server Info and Global Settings
        </h2>
        <button
          className="btn btn--small btn--secondary"
          onClick={() => navigateTo("/")}
        >
          ← back to workspaces
        </button>
      </div>

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
        This page edits the <strong>global defaults</strong>. To override any of these for a specific workspace, open that workspace and edit its <strong>Config</strong> tab — per-workspace settings take precedence over the global defaults.
      </div>

      {error && (
        <div className="dashboard__error" style={{ marginBottom: "1rem" }}>
          {error}
        </div>
      )}

      {/* Server status (truly read-only runtime info) */}
      <section className="architect-review" style={{ marginBottom: "1.5rem" }}>
        <h3 className="architect-review__summary" style={{ fontSize: "1rem" }}>
          Server
        </h3>
        {status ? (
          <table className="project-history__table">
            <tbody>
              <InfoRow label="Status" value={status.status} />
              <InfoRow label="Version" value={`v${status.version}`} />
              <InfoRow label="Port" value={String(status.port)} />
              <InfoRow label="PID" value={String(status.pid)} />
              <InfoRow label="Uptime" value={formatUptime(status.uptime)} />
              <InfoRow
                label="Available agents"
                value={
                  status.availableAgents.length > 0
                    ? status.availableAgents.join(", ")
                    : "(none detected — run `cfcf init --force` to re-scan)"
                }
              />
              <InfoRow label="Configured" value={status.configured ? "yes" : "no"} />
            </tbody>
          </table>
        ) : (
          <div style={{ color: "var(--color-text-muted)" }}>Loading…</div>
        )}
      </section>

      {/* Editable sections */}
      {draft && (
        <>
          <FormSection title="Agent roles">
            <table className="project-history__table">
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
                    <tr key={key} className="project-history__row">
                      <td className="project-history__time" style={{ minWidth: "8rem" }}>
                        {ROLE_LABEL[key]}
                      </td>
                      <td>
                        <select
                          value={agent.adapter}
                          onChange={(e) => updateAgent(key, "adapter", e.target.value)}
                        >
                          {(draft.availableAgents ?? []).map((a) => (
                            <option key={a} value={a}>
                              {a}
                            </option>
                          ))}
                          {/* include the current value even if it's no longer in availableAgents (don't silently drop it) */}
                          {!(draft.availableAgents ?? []).includes(agent.adapter) && (
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

          <FormSection title="Iteration defaults">
            <table className="project-history__table">
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
                  label="Reflection safeguard (consecutive opt-outs before forced reflect)"
                  value={draft.reflectSafeguardAfter ?? 3}
                  min={1}
                  onChange={(n) => update("reflectSafeguardAfter", n)}
                />
              </tbody>
            </table>
          </FormSection>

          <FormSection title="Behaviour flags (item 5.1)">
            <table className="project-history__table">
              <tbody>
                <CheckboxRow
                  label="autoReviewSpecs"
                  hint="When on, Start Loop first runs the Solution Architect. Review button hidden in workspace detail; a leading 'Review (agent)' step appears in the phase indicator."
                  checked={!!draft.autoReviewSpecs}
                  onChange={(v) => update("autoReviewSpecs", v)}
                />
                {draft.autoReviewSpecs && (
                  <tr className="project-history__row">
                    <td className="project-history__time" style={{ minWidth: "10rem" }}>
                      readinessGate
                    </td>
                    <td>
                      <select
                        value={draft.readinessGate ?? "blocked"}
                        onChange={(e) =>
                          update(
                            "readinessGate",
                            e.target.value as GlobalConfig["readinessGate"],
                          )
                        }
                      >
                        <option value="never">never (proceed regardless)</option>
                        <option value="blocked">blocked (stop only on BLOCKED)</option>
                        <option value="needs_refinement_or_blocked">
                          needs_refinement_or_blocked (strict: stop on anything but READY)
                        </option>
                      </select>
                    </td>
                  </tr>
                )}
                <CheckboxRow
                  label="autoDocumenter"
                  hint="When on, the loop runs the Documenter on SUCCESS before entering its terminal state. Off → skipped; run `cfcf document` manually."
                  checked={draft.autoDocumenter !== false}
                  onChange={(v) => update("autoDocumenter", v)}
                />
                <CheckboxRow
                  label="cleanupMergedBranches"
                  hint="When on, delete the cfcf/iteration-N branch after a successful auto-merge. Default off (kept for audit)."
                  checked={!!draft.cleanupMergedBranches}
                  onChange={(v) => update("cleanupMergedBranches", v)}
                />
              </tbody>
            </table>
          </FormSection>

          <FormSection title="Notifications">
            <div style={{ marginBottom: "0.75rem" }}>
              <label>
                <input
                  type="checkbox"
                  checked={draft.notifications?.enabled !== false}
                  onChange={(e) => updateNotificationEnabled(e.target.checked)}
                />{" "}
                Enable notifications
              </label>
            </div>
            {draft.notifications?.enabled !== false && (
              <table className="project-history__table">
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
                    const channels =
                      draft.notifications?.events[ev] ?? [];
                    return (
                      <tr key={ev} className="project-history__row">
                        <td className="project-history__time" style={{ minWidth: "10rem" }}>
                          <code>{ev}</code>
                        </td>
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
              <span
                style={{
                  color: "var(--color-success)",
                  fontSize: "0.85rem",
                }}
              >
                ✓ Saved
              </span>
            )}
            {isDirty && (
              <span
                style={{
                  color: "var(--color-text-muted)",
                  fontSize: "0.8rem",
                }}
              >
                unsaved changes
              </span>
            )}
          </div>

          <div
            style={{
              marginTop: "1.5rem",
              color: "var(--color-text-muted)",
              fontSize: "0.8rem",
            }}
          >
            Equivalent CLI: <code>cfcf config edit</code>. Changes apply to new
            workspaces and to existing workspaces that don't override the field.
          </div>
        </>
      )}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <tr className="project-history__row">
      <td className="project-history__time" style={{ minWidth: "10rem" }}>
        {label}
      </td>
      <td>
        <code>{value}</code>
      </td>
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
    <tr className="project-history__row">
      <td className="project-history__time" style={{ minWidth: "10rem" }}>
        {label}
      </td>
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
    <tr className="project-history__row">
      <td className="project-history__time" style={{ minWidth: "10rem" }}>
        <code>{label}</code>
      </td>
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
