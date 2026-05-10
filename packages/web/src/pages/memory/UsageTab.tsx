import { useEffect, useMemo, useState } from "react";
import {
  fetchClioUsageLog,
  fetchClioUsageSummary,
  type ClioUsageRow,
  type ClioUsageSummary,
} from "../../api";

/**
 * Global Clio usage-log viewer (item 6.35; backend shipped in 6.9).
 * Mirrors `cfcf clio usage list` + `cfcf clio usage summary` as a
 * single browsable surface. Sibling to the Audit tab — same Memory
 * page, same sidebar, but the Usage tab covers BOTH reads and writes
 * with the operational lens (access_path / requestor / query / hit
 * count) rather than the audit lens (mutation history with diffs).
 *
 * Layout:
 *   - Top: aggregate dashboard panel from `/api/clio/usage/summary`
 *     (totals, by-operation, by-access-path, top requestors, top docs)
 *   - Middle: filter form
 *   - Bottom: entry table (newest first, 100 rows by default)
 *
 * Filters mirror the CLI flags: --operation / --access-path / --actor /
 * --reads / --writes / --zero-hits / --since / --until.
 */
export function UsageTab({ activeProject }: { activeProject: string | null }) {
  // ── Filters ─────────────────────────────────────────────────────────
  const [operation, setOperation] = useState("");
  const [accessPath, setAccessPath] = useState("");
  const [requestor, setRequestor] = useState("");
  // Three-state radio: "all" | "reads" | "writes". Mutually exclusive
  // since the server rejects --reads + --writes together (HTTP 400).
  const [readWriteMode, setReadWriteMode] = useState<"all" | "reads" | "writes">("all");
  const [zeroHits, setZeroHits] = useState(false);
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");

  // ── Data ────────────────────────────────────────────────────────────
  const [entries, setEntries] = useState<ClioUsageRow[]>([]);
  const [summary, setSummary] = useState<ClioUsageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  // Project filter from the sidebar maps to project_id, which the server
  // expects (not project name). The Memory sidebar surfaces the active
  // project's name; we'd need to pass the id through. For now we leave
  // the project filter at the API level for this tab — sidebar scoping
  // is a future extension. The activeProject string IS the project name;
  // the API filters on project_id which is unavailable here without a
  // round-trip. Pragmatic: surface activeProject in the summary header
  // so the user knows the global view is active.

  // ── Fetch summary on filter change ──────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setSummaryLoading(true);
    fetchClioUsageSummary({ since: since.trim() || undefined, until: until.trim() || undefined })
      .then((s) => { if (!cancelled) setSummary(s); })
      .catch(() => { if (!cancelled) setSummary(null); })
      .finally(() => { if (!cancelled) setSummaryLoading(false); });
    return () => { cancelled = true; };
  }, [since, until]);

  // ── Fetch entries on filter change ──────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchClioUsageLog({
      operation: operation || undefined,
      accessPath: accessPath || undefined,
      requestor: requestor.trim() || undefined,
      reads: readWriteMode === "reads" ? true : undefined,
      writes: readWriteMode === "writes" ? true : undefined,
      zeroHits: zeroHits || undefined,
      since: since.trim() || undefined,
      until: until.trim() || undefined,
      limit: 100,
    })
      .then((es) => {
        if (cancelled) return;
        setEntries(es);
        setHasMore(es.length === 100);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [operation, accessPath, requestor, readWriteMode, zeroHits, since, until]);

  // ── Derived: distinct operations + access-paths from current entries ─
  // Pre-populate the dropdown with the values actually present in the
  // current dataset (so an empty corpus shows an empty filter, not a
  // long static list of theoretical operations).
  const knownOperations = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) set.add(e.operation);
    if (summary) for (const r of summary.opsByOperation) set.add(r.operation);
    return Array.from(set).sort();
  }, [entries, summary]);

  return (
    <section className="memory-search">
      <h3 className="section-title" style={{ margin: "0 0 0.4rem 0", fontSize: "var(--text-md)" }}>
        Usage log
        {activeProject && (
          <span style={{ fontWeight: 400, color: "var(--color-text-muted)", marginLeft: "0.4rem" }}>
            (sidebar filter: {activeProject} — Usage view shows global activity)
          </span>
        )}
      </h3>

      {/* ── Summary dashboard ────────────────────────────────────────── */}
      <div className="usage-dashboard" style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
        gap: "0.75rem",
        marginBottom: "1rem",
        padding: "0.75rem",
        background: "var(--color-surface)",
        borderRadius: "4px",
      }}>
        <SummaryCard
          title="Total events"
          value={summary ? summary.totalCount.toString() : (summaryLoading ? "…" : "0")}
          subtitle={since || until ? `in window` : "all time"}
        />
        <SummaryListCard
          title="By operation"
          rows={summary?.opsByOperation.map((r) => ({ label: r.operation, value: r.count })) ?? []}
          loading={summaryLoading}
          maxRows={6}
        />
        <SummaryListCard
          title="By access path"
          rows={summary?.opsByAccessPath.map((r) => ({ label: r.accessPath, value: r.count })) ?? []}
          loading={summaryLoading}
          maxRows={4}
        />
        <SummaryListCard
          title="Top requestors"
          rows={summary?.opsByRequestor.map((r) => ({ label: r.requestor, value: r.count })) ?? []}
          loading={summaryLoading}
          maxRows={5}
          mono
        />
        <SummaryListCard
          title="Top documents"
          rows={summary?.topDocuments.map((r) => ({
            label: r.docTitle ?? `(no title — ${r.documentId.slice(0, 8)}…)`,
            value: r.count,
          })) ?? []}
          loading={summaryLoading}
          maxRows={5}
        />
      </div>

      {/* ── Filter form ───────────────────────────────────────────────── */}
      <form
        onSubmit={(e) => e.preventDefault()}
        style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginBottom: "0.85rem" }}
      >
        <select value={operation} onChange={(e) => setOperation(e.target.value)} title="Filter by operation">
          <option value="">All operations</option>
          {knownOperations.map((op) => (
            <option key={op} value={op}>{op}</option>
          ))}
        </select>
        <select value={accessPath} onChange={(e) => setAccessPath(e.target.value)} title="Filter by access path">
          <option value="">All access paths</option>
          <option value="cli">cli</option>
          <option value="agent-cli">agent-cli</option>
          <option value="web">web</option>
          <option value="internal">internal</option>
        </select>
        <input
          type="text"
          placeholder="Requestor (e.g. dev|claude-code|sonnet, user)"
          value={requestor}
          onChange={(e) => setRequestor(e.target.value)}
          style={{ minWidth: "16rem", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}
        />
        <select
          value={readWriteMode}
          onChange={(e) => setReadWriteMode(e.target.value as "all" | "reads" | "writes")}
          title="Filter to reads only / writes only / both"
        >
          <option value="all">Reads + writes</option>
          <option value="reads">Reads only</option>
          <option value="writes">Writes only</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", cursor: "pointer", fontSize: "var(--text-sm)" }}>
          <input
            type="checkbox"
            checked={zeroHits}
            onChange={(e) => setZeroHits(e.target.checked)}
          />
          Zero-hit reads
        </label>
        <input
          type="text"
          placeholder="Since (ISO-8601, e.g. 2026-05-01)"
          value={since}
          onChange={(e) => setSince(e.target.value)}
          style={{ minWidth: "11rem" }}
        />
        <input
          type="text"
          placeholder="Until (ISO-8601)"
          value={until}
          onChange={(e) => setUntil(e.target.value)}
          style={{ minWidth: "10rem" }}
        />
      </form>

      {/* ── Entry table ──────────────────────────────────────────────── */}
      {error && <div className="form-row__error">{error}</div>}
      {loading && <div className="form-row__hint">loading…</div>}
      {!loading && !error && entries.length === 0 && (
        <div className="form-row__hint">No usage entries match the current filters.</div>
      )}

      {entries.length > 0 && (
        <table className="project-history__table">
          <thead>
            <tr>
              <th style={{ minWidth: "14rem" }}>Time</th>
              <th>Operation</th>
              <th>Access path</th>
              <th>Requestor</th>
              <th>Document / Project</th>
              <th>Query</th>
              <th>Hits</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="project-history__row">
                <td className="project-history__time">{e.loggedAt}</td>
                <td>
                  <span style={{
                    color: operationColor(e.operation),
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-xs)",
                  }}>
                    {e.operation}
                  </span>
                </td>
                <td>
                  <span style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-xs)",
                    padding: "0 0.3rem",
                    borderRadius: "3px",
                    background: accessPathBg(e.accessPath),
                  }}>
                    {e.accessPath}
                  </span>
                </td>
                <td>
                  {e.requestor ? (
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}>
                      {e.requestor}
                    </span>
                  ) : (
                    <span className="form-row__hint">—</span>
                  )}
                </td>
                <td>
                  {e.documentId ? (
                    <a
                      href={`#/memory?tab=usage&doc=${encodeURIComponent(e.documentId)}`}
                      onClick={(ev) => {
                        ev.preventDefault();
                        window.location.hash = `/memory?tab=usage&doc=${encodeURIComponent(e.documentId!)}`;
                      }}
                      style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--color-info)", textDecoration: "underline" }}
                    >
                      {e.documentId.slice(0, 8)}…
                    </a>
                  ) : e.projectId ? (
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}>
                      project: {e.projectId.slice(0, 8)}…
                    </span>
                  ) : (
                    <span className="form-row__hint">—</span>
                  )}
                </td>
                <td>
                  {e.queryText ? (
                    <code style={{ fontSize: "var(--text-xs)" }}>
                      {e.queryText.length > 50 ? e.queryText.slice(0, 47) + "…" : e.queryText}
                    </code>
                  ) : (
                    <span className="form-row__hint">—</span>
                  )}
                </td>
                <td>
                  {e.resultCount === null || e.resultCount === undefined ? (
                    <span className="form-row__hint">—</span>
                  ) : (
                    <span style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-xs)",
                      color: e.resultCount === 0 ? "var(--color-warning)" : "inherit",
                    }}>
                      {e.resultCount}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {hasMore && (
        <div className="form-row__hint" style={{ marginTop: "0.5rem" }}>
          Showing first 100 entries. Tighten the filters to see further back, or use{" "}
          <code>cfcf clio usage list --limit 1000</code> for a deeper export.
        </div>
      )}
    </section>
  );
}

// ── Summary card subcomponents ──────────────────────────────────────

function SummaryCard({ title, value, subtitle }: { title: string; value: string; subtitle?: string }) {
  return (
    <div style={{
      padding: "0.6rem 0.75rem",
      background: "var(--color-surface-alt)",
      borderRadius: "3px",
      minHeight: "5.5rem",
    }}>
      <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", marginBottom: "0.2rem" }}>
        {title}
      </div>
      <div style={{ fontSize: "var(--text-lg)", fontWeight: 600, fontFamily: "var(--font-mono)" }}>
        {value}
      </div>
      {subtitle && (
        <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", marginTop: "0.15rem" }}>
          {subtitle}
        </div>
      )}
    </div>
  );
}

function SummaryListCard({
  title,
  rows,
  loading,
  maxRows = 5,
  mono = false,
}: {
  title: string;
  rows: Array<{ label: string; value: number }>;
  loading: boolean;
  maxRows?: number;
  mono?: boolean;
}) {
  const visible = rows.slice(0, maxRows);
  return (
    <div style={{
      padding: "0.6rem 0.75rem",
      background: "var(--color-surface-alt)",
      borderRadius: "3px",
      minHeight: "5.5rem",
    }}>
      <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", marginBottom: "0.3rem" }}>
        {title}
      </div>
      {loading && <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>loading…</div>}
      {!loading && visible.length === 0 && (
        <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>—</div>
      )}
      {visible.map((r) => (
        <div key={r.label} style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "var(--text-xs)",
          fontFamily: mono ? "var(--font-mono)" : undefined,
          marginBottom: "0.15rem",
        }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "70%" }} title={r.label}>
            {r.label}
          </span>
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-muted)" }}>
            {r.value}
          </span>
        </div>
      ))}
      {rows.length > maxRows && (
        <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", marginTop: "0.2rem" }}>
          +{rows.length - maxRows} more
        </div>
      )}
    </div>
  );
}

// ── Visual helpers ──────────────────────────────────────────────────

const READ_OPS = new Set([
  "search", "search-documents", "get-document", "get-document-content",
  "list-documents", "list-versions", "list-projects", "get-project",
  "metadata-search", "list-metadata-keys", "get-audit-log", "get-usage-log",
  "list-embedders", "preview-embedder-switch", "stats",
]);

function operationColor(op: string): string {
  // Reads = info colour (blue-ish); writes = success/warning depending
  // on intent. The audit log already colour-codes mutations; we mirror
  // for the writes that overlap.
  if (READ_OPS.has(op)) return "var(--color-info)";
  if (op === "delete" || op === "purge") return "var(--color-error)";
  if (op === "restore") return "var(--color-success)";
  if (op === "reindex") return "var(--color-warning)";
  return "var(--color-success)"; // create / ingest / update / etc.
}

function accessPathBg(path: string): string {
  switch (path) {
    case "cli":       return "color-mix(in srgb, var(--color-info, #4a8ee6) 18%, transparent)";
    case "agent-cli": return "color-mix(in srgb, var(--color-warning, #c8861a) 18%, transparent)";
    case "web":       return "color-mix(in srgb, var(--color-success, #4ea84e) 18%, transparent)";
    case "internal":  return "color-mix(in srgb, var(--color-text-muted, #888) 18%, transparent)";
    default:          return "transparent";
  }
}
