import type { ArchitectSignals } from "../types";

const readinessMeta: Record<
  string,
  { color: string; label: string; guidance: string }
> = {
  READY: {
    color: "var(--color-success)",
    label: "READY",
    guidance: "The Problem Pack is ready. You can click Start Loop to begin iterating.",
  },
  NEEDS_REFINEMENT: {
    color: "var(--color-warning)",
    label: "NEEDS_REFINEMENT",
    guidance:
      "The architect found issues with the Problem Pack. Review the gaps and suggestions below, edit the files under problem-pack/ in your repo, and rerun Review.",
  },
  BLOCKED: {
    color: "var(--color-error)",
    label: "BLOCKED",
    guidance:
      "The architect flagged blockers that prevent a loop from being useful. Resolve the gaps below before retrying Review or starting a loop.",
  },
};

function Section({
  title,
  items,
  emphasize = false,
}: {
  title: string;
  items: string[];
  emphasize?: boolean;
}) {
  if (!items || items.length === 0) return null;
  return (
    <details className="architect-review__section" open={emphasize}>
      <summary className="architect-review__summary">
        {title} <span className="architect-review__count">({items.length})</span>
      </summary>
      <ul className="architect-review__list">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </details>
  );
}

export function ArchitectReview({
  signals,
  compact = false,
}: {
  signals: ArchitectSignals;
  compact?: boolean;
}) {
  const meta = readinessMeta[signals.readiness] ?? {
    color: "inherit",
    label: signals.readiness,
    guidance: "",
  };

  const isRefinementOrBlocked =
    signals.readiness === "NEEDS_REFINEMENT" || signals.readiness === "BLOCKED";

  return (
    <div className={`architect-review${compact ? " architect-review--compact" : ""}`}>
      <div className="architect-review__header">
        <span className="architect-review__readiness" style={{ color: meta.color }}>
          {meta.label}
        </span>
        {signals.gaps.length + signals.suggestions.length + signals.risks.length > 0 && (
          <span className="architect-review__counts">
            {signals.gaps.length} gap{signals.gaps.length === 1 ? "" : "s"} ·{" "}
            {signals.suggestions.length} suggestion
            {signals.suggestions.length === 1 ? "" : "s"} · {signals.risks.length} risk
            {signals.risks.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {meta.guidance && (
        <div
          className="architect-review__guidance"
          style={{ borderLeftColor: meta.color }}
        >
          {meta.guidance}
        </div>
      )}

      <Section title="Gaps" items={signals.gaps} emphasize={isRefinementOrBlocked} />
      <Section
        title="Suggestions"
        items={signals.suggestions}
        emphasize={isRefinementOrBlocked}
      />
      <Section title="Risks" items={signals.risks} />

      {signals.recommended_approach && (
        <details className="architect-review__section">
          <summary className="architect-review__summary">Recommended approach</summary>
          <p className="architect-review__approach">{signals.recommended_approach}</p>
        </details>
      )}
    </div>
  );
}
