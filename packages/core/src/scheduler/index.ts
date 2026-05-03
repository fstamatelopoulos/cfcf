/**
 * Public entry point for the JobScheduler primitive (item 6.20).
 *
 * Built-in jobs are registered programmatically by core. User-defined jobs
 * (cron expressions, schedule-management UX, mutex/concurrency) are deferred
 * to 6.13, which extends this primitive rather than duplicating it.
 */

export { JobScheduler, defaultStatePath } from "./scheduler.js";
export type { JobSchedulerOptions } from "./scheduler.js";
export type { Job, SchedulerStateFile } from "./types.js";
