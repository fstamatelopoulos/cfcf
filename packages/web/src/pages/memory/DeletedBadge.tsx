/**
 * Inline `(deleted)` chip used in Browse / Search / Trash listings to
 * mark soft-deleted documents (item 6.18 round-4). Shows the deletion
 * timestamp on hover so users can spot recently-trashed entries.
 *
 * Visually mirrors the `(system)` badge in ProjectsTab — same chip
 * shape, different palette (info-coloured for system, error-coloured
 * for deleted) so the two read as distinct categories at a glance.
 */
export function DeletedBadge({ deletedAt }: { deletedAt: string }) {
  return (
    <span
      title={`Soft-deleted on ${deletedAt}`}
      style={{
        display: "inline-block",
        marginLeft: "0.5rem",
        padding: "0.05rem 0.4rem",
        fontSize: "var(--text-xs)",
        background: "color-mix(in srgb, var(--color-error) 14%, transparent)",
        color: "var(--color-error)",
        borderRadius: 3,
        fontFamily: "var(--font-mono)",
        verticalAlign: "middle",
      }}
    >
      deleted
    </span>
  );
}
