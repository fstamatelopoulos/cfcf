/**
 * On-demand PA-session liveness check for the workspace card chip
 * + Status tab indicator.
 *
 * The boot-reconcile path (boot-reconcile.ts) runs ONCE at server
 * startup to flip stale `running` pa-session events to `failed` via
 * the same `process.kill(pid, 0)` primitive. This module exposes
 * the per-workspace check as an API-callable function so the
 * dashboard's "PA active" chip can reflect real liveness on every
 * `/api/workspaces` poll — not just whatever the on-disk history
 * status says.
 *
 * Side benefit beyond the chip itself: if a PA session terminates
 * uncleanly (shell killed, terminal closed without an exit
 * handshake), `status: "running"` lingers in history.json until
 * the next server boot. This check correctly reports "not active"
 * for that case in real time, no boot required.
 *
 * Mirrors the `getActiveAgent` / `getActiveAgentsForWorkspaces`
 * pattern in `active-agent.ts` so the `/api/workspaces` enrichment
 * follows a single shape.
 */

import type { PaSessionHistoryEvent } from "../workspace-history.js";
import { readHistory } from "../workspace-history.js";

export interface PaSessionLiveness {
  active: true;
  sessionId: string;
  /** ISO timestamp when the PA session started. */
  startedAt: string;
  /** Server-recorded launcher PID for the live process. */
  launcherPid: number;
  /** History event id (for the UI to deep-link / filter). */
  eventId: string;
}

/**
 * Return liveness details for the workspace's PA session, or `null`
 * if no live PA exists.
 *
 * Algorithm:
 *   1. Read history events.
 *   2. Filter to `pa-session` events with `status === "running"`.
 *   3. Walk newest-first; the first one whose `launcherPid` is
 *      alive (per `process.kill(pid, 0)`) wins.
 *   4. Pre-v0.24 events without `launcherPid` are skipped — there's
 *      no precise way to verify them, and a stale chip is worse
 *      than no chip. Those events are still cleaned up by
 *      boot-reconcile's mtime fallback at next server boot.
 */
export async function getPaSessionLiveness(
  workspaceId: string,
): Promise<PaSessionLiveness | null> {
  let events;
  try {
    events = await readHistory(workspaceId);
  } catch {
    return null; // history file missing / unreadable; safest to claim no PA
  }

  // Find pa-session events in `running` state. Sort newest-first so
  // we surface the most recent live session if multiple exist
  // (uncommon — usually one at most; defensive against accidental
  // duplicates).
  const candidates = events
    .filter((e) => e.type === "pa-session" && e.status === "running")
    .sort(
      (a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    ) as PaSessionHistoryEvent[];

  for (const ev of candidates) {
    if (typeof ev.launcherPid !== "number") continue;
    if (!isPidAlive(ev.launcherPid)) continue;
    return {
      active: true,
      sessionId: ev.sessionId,
      startedAt: ev.startedAt,
      launcherPid: ev.launcherPid,
      eventId: ev.id,
    };
  }
  return null;
}

/**
 * Batch resolver for multiple workspaces — used by the dashboard
 * list endpoint. Same shape as
 * `getActiveAgentsForWorkspaces(...)` for callsite symmetry.
 */
export async function getPaSessionsForWorkspaces(
  workspaceIds: string[],
): Promise<Record<string, PaSessionLiveness | null>> {
  const out: Record<string, PaSessionLiveness | null> = {};
  for (const id of workspaceIds) {
    out[id] = await getPaSessionLiveness(id);
  }
  return out;
}

/**
 * Primitive: is this PID currently running and signalable?
 *
 * `process.kill(pid, 0)` sends nothing — it just exercises the
 * permission/lookup path. Throws on failure:
 *   - ESRCH ("no such process") → not running → return false
 *   - EPERM ("operation not permitted") → exists but owned by
 *     another user → return true (still alive, just not ours)
 *
 * Exported for direct use by tests + the boot-reconcile path
 * (which has its own inline implementation today; could migrate
 * to this helper for consistency, out of scope for this commit).
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EPERM") return true;
    return false;
  }
}
