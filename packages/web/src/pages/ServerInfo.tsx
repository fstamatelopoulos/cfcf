import { useEffect, useState } from "react";
import { fetchServerStatus, fetchGlobalConfig, type ServerStatus, type GlobalConfig } from "../api";
import { navigateTo } from "../hooks/useRoute";

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  return `${h}h ${m % 60}m`;
}

function agentLabel(a: { adapter: string; model?: string } | undefined): string {
  if (!a) return "—";
  return a.model ? `${a.adapter}:${a.model}` : a.adapter;
}

export function ServerInfo() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [config, setConfig] = useState<GlobalConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () => {
      fetchServerStatus().then(setStatus).catch((e) => setError(String(e)));
      fetchGlobalConfig().then(setConfig).catch(() => {
        /* config may be 404 if not initialized */
      });
    };
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="dashboard">
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: "1rem",
        }}
      >
        <h2 className="dashboard__title" style={{ margin: 0 }}>
          Server & configuration
        </h2>
        <button
          className="btn btn--small btn--secondary"
          onClick={() => navigateTo("/")}
        >
          ← back to projects
        </button>
      </div>

      {error && (
        <div className="dashboard__error" style={{ marginBottom: "1rem" }}>
          {error}
        </div>
      )}

      <section className="architect-review">
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
                value={status.availableAgents.length > 0 ? status.availableAgents.join(", ") : "(none detected)"}
              />
              <InfoRow label="Configured" value={status.configured ? "yes" : "no"} />
            </tbody>
          </table>
        ) : (
          <div style={{ color: "var(--color-text-muted)" }}>Loading…</div>
        )}
      </section>

      {config && (
        <section className="architect-review" style={{ marginTop: "1.5rem" }}>
          <h3 className="architect-review__summary" style={{ fontSize: "1rem" }}>
            Default agent roles
          </h3>
          <table className="project-history__table">
            <tbody>
              <InfoRow label="Dev" value={agentLabel(config.devAgent)} />
              <InfoRow label="Judge" value={agentLabel(config.judgeAgent)} />
              <InfoRow label="Architect" value={agentLabel(config.architectAgent)} />
              <InfoRow label="Documenter" value={agentLabel(config.documenterAgent)} />
              <InfoRow label="Reflection" value={agentLabel(config.reflectionAgent)} />
            </tbody>
          </table>

          <h3
            className="architect-review__summary"
            style={{ fontSize: "1rem", marginTop: "1.5rem" }}
          >
            Loop defaults
          </h3>
          <table className="project-history__table">
            <tbody>
              <InfoRow label="Max iterations" value={String(config.maxIterations)} />
              <InfoRow
                label="Pause every"
                value={config.pauseEvery === 0 ? "never" : `${config.pauseEvery} iteration(s)`}
              />
              <InfoRow
                label="Reflection safeguard"
                value={`force after ${config.reflectSafeguardAfter ?? 3} consecutive opt-outs`}
              />
              <InfoRow
                label="Auto-cleanup merged branches"
                value={config.cleanupMergedBranches ? "yes" : "no (audit trail preserved)"}
              />
            </tbody>
          </table>

          <div
            style={{
              marginTop: "1rem",
              color: "var(--color-text-muted)",
              fontSize: "0.8rem",
            }}
          >
            This is a read-only view. Edit via <code>cfcf config edit</code> or the CLI.
          </div>
        </section>
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
