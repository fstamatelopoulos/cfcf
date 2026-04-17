/**
 * Project history for cfcf.
 *
 * Tracks every agent invocation (review, iteration, document) chronologically
 * in a per-project history.json file. This is append-only in spirit (events
 * are added, then updated in place when they complete).
 *
 * File: ~/.cfcf/projects/<id>/history.json
 *
 * Unlike loop-state.json (which is reset on each startLoop), history accumulates
 * across runs. It's the authoritative record of what happened when.
 */

import { join } from "path";
import { readFile, writeFile, mkdir } from "fs/promises";
import { getProjectDir } from "./projects.js";

const HISTORY_FILENAME = "history.json";

// --- Event types ---

export type HistoryEventType = "review" | "iteration" | "document";

export type HistoryEventStatus = "running" | "completed" | "failed";

export interface BaseHistoryEvent {
  /** Unique ID for this event */
  id: string;
  type: HistoryEventType;
  status: HistoryEventStatus;
  startedAt: string;
  completedAt?: string;
  /** Log file name (not absolute path, just the filename under the project's log dir) */
  logFile: string;
  /** Adapter used (e.g. "claude-code", "codex") */
  agent: string;
  /** Model (if configured) */
  model?: string;
  /** Error message if failed */
  error?: string;
}

export interface ReviewHistoryEvent extends BaseHistoryEvent {
  type: "review";
  /** Readiness assessment result */
  readiness?: string;
}

export interface IterationHistoryEvent extends BaseHistoryEvent {
  type: "iteration";
  iteration: number;
  branch: string;
  /** Dev log file name */
  devLogFile: string;
  /** Judge log file name */
  judgeLogFile: string;
  /** Dev agent adapter (may differ from base event) */
  devAgent: string;
  /** Judge agent adapter */
  judgeAgent: string;
  devExitCode?: number;
  judgeExitCode?: number;
  judgeDetermination?: string;
  judgeQuality?: number;
  merged?: boolean;
}

export interface DocumentHistoryEvent extends BaseHistoryEvent {
  type: "document";
}

export type HistoryEvent = ReviewHistoryEvent | IterationHistoryEvent | DocumentHistoryEvent;

// --- Storage ---

function getHistoryPath(projectId: string): string {
  return join(getProjectDir(projectId), HISTORY_FILENAME);
}

/**
 * Read the history file. Returns an empty array if the file doesn't exist.
 */
export async function readHistory(projectId: string): Promise<HistoryEvent[]> {
  try {
    const raw = await readFile(getHistoryPath(projectId), "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as HistoryEvent[];
    return [];
  } catch {
    return [];
  }
}

/**
 * Write the history file (overwrites).
 */
async function writeHistory(projectId: string, events: HistoryEvent[]): Promise<void> {
  const dir = getProjectDir(projectId);
  await mkdir(dir, { recursive: true });
  await writeFile(getHistoryPath(projectId), JSON.stringify(events, null, 2) + "\n", "utf-8");
}

/**
 * Append a new history event. Returns the event (which now has its id set).
 */
export async function appendHistoryEvent(
  projectId: string,
  event: HistoryEvent,
): Promise<HistoryEvent> {
  const events = await readHistory(projectId);
  events.push(event);
  await writeHistory(projectId, events);
  return event;
}

/**
 * Update an existing history event by id. Merges the patch into the existing event.
 * If the event doesn't exist, this is a no-op.
 */
export async function updateHistoryEvent(
  projectId: string,
  id: string,
  patch: Partial<HistoryEvent>,
): Promise<HistoryEvent | null> {
  const events = await readHistory(projectId);
  const idx = events.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  events[idx] = { ...events[idx], ...patch } as HistoryEvent;
  await writeHistory(projectId, events);
  return events[idx];
}

/**
 * Clean up stale "running" events for a project by marking them as "failed".
 * Called on server startup to recover from crashes/restarts.
 * Returns the number of events marked as failed.
 */
export async function cleanupStaleRunningEvents(
  projectId: string,
  reason: string = "Server restarted while this event was running",
): Promise<number> {
  const events = await readHistory(projectId);
  let changed = 0;
  const now = new Date().toISOString();
  for (const event of events) {
    if (event.status === "running") {
      event.status = "failed";
      event.error = reason;
      event.completedAt = now;
      changed++;
    }
  }
  if (changed > 0) {
    await writeHistory(projectId, events);
  }
  return changed;
}

/**
 * Clean up stale running events across all projects.
 * Returns the total number of events marked failed.
 */
export async function cleanupAllStaleRunningEvents(
  reason: string = "Server restarted while this event was running",
): Promise<number> {
  // Lazy import to avoid circular dep
  const { listProjects } = await import("./projects.js");
  const projects = await listProjects();
  let total = 0;
  for (const p of projects) {
    total += await cleanupStaleRunningEvents(p.id, reason);
  }
  return total;
}
