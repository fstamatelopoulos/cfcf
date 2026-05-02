/**
 * Workspace history for cfcf.
 *
 * Tracks every agent invocation (review, iteration, document) chronologically
 * in a per-workspace history.json file. This is append-only in spirit (events
 * are added, then updated in place when they complete).
 *
 * File: ~/.cfcf/workspaces/<id>/history.json
 *
 * Unlike loop-state.json (which is reset on each startLoop), history accumulates
 * across runs. It's the authoritative record of what happened when.
 */

import { join } from "path";
import { readFile, writeFile, mkdir } from "fs/promises";
import { getWorkspaceDir } from "./workspaces.js";
import type { ArchitectSignals, ReflectionSignals, IterationHealth, JudgeSignals, DevSignals } from "./types.js";

const HISTORY_FILENAME = "history.json";

// --- Event types ---

export type HistoryEventType =
  | "review"
  | "iteration"
  | "document"
  | "reflection"
  | "pa-session"
  | "loop-stopped";  // item 6.25 — user-initiated stop_loop_now

export type HistoryEventStatus = "running" | "completed" | "failed";

export interface BaseHistoryEvent {
  /** Unique ID for this event */
  id: string;
  type: HistoryEventType;
  status: HistoryEventStatus;
  startedAt: string;
  completedAt?: string;
  /**
   * Log file name (not absolute path, just the filename under the
   * workspace's log dir). Optional because user-action events
   * (e.g. `loop-stopped`) don't spawn an agent and have no log.
   */
  logFile?: string;
  /**
   * Adapter used (e.g. "claude-code", "codex"). Optional because
   * user-action events (e.g. `loop-stopped`) don't involve an agent.
   */
  agent?: string;
  /** Model (if configured) */
  model?: string;
  /** Error message if failed */
  error?: string;
}

export interface ReviewHistoryEvent extends BaseHistoryEvent {
  type: "review";
  /** Readiness assessment result */
  readiness?: string;
  /**
   * Full parsed architect signals (gaps, suggestions, risks, recommended approach).
   * Persisted inline so prior reviews can be viewed from the History tab even
   * after `cfcf-docs/cfcf-architect-signals.json` is overwritten by a later run.
   */
  signals?: ArchitectSignals;
  /**
   * Whether this review was triggered by the iteration loop's pre-loop
   * review phase (`"loop"`) or by the user via `cfcf review` / the web
   * Review button / `POST /api/workspaces/:id/review` (`"manual"`). Older
   * review events written before v0.7.2 don't have this field -- treat
   * undefined as `"manual"` for backward compat.
   */
  trigger?: "loop" | "manual";
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
  /** Full parsed dev signals, persisted inline so the History tab can expand
   *  even after `cfcf-iteration-signals.json` is overwritten next iteration. */
  devSignals?: DevSignals;
  /** Full parsed judge signals, same rationale as devSignals. */
  judgeSignals?: JudgeSignals;
}

export interface DocumentHistoryEvent extends BaseHistoryEvent {
  type: "document";
  /** Number of files in docs/ that exist after the run (includes new + updated + pre-existing) */
  docsFileCount?: number;
  /** Whether cfcf committed new/changed docs to git */
  committed?: boolean;
  /** Exit code of the documenter process */
  exitCode?: number;
}

export interface ReflectionHistoryEvent extends BaseHistoryEvent {
  type: "reflection";
  /**
   * Iteration this reflection was produced *after* (0 when manually
   * triggered before any iteration runs or outside the loop).
   */
  iteration: number;
  /** Whether this was triggered by the loop or by `cfcf reflect` / the API. */
  trigger: "loop" | "manual";
  /** Parsed reflection signals, persisted inline for history replay. */
  signals?: ReflectionSignals;
  /** Denormalized for fast UI rendering */
  iterationHealth?: IterationHealth;
  /** Whether the reflection agent rewrote the pending plan */
  planModified?: boolean;
  /**
   * When the reflection agent's plan rewrite was rejected by the
   * non-destructive validator, this captures the reason (e.g. "completed
   * item removed: …"). The plan.md on disk is already reverted to the
   * prior version at this point.
   */
  planRejectionReason?: string;
  /** Exit code of the reflection process */
  exitCode?: number;
}

/**
 * Product Architect (PA) interactive session. Unlike the other event
 * types -- which are fire-and-forget agent runs with structured signal
 * outputs -- a PA session is interactive: the user chats with PA via
 * the agent CLI's TUI, and the "outcome" is a Markdown session log +
 * (optionally) a Clio doc update. cfcf writes the bracket info
 * (start/end/exit code/agent config); the agent itself optionally
 * writes a `lastSession` block to `<repo>/.cfcf-pa/meta.json` that
 * cfcf reads on exit to enrich the entry.
 *
 * Plan item 5.14 v2 follow-up. Design:
 * `docs/research/product-architect-design.md` §"History tracking".
 */
export interface PaSessionHistoryEvent extends BaseHistoryEvent {
  type: "pa-session";
  /** PA's session_id (e.g. `pa-2026-04-29T06-07-13-abc123`). */
  sessionId: string;
  /**
   * Path to the session scratchpad relative to the workspace's repo,
   * e.g. `.cfcf-pa/session-pa-2026-04-29T06-07-13-abc123.md`. The web
   * UI fetches this through `/api/workspaces/:id/pa-sessions/:sessionId/file`.
   */
  sessionFilePath: string;
  /**
   * One-line summary of what was accomplished in this session.
   * Written by the PA agent into `<repo>/.cfcf-pa/meta.json` under
   * `lastSession.outcomeSummary`; cfcf reads it post-spawn. Absent
   * when the agent didn't save (Ctrl-D without a "save before you
   * go?" yes).
   */
  outcomeSummary?: string;
  /**
   * Number of decisions/rejections/preferences the agent captured in
   * this session. Read from `lastSession.decisionsCount` in
   * `meta.json`. Absent when the agent didn't save.
   */
  decisionsCount?: number;
  /**
   * Clio doc ID for the per-workspace `pa-workspace-memory` doc that
   * was updated at session end. Surfaced in the web UI as a deep link
   * to the Clio browser. Absent when no Clio sync happened.
   */
  clioWorkspaceMemoryDocId?: string;
  /** Exit code of the agent process. */
  exitCode?: number;
  /** Whether the workspace was registered when PA launched. */
  workspaceRegisteredAtStart: boolean;
  /** Whether the repo was a git repo when PA launched. */
  gitInitializedAtStart: boolean;
  /**
   * Snapshot of how many of the 5 canonical Problem Pack files
   * (problem.md, success.md, constraints.md, hints.md, style-guide.md)
   * existed when PA launched. Helps the history reader understand
   * what state PA started from.
   */
  problemPackFilesAtStart: number;
}

/**
 * Item 6.25: user-initiated `stop_loop_now` event. Captures the
 * iteration the loop stopped at + the user's free-text feedback as an
 * audit note. No agent runs — `logFile` / `agent` from the base are
 * intentionally absent. The same information also appears as a human-
 * readable narrative in `cfcf-docs/iteration-history.md` (appended by
 * `handleStopLoopNow` in `iteration-loop.ts`).
 */
export interface LoopStoppedHistoryEvent extends BaseHistoryEvent {
  type: "loop-stopped";
  iteration: number;
  /** User's free-text feedback at the time of stopping. Audit-only. */
  userFeedback?: string;
}

export type HistoryEvent =
  | ReviewHistoryEvent
  | IterationHistoryEvent
  | DocumentHistoryEvent
  | ReflectionHistoryEvent
  | PaSessionHistoryEvent
  | LoopStoppedHistoryEvent;

// --- Storage ---

function getHistoryPath(workspaceId: string): string {
  return join(getWorkspaceDir(workspaceId), HISTORY_FILENAME);
}

/**
 * Read the history file. Returns an empty array if the file doesn't exist.
 */
export async function readHistory(workspaceId: string): Promise<HistoryEvent[]> {
  try {
    const raw = await readFile(getHistoryPath(workspaceId), "utf-8");
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
async function writeHistory(workspaceId: string, events: HistoryEvent[]): Promise<void> {
  const dir = getWorkspaceDir(workspaceId);
  await mkdir(dir, { recursive: true });
  await writeFile(getHistoryPath(workspaceId), JSON.stringify(events, null, 2) + "\n", "utf-8");
}

/**
 * Append a new history event. Returns the event (which now has its id set).
 */
export async function appendHistoryEvent(
  workspaceId: string,
  event: HistoryEvent,
): Promise<HistoryEvent> {
  const events = await readHistory(workspaceId);
  events.push(event);
  await writeHistory(workspaceId, events);
  return event;
}

/**
 * Update an existing history event by id. Merges the patch into the existing event.
 * If the event doesn't exist, this is a no-op.
 */
export async function updateHistoryEvent(
  workspaceId: string,
  id: string,
  patch: Partial<HistoryEvent>,
): Promise<HistoryEvent | null> {
  const events = await readHistory(workspaceId);
  const idx = events.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  events[idx] = { ...events[idx], ...patch } as HistoryEvent;
  await writeHistory(workspaceId, events);
  return events[idx];
}

/**
 * Clean up stale "running" events for a workspace by marking them as "failed".
 * Called on server startup to recover from crashes/restarts.
 * Returns the number of events marked as failed.
 */
export async function cleanupStaleRunningEvents(
  workspaceId: string,
  reason: string = "Server restarted while this event was running",
): Promise<number> {
  const events = await readHistory(workspaceId);
  let changed = 0;
  const now = new Date().toISOString();
  for (const event of events) {
    if (event.status !== "running") continue;
    // Skip event types that aren't tied to the server's lifecycle.
    // Product Architect (`pa-session`) sessions run in the USER's
    // terminal — both the agent CLI + the launcher that writes the
    // history entry are in the user's process, not the server's.
    // Server restart doesn't affect them; their completion entry
    // arrives whenever the user exits PA. Marking them failed at
    // cleanup time would corrupt an actually-still-running session
    // (and the launcher's eventual update would have to undo it).
    if (event.type === "pa-session") continue;
    event.status = "failed";
    event.error = reason;
    event.completedAt = now;
    changed++;
  }
  if (changed > 0) {
    await writeHistory(workspaceId, events);
  }
  return changed;
}

/**
 * Clean up stale running events across all workspaces.
 * Returns the total number of events marked failed.
 */
export async function cleanupAllStaleRunningEvents(
  reason: string = "Server restarted while this event was running",
): Promise<number> {
  // Lazy import to avoid circular dep
  const { listWorkspaces } = await import("./workspaces.js");
  const workspaces = await listWorkspaces();
  let total = 0;
  for (const w of workspaces) {
    total += await cleanupStaleRunningEvents(w.id, reason);
  }
  return total;
}
