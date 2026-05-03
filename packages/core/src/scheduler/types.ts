/**
 * JobScheduler types (item 6.20).
 *
 * Minimal periodic-job primitive. The scheduler wakes every `tickIntervalMs`
 * and runs any registered job whose `lastRun + intervalMs` has elapsed. State
 * is persisted to disk so missed ticks across server restarts are bounded by
 * each job's own interval rather than lost forever.
 *
 * Built-in jobs are registered programmatically by core (today: just
 * `update-check`). User-defined jobs (cron expressions, schedule-management
 * UX, mutex/concurrency) are intentionally out of scope and deferred to 6.13.
 */

export interface Job {
  /** Stable id; used as the persistence key. Must be unique per scheduler. */
  id: string;
  /** Minimum interval between successful runs, in milliseconds. */
  intervalMs: number;
  /**
   * The work itself. Resolves on success; rejects on failure. The scheduler
   * catches rejections, records them on `lastError`, and still bumps
   * `lastRun` so a perpetually failing job doesn't hot-loop.
   */
  fn: () => Promise<void>;
  /** Last attempted run (set + persisted by the scheduler). */
  lastRun?: Date;
  /** Last error string, if the most recent run rejected. */
  lastError?: string;
}

/** On-disk shape of `~/.cfcf/scheduler-state.json`. Keep small + forward-compatible. */
export interface SchedulerStateFile {
  version: 1;
  jobs: Record<
    string,
    {
      lastRun: string | null;
      lastError: string | null;
    }
  >;
}
