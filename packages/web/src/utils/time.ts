/**
 * Shared time/duration formatters for the web UI.
 *
 * Kept in one place so the live timer in PhaseIndicator and the static
 * duration column in ProjectHistory render identically.
 */

/**
 * Format a duration between two ISO timestamps (or from an ISO timestamp
 * to "now" if completedAt is omitted).
 *
 * - < 1s  -> "0s"
 * - < 1m  -> "12s"
 * - < 1h  -> "2m 14s"
 * - >= 1h -> "1h 03m"
 *
 * Returns "-" if startedAt is missing or invalid.
 */
export function formatDuration(startedAt?: string, completedAt?: string): string {
  if (!startedAt) return "-";
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return "-";
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = Math.max(0, end - start);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/**
 * Like formatDuration, but returns "running" when no completedAt is supplied.
 * Matches the prior ProjectHistory column behavior.
 */
export function formatDurationOrRunning(startedAt: string, completedAt?: string): string {
  if (!completedAt) return "running";
  return formatDuration(startedAt, completedAt);
}
