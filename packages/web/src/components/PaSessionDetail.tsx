/**
 * Product Architect session detail panel.
 *
 * Rendered when the user expands a "pa-session" row in the workspace
 * History tab. Shows:
 *   - Session bracket info (start/end/duration/exit code/agent)
 *   - Pre-state assessment summary (git? workspace? problem-pack?)
 *   - One-line outcome summary written by PA on save
 *   - Decisions count + Clio doc deep link
 *   - Tabbed content: session scratchpad / workspace summary / meta.json
 *
 * The actual file contents are fetched from
 * `/api/workspaces/:id/pa-sessions/:sessionId/file` when the panel
 * mounts. While loading, shows a placeholder; if any of the three
 * files is absent (e.g. agent never wrote one), shows a "not present"
 * note for that tab.
 *
 * Plan item 5.14 v2 follow-up. Design:
 * `docs/research/product-architect-design.md` §"History tracking".
 */
import { useEffect, useState } from "react";
import type { PaSessionHistoryEvent } from "../types";
import { fetchPaSessionFile, type PaSessionFileSnapshot } from "../api";
import { MarkdownView } from "../utils/markdown";

type Tab = "session" | "summary" | "meta";

export function PaSessionDetail({
  event,
  workspaceId,
}: {
  event: PaSessionHistoryEvent;
  workspaceId: string;
}) {
  const [snapshot, setSnapshot] = useState<PaSessionFileSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("session");

  useEffect(() => {
    let cancelled = false;
    setSnapshot(null);
    setError(null);
    fetchPaSessionFile(workspaceId, event.sessionId)
      .then((s) => {
        if (!cancelled) setSnapshot(s);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, event.sessionId]);

  const durationLabel = formatDurationLabel(event.startedAt, event.completedAt);
  const startLabel = formatTime(event.startedAt);
  const endLabel = event.completedAt ? formatTime(event.completedAt) : "(in progress)";
  const exitLabel =
    event.status === "running"
      ? "running"
      : event.exitCode === 0 || event.exitCode === undefined
        ? "exit 0"
        : `exit ${event.exitCode}`;

  return (
    <div className="architect-review architect-review--compact" style={containerStyle}>
      <div className="architect-review__header" style={headerStyle}>
        <span className="architect-review__readiness" style={statusStyle(event.status)}>
          Product Architect · {event.status}
        </span>
        <span className="architect-review__counts">
          {event.agent}{event.model ? `:${event.model}` : ""}
        </span>
      </div>

      <div style={metaGridStyle}>
        <MetaCell label="Session ID" value={<code style={inlineCodeStyle}>{event.sessionId}</code>} />
        <MetaCell label="Started" value={startLabel} />
        <MetaCell label="Ended" value={endLabel} />
        <MetaCell label="Duration" value={durationLabel} />
        <MetaCell label="Exit" value={exitLabel} />
        <MetaCell label="Decisions" value={event.decisionsCount ?? "—"} />
      </div>

      <PreStateBar event={event} />

      {event.outcomeSummary && (
        <div style={outcomeStyle}>
          <strong style={{ color: "var(--color-text-muted)", marginRight: 8 }}>Outcome:</strong>
          {event.outcomeSummary}
        </div>
      )}

      {event.clioWorkspaceMemoryDocId && (
        <div style={clioLinkStyle}>
          <strong style={{ color: "var(--color-text-muted)", marginRight: 8 }}>
            Clio doc:
          </strong>
          <code style={inlineCodeStyle}>{event.clioWorkspaceMemoryDocId}</code>
          <span style={{ marginLeft: 8, fontSize: "0.85rem", color: "var(--color-text-muted)" }}>
            (workspace memory snapshot pushed to Clio)
          </span>
        </div>
      )}

      <div style={tabBarStyle}>
        <TabButton active={tab === "session"} onClick={() => setTab("session")}>
          Session log
        </TabButton>
        <TabButton active={tab === "summary"} onClick={() => setTab("summary")}>
          Workspace summary
        </TabButton>
        <TabButton active={tab === "meta"} onClick={() => setTab("meta")}>
          meta.json
        </TabButton>
      </div>

      <div style={tabBodyStyle}>
        {error && <div style={errorStyle}>Failed to load session files: {error}</div>}
        {!snapshot && !error && <div style={loadingStyle}>Loading…</div>}

        {snapshot && tab === "session" && (
          <FileTab
            label="session scratchpad"
            path={snapshot.sessionFilePath}
            content={snapshot.sessionFile}
            absentNote="The agent didn't write a session log for this run (agent may have exited without saving)."
          />
        )}
        {snapshot && tab === "summary" && (
          <FileTab
            label="workspace summary"
            path={snapshot.workspaceSummaryPath}
            content={snapshot.workspaceSummary}
            absentNote="No workspace-summary.md yet (first session, or agent didn't sync)."
          />
        )}
        {snapshot && tab === "meta" && (
          <MetaTab meta={snapshot.meta} cachePath={snapshot.cachePath} />
        )}
      </div>
    </div>
  );
}

function PreStateBar({ event }: { event: PaSessionHistoryEvent }) {
  const items = [
    {
      label: "git",
      ok: event.gitInitializedAtStart,
      okText: "initialised",
      missingText: "not a repo",
    },
    {
      label: "workspace",
      ok: event.workspaceRegisteredAtStart,
      okText: "registered",
      missingText: "unregistered",
    },
    {
      label: "problem-pack",
      ok: event.problemPackFilesAtStart > 0,
      okText: `${event.problemPackFilesAtStart}/5 files`,
      missingText: "no files yet",
    },
  ];
  return (
    <div style={preStateBarStyle}>
      <span style={{ color: "var(--color-text-muted)", marginRight: 12, fontSize: "0.85rem" }}>
        Pre-state:
      </span>
      {items.map((item) => (
        <span
          key={item.label}
          style={{
            ...pillStyle,
            background: item.ok
              ? "color-mix(in srgb, var(--color-success) 14%, transparent)"
              : "color-mix(in srgb, var(--color-warning) 14%, transparent)",
            color: item.ok ? "var(--color-success)" : "var(--color-warning)",
          }}
        >
          {item.label}: {item.ok ? item.okText : item.missingText}
        </span>
      ))}
    </div>
  );
}

function FileTab({
  label,
  path,
  content,
  absentNote,
}: {
  label: string;
  path: string;
  content: string | null;
  absentNote: string;
}) {
  if (content === null) {
    return (
      <div style={absentNoteStyle}>
        <strong>{label}</strong> at <code style={inlineCodeStyle}>{path}</code> — not present.
        <p style={{ marginTop: 8, color: "var(--color-text-muted)" }}>{absentNote}</p>
      </div>
    );
  }
  return (
    <>
      <div style={filePathStyle}>
        <code style={inlineCodeStyle}>{path}</code>
      </div>
      <MarkdownView content={content} />
    </>
  );
}

function MetaTab({
  meta,
  cachePath,
}: {
  meta: Record<string, unknown> | null;
  cachePath: string;
}) {
  if (meta === null) {
    return (
      <div style={absentNoteStyle}>
        <code style={inlineCodeStyle}>.cfcf-pa/meta.json</code> not present.
        <p style={{ marginTop: 8, color: "var(--color-text-muted)" }}>
          The agent hasn't written sync metadata yet. cfcf will create this on the
          first save.
        </p>
        <p style={{ marginTop: 4, color: "var(--color-text-muted)", fontSize: "0.85rem" }}>
          Cache path: <code style={inlineCodeStyle}>{cachePath}</code>
        </p>
      </div>
    );
  }
  return (
    <>
      <div style={filePathStyle}>
        <code style={inlineCodeStyle}>.cfcf-pa/meta.json</code>
      </div>
      <pre style={metaPreStyle}>{JSON.stringify(meta, null, 2)}</pre>
    </>
  );
}

function MetaCell({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div style={metaLabelStyle}>{label}</div>
      <div style={metaValueStyle}>{value}</div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...tabButtonStyle,
        background: active
          ? "color-mix(in srgb, var(--color-primary) 18%, transparent)"
          : "transparent",
        color: active ? "var(--color-primary-hover)" : "var(--color-text)",
        borderBottomColor: active ? "var(--color-primary)" : "transparent",
      }}
    >
      {children}
    </button>
  );
}

// ── helpers ──────────────────────────────────────────────────────────

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function formatDurationLabel(start: string, end?: string): string {
  if (!end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (Number.isNaN(ms) || ms < 0) return "—";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m ${remSec}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

// ── styles ───────────────────────────────────────────────────────────

const containerStyle: React.CSSProperties = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  padding: "16px",
  borderRadius: "var(--radius)",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: "12px",
};

const metaGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: "10px 18px",
  margin: "8px 0 14px 0",
};

const metaLabelStyle: React.CSSProperties = {
  fontSize: "0.72rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--color-text-muted)",
  marginBottom: "2px",
};

const metaValueStyle: React.CSSProperties = {
  fontSize: "0.92rem",
  color: "var(--color-text)",
};

const preStateBarStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "6px",
  marginBottom: "12px",
};

const pillStyle: React.CSSProperties = {
  fontSize: "0.78rem",
  padding: "2px 8px",
  borderRadius: "999px",
  fontWeight: 500,
};

const outcomeStyle: React.CSSProperties = {
  borderLeft: "3px solid var(--color-info)",
  background: "color-mix(in srgb, var(--color-info) 8%, transparent)",
  padding: "8px 12px",
  borderRadius: "var(--radius)",
  margin: "0 0 10px 0",
  fontSize: "0.95rem",
};

const clioLinkStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  marginBottom: "12px",
  fontSize: "0.92rem",
};

const tabBarStyle: React.CSSProperties = {
  display: "flex",
  borderBottom: "1px solid var(--color-border)",
  marginBottom: "12px",
};

const tabButtonStyle: React.CSSProperties = {
  border: "none",
  borderBottom: "2px solid transparent",
  padding: "8px 14px",
  fontSize: "0.9rem",
  cursor: "pointer",
  fontFamily: "inherit",
};

const tabBodyStyle: React.CSSProperties = {
  minHeight: "120px",
};

const errorStyle: React.CSSProperties = {
  color: "var(--color-error)",
  padding: "12px",
};

const loadingStyle: React.CSSProperties = {
  color: "var(--color-text-muted)",
  padding: "12px",
  fontStyle: "italic",
};

const filePathStyle: React.CSSProperties = {
  fontSize: "0.78rem",
  color: "var(--color-text-muted)",
  marginBottom: "6px",
};

const absentNoteStyle: React.CSSProperties = {
  padding: "12px",
  background: "var(--color-surface-alt)",
  borderRadius: "var(--radius)",
  fontSize: "0.92rem",
};

const metaPreStyle: React.CSSProperties = {
  background: "var(--color-surface-alt)",
  color: "var(--color-text)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius)",
  padding: "12px",
  overflowX: "auto",
  fontSize: "0.85rem",
  fontFamily: "var(--font-mono)",
};

const inlineCodeStyle: React.CSSProperties = {
  background: "color-mix(in srgb, var(--color-primary) 12%, transparent)",
  color: "var(--color-text)",
  padding: "1px 5px",
  borderRadius: "3px",
  fontSize: "0.88em",
  fontFamily: "var(--font-mono)",
};

function statusStyle(status: PaSessionHistoryEvent["status"]): React.CSSProperties {
  return {
    color:
      status === "completed"
        ? "var(--color-success)"
        : status === "failed"
          ? "var(--color-error)"
          : "var(--color-info)",
  };
}
