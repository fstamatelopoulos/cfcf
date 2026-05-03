import { useEffect, useState } from "react";
import {
  fetchAgentModels,
  fetchServerStatus,
  fetchGlobalConfig,
  saveGlobalConfig,
  type ServerStatus,
  type GlobalConfig,
} from "../api";
import { navigateTo } from "../hooks/useRoute";
import type { NotificationChannelName, NotificationEventType } from "../types";
import { AgentModelSelect } from "../components/AgentModelSelect";

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
  "devAgent" | "judgeAgent" | "architectAgent" | "documenterAgent" | "reflectionAgent" | "productArchitectAgent" | "helpAssistantAgent"
>)[] = ["devAgent", "judgeAgent", "architectAgent", "documenterAgent", "reflectionAgent", "productArchitectAgent", "helpAssistantAgent"];

const ROLE_LABEL: Record<string, string> = {
  devAgent: "Dev",
  judgeAgent: "Judge",
  architectAgent: "Solution Architect",
  documenterAgent: "Documenter",
  reflectionAgent: "Reflection",
  productArchitectAgent: "Product Architect",
  helpAssistantAgent: "Help Assistant",
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
  // Active embedder + its recommendedChunkMaxChars — needed to warn
  // when the user sets clio.maxChunkChars above the embedder's ceiling.
  // 5.12+ follow-up; safe to fetch once, doesn't change while the page
  // is open without an explicit `cfcf clio embedder set` from elsewhere.
  const [activeEmbedder, setActiveEmbedder] = useState<{
    name: string;
    dim: number;
    recommendedChunkMaxChars: number;
  } | null>(null);
  // 6.26 -- per-adapter model registry. `seed` is needed by the editor's
  // "Reset to defaults" affordance.
  const [agentModels, setAgentModels] = useState<Record<string, string[]>>({});
  const [seedModels, setSeedModels] = useState<Record<string, string[]>>({});
  // Bumped after a Model registry save so dependent dropdowns + the
  // editor refresh from the server's resolved view.
  const [modelsRev, setModelsRev] = useState(0);

  // Initial + periodic fetch of read-only server status (version, uptime, etc.)
  useEffect(() => {
    const load = () => {
      fetchServerStatus().then(setStatus).catch((e) => setError(String(e)));
    };
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, []);

  // Fetch active embedder once on mount. Used by the chunk-size
  // warning below (cap behaviour when user sets a value > ceiling).
  useEffect(() => {
    fetch("/api/clio/stats")
      .then((r) => r.json())
      .then((s: { activeEmbedder?: { name: string; dim: number; recommendedChunkMaxChars: number } | null }) => {
        if (s.activeEmbedder) setActiveEmbedder(s.activeEmbedder);
      })
      .catch(() => { /* non-fatal; warning just won't render */ });
  }, []);

  // 6.26 -- fetch the per-adapter model registry (seed + resolved
  // override) on mount and after every save that touches `agentModels`.
  useEffect(() => {
    fetchAgentModels()
      .then((r) => { setAgentModels(r.adapters); setSeedModels(r.seed); })
      .catch(() => { setAgentModels({}); setSeedModels({}); });
  }, [modelsRev]);

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

  // 6.26: per-adapter model registry edits live on draft.agentModels.
  // The user's working draft starts from the resolved server view (so
  // editing an unset adapter pre-populates with the seed for sane
  // defaults). On save, an unchanged-from-seed list is dropped so we
  // don't pin a snapshot that would silently mask future seed updates.
  function setRegistryAdapterModels(adapter: string, models: string[]) {
    if (!draft) return;
    const next: Record<string, string[]> = { ...(draft.agentModels ?? {}) };
    const cleaned = models.map((m) => m.trim()).filter((m) => m.length > 0);
    const seedForAdapter = seedModels[adapter] ?? [];
    const isSameAsSeed =
      cleaned.length === seedForAdapter.length &&
      cleaned.every((m, i) => m === seedForAdapter[i]);
    if (cleaned.length === 0 || isSameAsSeed) {
      delete next[adapter];
    } else {
      next[adapter] = cleaned;
    }
    setDraft({ ...draft, agentModels: Object.keys(next).length > 0 ? next : undefined });
    setSavedAt(null);
  }

  function resetRegistryAdapter(adapter: string) {
    if (!draft) return;
    const next = { ...(draft.agentModels ?? {}) };
    delete next[adapter];
    setDraft({ ...draft, agentModels: Object.keys(next).length > 0 ? next : undefined });
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
      // 6.26: surface a refreshed model registry to the per-role
      // pickers above (the resolved list may have changed if the user
      // edited agentModels in the Model registry section).
      setModelsRev((n) => n + 1);
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
          </FormSection>

          <FormSection title="Model registry (item 6.26)">
            <p style={{ margin: "0 0 0.75rem 0", fontSize: "var(--text-sm)", color: "var(--color-text-muted)", lineHeight: 1.5 }}>
              Models surfaced in the per-role <strong>Model</strong> dropdowns above + on each workspace's Config tab.
              cfcf ships a <strong>seed</strong> list per agent (intentionally minimal -- generic aliases like <code>opus</code>
              not date-bound names like <code>claude-opus-4-7</code>). Edit below to augment for your install: pin specific
              versions, add models your agent CLI accepts that aren't in the seed, or trim to just what you actually use.
              An empty list (or one identical to the seed) clears the override and falls back to the seed automatically.
              The <code>(custom model name…)</code> sentinel in every picker is always available as a one-shot escape hatch.
            </p>
            {Array.from(new Set([
              ...Object.keys(seedModels),
              ...Object.keys(draft.agentModels ?? {}),
            ])).sort().map((adapter) => {
              const override = draft.agentModels?.[adapter];
              const resolved = override && override.length > 0 ? override : (seedModels[adapter] ?? []);
              const seed = seedModels[adapter] ?? [];
              const isOverridden = !!override;
              return (
                <ModelRegistryAdapterRow
                  key={adapter}
                  adapter={adapter}
                  resolved={resolved}
                  seed={seed}
                  isOverridden={isOverridden}
                  onSet={(models) => setRegistryAdapterModels(adapter, models)}
                  onReset={() => resetRegistryAdapter(adapter)}
                />
              );
            })}
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

          {/* Clio (item 5.7). Currently surfaces only defaultSearchMode --
              the field that's relevant to people every day. preferredEmbedder
              + ingestPolicy will come later under 6.18 along with the
              full Clio web tab. */}
          <FormSection title="Clio memory layer">
            <table className="config-display__table">
              <tbody>
                <tr>
                  <th>Default search mode</th>
                  <td>
                    <select
                      value={draft.clio?.defaultSearchMode ?? "auto"}
                      onChange={(e) => {
                        if (!draft) return;
                        const value = e.target.value as
                          | "auto" | "fts" | "semantic" | "hybrid";
                        setDraft({
                          ...draft,
                          clio: { ...(draft.clio ?? {}), defaultSearchMode: value },
                        });
                        setSavedAt(null);
                      }}
                    >
                      <option value="auto">auto (hybrid if embedder active, else fts)</option>
                      <option value="fts">fts (keyword only)</option>
                      <option value="semantic">semantic (vector only)</option>
                      <option value="hybrid">hybrid (α-weighted blend of cosine + normalised BM25)</option>
                    </select>
                    <div style={{ color: "var(--color-text-muted)", fontSize: "0.8rem", marginTop: "0.35rem" }}>
                      Used when <code>cfcf clio search</code> is invoked without an explicit <code>--mode</code> flag (or when <code>/api/clio/search</code> is called without <code>?mode=</code>). Per-call overrides always win.
                    </div>
                  </td>
                </tr>
                <tr>
                  <th>Min search score</th>
                  <td>
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={draft.clio?.minSearchScore ?? 0.5}
                      onChange={(e) => {
                        if (!draft) return;
                        const n = parseFloat(e.target.value);
                        if (!Number.isFinite(n) || n < 0 || n > 1) return;
                        setDraft({
                          ...draft,
                          clio: { ...(draft.clio ?? {}), minSearchScore: n },
                        });
                        setSavedAt(null);
                      }}
                      style={{ width: "5rem" }}
                    />
                    <div style={{ color: "var(--color-text-muted)", fontSize: "0.8rem", marginTop: "0.35rem" }}>
                      Cosine threshold for the vector-only branch of hybrid search and for every semantic result. FTS-matched chunks in hybrid mode bypass this filter. Default 0.5; lower for wider recall, higher for stricter precision. Per-call <code>--min-score</code> always wins.
                    </div>
                  </td>
                </tr>
                <tr>
                  <th>Hybrid blend (α)</th>
                  <td>
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={draft.clio?.hybridAlpha ?? 0.7}
                      onChange={(e) => {
                        if (!draft) return;
                        const n = parseFloat(e.target.value);
                        if (!Number.isFinite(n) || n < 0 || n > 1) return;
                        setDraft({
                          ...draft,
                          clio: { ...(draft.clio ?? {}), hybridAlpha: n },
                        });
                        setSavedAt(null);
                      }}
                      style={{ width: "5rem" }}
                    />
                    <div style={{ color: "var(--color-text-muted)", fontSize: "0.8rem", marginTop: "0.35rem" }}>
                      Hybrid score = <code>α × cosine + (1−α) × normalised_BM25</code>. Higher α biases toward semantic similarity; lower α biases toward keyword match. Default 0.7 (Cerefox parity). Per-call <code>--alpha</code> always wins.
                    </div>
                  </td>
                </tr>
                <tr>
                  <th>Small-doc threshold</th>
                  <td>
                    <input
                      type="number"
                      min={0}
                      step={1000}
                      value={draft.clio?.smallDocThreshold ?? 20000}
                      onChange={(e) => {
                        if (!draft) return;
                        const n = parseInt(e.target.value, 10);
                        if (!Number.isFinite(n) || n < 0) return;
                        setDraft({
                          ...draft,
                          clio: { ...(draft.clio ?? {}), smallDocThreshold: n },
                        });
                        setSavedAt(null);
                      }}
                      style={{ width: "8rem" }}
                    /> chars
                    <div style={{ color: "var(--color-text-muted)", fontSize: "0.8rem", marginTop: "0.35rem" }}>
                      Documents whose total content is at most this size return the FULL document content in each search hit (small-to-big). Larger documents return the matched chunk + context window. Default 20000 (Cerefox parity). Set 0 to always use chunk + window.
                    </div>
                  </td>
                </tr>
                <tr>
                  <th>Context window</th>
                  <td>
                    <input
                      type="number"
                      min={0}
                      max={5}
                      step={1}
                      value={draft.clio?.contextWindow ?? 1}
                      onChange={(e) => {
                        if (!draft) return;
                        const n = parseInt(e.target.value, 10);
                        if (!Number.isFinite(n) || n < 0) return;
                        setDraft({
                          ...draft,
                          clio: { ...(draft.clio ?? {}), contextWindow: n },
                        });
                        setSavedAt(null);
                      }}
                      style={{ width: "5rem" }}
                    /> chunks
                    <div style={{ color: "var(--color-text-muted)", fontSize: "0.8rem", marginTop: "0.35rem" }}>
                      For documents larger than the small-doc threshold: how many sibling chunks to include on each side of the matched chunk. Default 1 (3-chunk window: prev + match + next). 0 returns just the matched chunk.
                    </div>
                  </td>
                </tr>
                <tr>
                  <th>Max chunk size</th>
                  <td>
                    <input
                      type="number"
                      min={500}
                      step={500}
                      value={draft.clio?.maxChunkChars ?? 4000}
                      onChange={(e) => {
                        if (!draft) return;
                        const n = parseInt(e.target.value, 10);
                        if (!Number.isFinite(n) || n < 500) return;
                        setDraft({
                          ...draft,
                          clio: { ...(draft.clio ?? {}), maxChunkChars: n },
                        });
                        setSavedAt(null);
                      }}
                      style={{ width: "8rem" }}
                    /> chars
                    {activeEmbedder && (draft.clio?.maxChunkChars ?? 4000) > activeEmbedder.recommendedChunkMaxChars && (
                      <div style={{
                        color: "var(--color-warning, #b8860b)",
                        background: "rgba(255, 200, 0, 0.08)",
                        border: "1px solid rgba(255, 200, 0, 0.3)",
                        padding: "0.5rem 0.6rem",
                        borderRadius: "4px",
                        fontSize: "0.85rem",
                        marginTop: "0.5rem",
                      }}>
                        ⚠ Exceeds <code>{activeEmbedder.name}</code>'s recommended max
                        ({activeEmbedder.recommendedChunkMaxChars} chars). At ingest time the value will be
                        capped to {activeEmbedder.recommendedChunkMaxChars} so the model doesn't silently
                        truncate inputs.
                      </div>
                    )}
                    <div style={{ color: "var(--color-text-muted)", fontSize: "0.8rem", marginTop: "0.35rem" }}>
                      Target maximum size per chunk during ingest. The active embedder's recommended max acts as a safety ceiling — values above it get capped. Default 4000 (Cerefox parity).
                    </div>
                  </td>
                </tr>
                <tr>
                  <th>Min chunk size</th>
                  <td>
                    <input
                      type="number"
                      min={50}
                      step={50}
                      value={draft.clio?.minChunkChars ?? 100}
                      onChange={(e) => {
                        if (!draft) return;
                        const n = parseInt(e.target.value, 10);
                        if (!Number.isFinite(n) || n < 50) return;
                        setDraft({
                          ...draft,
                          clio: { ...(draft.clio ?? {}), minChunkChars: n },
                        });
                        setSavedAt(null);
                      }}
                      style={{ width: "8rem" }}
                    /> chars
                    <div style={{ color: "var(--color-text-muted)", fontSize: "0.8rem", marginTop: "0.35rem" }}>
                      Pieces smaller than this merge into the previous chunk during oversized-section splitting. Default 100 (Cerefox parity).
                    </div>
                  </td>
                </tr>
                {draft.clio?.preferredEmbedder && (
                  <tr>
                    <th>Preferred embedder</th>
                    <td style={{ color: "var(--color-text-muted)" }}>
                      <code>{draft.clio.preferredEmbedder}</code>
                      {activeEmbedder && (
                        <> (active: <code>{activeEmbedder.name}</code>, dim={activeEmbedder.dim}, recommended max={activeEmbedder.recommendedChunkMaxChars} chars)</>
                      )}
                      <div style={{ fontSize: "0.8rem", marginTop: "0.35rem" }}>
                        Switch with <code>cfcf clio embedder set &lt;name&gt; --reindex</code>. Without <code>--reindex</code>, existing chunk embeddings become inconsistent with the new model and vector-search quality on those chunks degrades. Use <code>--force</code> only for recovery.
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
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

/**
 * Per-adapter row in the Model registry editor (item 6.26). Local UI
 * state for the "add model" input + commit-on-blur drag-handle for
 * reordering would be nice; for the prototype we keep it spartan: each
 * model is a row with a delete button, plus an input + Add button.
 */
function ModelRegistryAdapterRow({
  adapter,
  resolved,
  seed,
  isOverridden,
  onSet,
  onReset,
}: {
  adapter: string;
  resolved: string[];
  seed: string[];
  isOverridden: boolean;
  onSet: (models: string[]) => void;
  onReset: () => void;
}) {
  const [pending, setPending] = useState("");

  function add() {
    const trimmed = pending.trim();
    if (!trimmed) return;
    if (resolved.includes(trimmed)) { setPending(""); return; }
    onSet([...resolved, trimmed]);
    setPending("");
  }

  return (
    <div style={{
      border: "1px solid var(--color-border)",
      borderRadius: 6,
      padding: "0.6rem 0.85rem",
      marginBottom: "0.75rem",
      background: "var(--color-surface)",
    }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "0.35rem" }}>
        <strong style={{ fontSize: "var(--text-md)" }}>{adapter}</strong>
        <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
          {isOverridden
            ? `${resolved.length} model${resolved.length === 1 ? "" : "s"} (custom override)`
            : `${resolved.length} model${resolved.length === 1 ? "" : "s"} (seed)`}
        </span>
      </div>
      {resolved.length === 0 ? (
        <p className="form-row__hint" style={{ margin: "0.4rem 0" }}>
          No models in this adapter's registry. Use the input below to add one, or rely on the
          <code> (custom model name…) </code> picker option in the per-role dropdowns.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: "0 0 0.5rem 0", padding: 0, display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
          {resolved.map((m) => (
            <li
              key={m}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.4rem",
                padding: "0.2rem 0.45rem",
                background: "var(--color-surface-alt)",
                border: "1px solid var(--color-border)",
                borderRadius: 4,
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
              }}
            >
              <span>{m}</span>
              <button
                type="button"
                aria-label={`Remove ${m}`}
                title={`Remove ${m}`}
                onClick={() => onSet(resolved.filter((x) => x !== m))}
                style={{
                  background: "transparent",
                  border: 0,
                  color: "var(--color-text-muted)",
                  cursor: "pointer",
                  fontSize: "0.95rem",
                  lineHeight: 1,
                  padding: 0,
                }}
              >×</button>
            </li>
          ))}
        </ul>
      )}
      <div className="form-row__inline">
        <input
          type="text"
          value={pending}
          onChange={(e) => setPending(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder="Add a model name (e.g. claude-opus-4-7, o4-mini)"
          style={{ flex: 1 }}
        />
        <button type="button" className="btn btn--small btn--secondary" onClick={add} disabled={!pending.trim()}>
          Add
        </button>
        {isOverridden && (
          <button
            type="button"
            className="btn btn--small btn--secondary"
            onClick={onReset}
            title={`Reset to the bundled seed (${seed.join(", ") || "no seeded models"})`}
          >
            Reset to seed
          </button>
        )}
      </div>
      {isOverridden && (
        <div className="form-row__hint" style={{ marginTop: "0.4rem" }}>
          Seed: <code>{seed.join(", ") || "(none)"}</code>
        </div>
      )}
    </div>
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
