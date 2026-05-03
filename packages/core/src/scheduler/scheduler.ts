/**
 * JobScheduler -- minimal periodic-job primitive (item 6.20).
 *
 * Single periodic tick (~60 s by default) walks every registered job and
 * runs the ones whose interval has elapsed since `lastRun`. State persists
 * after each job run so a server restart costs at most one interval of
 * "missed tick" latency per job (not the full interval forever).
 *
 * Why not a per-job timer? One tick keeps the seam tiny (~70 lines) and
 * covers everything 6.20 needs. 6.13 will extend this primitive with cron
 * expressions, user-defined jobs, and concurrency control once its research
 * doc validates the interface against real workloads.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Job, SchedulerStateFile } from "./types.js";

const DEFAULT_TICK_INTERVAL_MS = 60_000;

export interface JobSchedulerOptions {
  /** Wake-up cadence for the periodic tick. Default 60 s. */
  tickIntervalMs?: number;
  /** Override the on-disk state file path. Default ~/.cfcf/scheduler-state.json. */
  statePath?: string;
  /**
   * If true, run an immediate tick on `start()` so jobs whose intervals
   * elapsed while the process was stopped fire right away. Default true.
   */
  runOnStartIfDue?: boolean;
}

/** Default state-file location: ~/.cfcf/scheduler-state.json. */
export function defaultStatePath(): string {
  return join(homedir(), ".cfcf", "scheduler-state.json");
}

export class JobScheduler {
  private readonly jobs = new Map<string, Job>();
  private readonly tickIntervalMs: number;
  private readonly statePath: string;
  private readonly runOnStartIfDue: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stateLoaded = false;

  constructor(opts: JobSchedulerOptions = {}) {
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.statePath = opts.statePath ?? defaultStatePath();
    this.runOnStartIfDue = opts.runOnStartIfDue ?? true;
  }

  register(job: Job): void {
    if (this.jobs.has(job.id)) {
      throw new Error(`JobScheduler: job '${job.id}' already registered`);
    }
    if (job.intervalMs <= 0) {
      throw new Error(`JobScheduler: job '${job.id}' has non-positive intervalMs`);
    }
    this.jobs.set(job.id, job);
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /**
   * Load persisted state, optionally fire an immediate tick (catches missed
   * ticks across restarts), then schedule the periodic timer. Idempotent:
   * calling start() twice is a no-op on the second call.
   */
  async start(): Promise<void> {
    if (this.timer) return;
    await this.loadState();
    if (this.runOnStartIfDue) {
      await this.tick();
    }
    this.timer = setInterval(() => {
      // Swallow: the periodic tick must never throw out of the timer.
      this.tick().catch(() => { /* logged inside runJob */ });
    }, this.tickIntervalMs);
    // Don't keep the event loop alive solely for the scheduler tick.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Visit every registered job; run those whose interval has elapsed.
   * Exported so tests can drive ticks deterministically without waiting on
   * `setInterval`.
   */
  async tick(): Promise<void> {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      const last = job.lastRun?.getTime() ?? 0;
      if (now - last >= job.intervalMs) {
        await this.runJob(job);
      }
    }
  }

  private async runJob(job: Job): Promise<void> {
    try {
      await job.fn();
      job.lastError = undefined;
    } catch (err) {
      job.lastError = err instanceof Error ? err.message : String(err);
    }
    // Bump lastRun even on failure so we don't hot-loop a broken job. The
    // user sees the error via doctor / scheduler-state.json; backoff is the
    // configured interval.
    job.lastRun = new Date();
    await this.persistState();
  }

  private async loadState(): Promise<void> {
    if (this.stateLoaded) return;
    this.stateLoaded = true;
    try {
      const raw = await readFile(this.statePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<SchedulerStateFile>;
      if (!parsed || parsed.version !== 1 || !parsed.jobs) return;
      for (const [id, entry] of Object.entries(parsed.jobs)) {
        const job = this.jobs.get(id);
        if (!job || !entry) continue;
        if (entry.lastRun) {
          const d = new Date(entry.lastRun);
          if (!Number.isNaN(d.getTime())) job.lastRun = d;
        }
        if (entry.lastError) job.lastError = entry.lastError;
      }
    } catch (err: unknown) {
      // Missing file is normal on first run; corrupt file is non-fatal --
      // we'd rather lose the state and re-tick than crash startup.
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return;
      }
      // Fall through silently for parse errors etc.
    }
  }

  private async persistState(): Promise<void> {
    const file: SchedulerStateFile = { version: 1, jobs: {} };
    for (const job of this.jobs.values()) {
      file.jobs[job.id] = {
        lastRun: job.lastRun ? job.lastRun.toISOString() : null,
        lastError: job.lastError ?? null,
      };
    }
    try {
      await mkdir(dirname(this.statePath), { recursive: true });
      await writeFile(this.statePath, JSON.stringify(file, null, 2) + "\n", "utf-8");
    } catch {
      // Best-effort: state persistence should never break the scheduler.
    }
  }
}
