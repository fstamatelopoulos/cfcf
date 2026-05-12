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
import { readFile, writeFile, mkdir, stat } from "fs/promises";
import { getWorkspaceDir } from "./workspaces.js";
import { getLogsDir } from "./constants.js";
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
  /**
   * Whether the standalone review committed its on-disk outputs
   * (architect-review.md, plan.md, cfcf-architect-signals.json,
   * cfcf-architect-instructions.md). `true` when a commit landed;
   * `false` when there were no changes to commit OR the commit failed.
   * Only set for `trigger: "manual"` runs — in-loop reviews commit via
   * the iteration-loop driver itself (the existing
   * `cfcf pre-loop review (<readiness>)` commit). Field added in v0.24
   * (F.1 follow-up).
   */
  committed?: boolean;
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
  /**
   * Dev-only completion timestamp (item F.21, v0.24+). Recorded by
   * `iteration-loop.ts` immediately after the dev agent exits, before
   * the judge starts. Lets the web UI's History tab show per-half
   * durations now that dev + judge each render as their own row.
   * `BaseHistoryEvent.completedAt` is the JUDGE'S (= iteration's)
   * completion time, written when the judge exits + iteration is
   * marked complete. Optional for backward compat with pre-F.21 events.
   */
  devCompletedAt?: string;
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
  /**
   * Whether the standalone reflection committed its on-disk outputs
   * (reflection-analysis.md + decision-log.md append + plan.md rewrite
   * if any). `true` when a commit landed; `false` when there were no
   * changes to commit OR the commit failed. Only set for `trigger:
   * "manual"` runs — in-loop reflections commit via the iteration-loop
   * driver itself and don't surface `committed` on this event (the
   * iteration commit covers that). Field added in v0.24 (F.1 follow-up).
   */
  committed?: boolean;
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
   * Clio doc ID for the per-workspace `PA-memory.md` doc (item 6.9
   * rename — pre-6.9 this was titled `pa-workspace-memory`) that was
   * updated at session end. Surfaced in the web UI as a deep link to
   * the Clio browser. Absent when no Clio sync happened.
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
  /**
   * PID of the launcher process (the `cfcf spec` invocation that
   * spawned the agent). Used by `reconcileStalePaSessions` at boot
   * time to do a precise liveness check via `kill -0 <pid>` instead
   * of the file-mtime heuristic — which false-positived on idle
   * interactive sessions (user thinking / AFK / reading) longer than
   * the staleness threshold. Added in v0.24.0 (F.28). Absent on
   * sessions started before v0.24.0; reconcile falls back to the
   * mtime check in that case. Note: PID is only meaningful on the
   * machine the session ran on — that's always the user's local
   * machine, so the check is local. The launcher's `finally` block
   * still updates status to `completed`/`failed`; this field is
   * defensive coverage for the cases the finally block doesn't run
   * (parent-shell SIGINT, OS panic, server hard-crash).
   */
  launcherPid?: number;
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
 *
 * Status-transition cleanup: when a patch transitions an event AWAY from
 * `failed` (e.g. failed→completed, failed→running), any pre-existing `error`
 * field is cleared automatically. Otherwise the spread merge would preserve
 * a stale error message even though the event is no longer failed — which
 * happens in the wild when `cleanupStaleRunningEvents` racily marks an event
 * failed and the agent's own completion update arrives later (item 6.35
 * follow-up: "Server restarted while this event was running" lingering on
 * successfully-completed runs).
 *
 * Callers can still opt to set `error` explicitly in their patch (e.g. to
 * pass a different error string when transitioning into `failed`); only the
 * implicit-stale case is cleared.
 */
export async function updateHistoryEvent(
  workspaceId: string,
  id: string,
  patch: Partial<HistoryEvent>,
): Promise<HistoryEvent | null> {
  const events = await readHistory(workspaceId);
  const idx = events.findIndex((e) => e.id === id);
  if (idx === -1) return null;

  const merged = { ...events[idx], ...patch } as HistoryEvent;

  // Clear stale `error` when transitioning out of `failed` and the patch
  // didn't explicitly carry an `error` field. Without this, a successful
  // completion still shows the previous failure's error string.
  const transitioningOutOfFailed =
    events[idx].status === "failed" &&
    patch.status !== undefined &&
    patch.status !== "failed";
  const patchSpecifiesError = Object.prototype.hasOwnProperty.call(patch, "error");
  if (transitioningOutOfFailed && !patchSpecifiesError) {
    delete merged.error;
  }

  events[idx] = merged;
  await writeHistory(workspaceId, events);
  return events[idx];
}

/**
 * How recently an event's log file must have been written for the cleanup
 * pass to leave it alone. Tuned to be longer than the typical inter-write
 * gap of an agent that's mid-thinking (LLM round-trips can be 20–40s of
 * silence). 90s gives a comfortable margin without making genuinely-dead
 * events linger forever.
 */
const RECENT_LOG_ACTIVITY_MS = 90_000;

/**
 * Return true if the event's log file shows recent disk-write activity.
 * Used by `cleanupStaleRunningEvents` to skip events whose agent is
 * almost certainly still alive even if the in-memory `active-processes`
 * registry was wiped (e.g. the server boot raced with a still-running
 * loop in another process — the canonical false-positive that triggered
 * the user-visible "Server restarted while this event was running" bug).
 *
 * Conservative on errors: missing log file or stat failure → returns
 * false so the event still gets cleaned (preserves prior behaviour for
 * the normal crash-recovery case).
 */
async function logFileShowsRecentActivity(
  workspaceId: string,
  logFile: string | undefined,
  nowMs: number,
): Promise<boolean> {
  if (!logFile) return false;
  try {
    const path = join(getLogsDir(), workspaceId, logFile);
    const st = await stat(path);
    return nowMs - st.mtimeMs < RECENT_LOG_ACTIVITY_MS;
  } catch {
    return false;
  }
}

/**
 * Collect every log filename associated with an event. Most event types
 * have a single `logFile`; iteration events have separate `devLogFile`
 * and `judgeLogFile`. Cleanup needs to check ALL of them — if EITHER
 * shows recent activity, the agent is alive.
 */
function eventLogFiles(event: HistoryEvent): string[] {
  const files: string[] = [];
  if (event.logFile) files.push(event.logFile);
  if (event.type === "iteration") {
    if (event.devLogFile) files.push(event.devLogFile);
    if (event.judgeLogFile) files.push(event.judgeLogFile);
  }
  return files;
}

/**
 * Clean up stale "running" events for a workspace by marking them as "failed".
 * Called on server startup to recover from crashes/restarts.
 *
 * Liveness check (item 6.35 follow-up): events whose log file shows
 * disk-write activity in the last 90 seconds are skipped — those agents
 * are almost certainly still alive (e.g. running in a parallel server
 * process, or surviving a watch-mode reload via process-group detach).
 * Marking them failed produces the user-visible "Server restarted while
 * this event was running" error that lingers on successfully-completed
 * runs.
 *
 * Returns the number of events marked as failed.
 */
export async function cleanupStaleRunningEvents(
  workspaceId: string,
  reason: string = "Server restarted while this event was running",
): Promise<number> {
  const events = await readHistory(workspaceId);
  let changed = 0;
  const now = new Date().toISOString();
  const nowMs = Date.now();
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

    // Liveness probe: if the log file is still being written to, the
    // agent is alive. Skip cleanup so its eventual completion-update
    // arrives uncorrupted.
    let alive = false;
    for (const lf of eventLogFiles(event)) {
      if (await logFileShowsRecentActivity(workspaceId, lf, nowMs)) {
        alive = true;
        break;
      }
    }
    if (alive) continue;

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
