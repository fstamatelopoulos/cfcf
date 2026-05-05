import { useState } from "react";
import {
  searchClio,
  searchClioChunks,
  type ClioChunkSearchHit,
  type ClioDocumentSearchHit,
  type ClioSearchMode,
} from "../../api";
import { DeletedBadge } from "./DeletedBadge";

type ResultType = "documents" | "chunks";

/**
 * Standalone Search tab on the Memory page (item 6.18). Mirrors the knobs
 * the `cfcf clio search` CLI exposes:
 *
 *   - Mode picker: auto (default) / fts / semantic / hybrid
 *   - Result type: documents (default; small-to-big snippets, server-side)
 *                  or chunks (raw chunk-level hits)
 *   - Project filter: from the persistent sidebar (passed in)
 *   - Match count: 5 / 10 / 20 / 50 (default 10)
 *
 * The doc-vs-chunk choice maps to the API's `?by=doc` (default) vs
 * `?by=chunk` query param. Documents is the shape agents use for cross-
 * iteration retrieval (and what users want for "find me docs about X");
 * chunks is the "show me exactly which sections matched" inspection view.
 */
export function SearchTab({
  activeProject,
  onOpenDoc,
}: {
  activeProject: string | null;
  onOpenDoc: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<ClioSearchMode>("auto");
  const [resultType, setResultType] = useState<ResultType>("documents");
  const [matchCount, setMatchCount] = useState(10);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [docHits, setDocHits] = useState<ClioDocumentSearchHit[]>([]);
  const [chunkHits, setChunkHits] = useState<ClioChunkSearchHit[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolvedMode, setResolvedMode] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setRunning(true);
    setError(null);
    try {
      if (resultType === "documents") {
        const res = await searchClio(query.trim(), {
          mode,
          project: activeProject ?? undefined,
          matchCount,
          includeDeleted,
        });
        setDocHits(res.hits);
        setChunkHits([]);
        setResolvedMode(res.mode);
      } else {
        const res = await searchClioChunks(query.trim(), {
          mode,
          project: activeProject ?? undefined,
          matchCount,
          includeDeleted,
        });
        setChunkHits(res.hits);
        setDocHits([]);
        setResolvedMode(res.mode);
      }
      setLastQuery(query.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDocHits([]);
      setChunkHits([]);
    } finally {
      setRunning(false);
    }
  }

  const hitsCount = resultType === "documents" ? docHits.length : chunkHits.length;
  const showEmpty = lastQuery && hitsCount === 0 && !running && !error;

  return (
    <section className="memory-search">
      <h3 className="section-title" style={{ margin: "0 0 0.4rem 0", fontSize: "var(--text-md)" }}>
        Search
        {activeProject && (
          <span style={{ fontWeight: 400, color: "var(--color-text-muted)", marginLeft: "0.4rem" }}>
            in {activeProject}
          </span>
        )}
      </h3>
      <form className="memory-search__form" onSubmit={submit} style={{ flexWrap: "wrap", gap: "0.5rem" }}>
        <input
          type="text"
          placeholder="Query… (e.g. iteration loop, judge verdict)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <select
          value={resultType}
          onChange={(e) => setResultType(e.target.value as ResultType)}
          title="Result type — documents groups by doc with small-to-big snippets; chunks shows raw section hits"
        >
          <option value="documents">documents</option>
          <option value="chunks">chunks</option>
        </select>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as ClioSearchMode)}
          title="Search mode — auto picks hybrid if an embedder is installed, fts otherwise"
        >
          <option value="auto">auto</option>
          <option value="fts">fts</option>
          <option value="semantic">semantic</option>
          <option value="hybrid">hybrid</option>
        </select>
        <select
          value={matchCount}
          onChange={(e) => setMatchCount(parseInt(e.target.value, 10))}
          title="Maximum results to return"
        >
          {[5, 10, 20, 50].map((n) => (
            <option key={n} value={n}>{n} results</option>
          ))}
        </select>
        <button type="submit" className="btn btn--primary btn--small" disabled={running || !query.trim()}>
          {running ? "…" : "Search"}
        </button>
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.4rem",
            fontSize: "var(--text-sm)",
            color: "var(--color-text-muted)",
            cursor: "pointer",
            marginLeft: "0.25rem",
          }}
          title="When on, soft-deleted documents are eligible for results (with a (deleted) badge). Default off — matches the default agent search semantics + Cerefox parity."
        >
          <input
            type="checkbox"
            checked={includeDeleted}
            onChange={(e) => setIncludeDeleted(e.target.checked)}
          />
          Show deleted
        </label>
      </form>

      {error && <div className="form-row__error" style={{ marginTop: "0.5rem" }}>{error}</div>}

      {showEmpty && (
        <div className="form-row__hint" style={{ marginTop: "0.5rem" }}>
          No hits for "{lastQuery}" in <code>{resolvedMode}</code> mode.
        </div>
      )}

      {hitsCount > 0 && (
        <>
          <div className="form-row__hint" style={{ marginTop: "0.5rem", marginBottom: "0.5rem" }}>
            {hitsCount} {resultType === "documents" ? "document" : "chunk"}
            {hitsCount === 1 ? "" : "s"} via <code>{resolvedMode}</code>
          </div>
          <div className="memory-search__hits">
            {resultType === "documents"
              ? docHits.map((h) => (
                  <DocResultCard key={h.documentId} hit={h} onOpen={() => onOpenDoc(h.documentId)} />
                ))
              : chunkHits.map((h) => (
                  <ChunkResultCard key={h.chunkId} hit={h} onOpen={() => onOpenDoc(h.documentId)} />
                ))}
          </div>
        </>
      )}
    </section>
  );
}

function DocResultCard({ hit, onOpen }: { hit: ClioDocumentSearchHit; onOpen: () => void }) {
  return (
    <div className="memory-search__hit" onClick={onOpen}>
      <div className="memory-search__hit-meta">
        <span>
          <strong>{hit.docTitle}</strong>
          {hit.deletedAt && <DeletedBadge deletedAt={hit.deletedAt} />}
          {" — "}{hit.docProjectName}
        </span>
        <span>
          score {hit.bestScore.toFixed(3)}
          {hit.versionCount > 0 && (
            <span style={{ marginLeft: "0.6rem", color: "var(--color-text-muted)" }}>
              {hit.versionCount} version{hit.versionCount === 1 ? "" : "s"}
            </span>
          )}
          <span style={{ marginLeft: "0.6rem", color: "var(--color-text-muted)" }}>
            {hit.isPartial ? "partial" : "small doc"}
          </span>
        </span>
      </div>
      {hit.bestChunkHeadingPath.length > 0 && (
        <div className="form-row__hint" style={{ marginBottom: "0.25rem" }}>
          {hit.bestChunkHeadingPath.join(" › ")}
        </div>
      )}
      <div className="memory-search__hit-snippet">{truncate(hit.bestChunkContent, 800)}</div>
    </div>
  );
}

function ChunkResultCard({ hit, onOpen }: { hit: ClioChunkSearchHit; onOpen: () => void }) {
  return (
    <div className="memory-search__hit" onClick={onOpen}>
      <div className="memory-search__hit-meta">
        <span>
          <strong>{hit.docTitle}</strong>
          {hit.deletedAt && <DeletedBadge deletedAt={hit.deletedAt} />}
          {" — "}{hit.docProjectName}
        </span>
        <span>score {hit.score.toFixed(3)}</span>
      </div>
      {hit.headingPath.length > 0 && (
        <div className="form-row__hint" style={{ marginBottom: "0.25rem" }}>
          {hit.headingPath.join(" › ")}
        </div>
      )}
      <div className="memory-search__hit-snippet">{truncate(hit.content, 600)}</div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}
