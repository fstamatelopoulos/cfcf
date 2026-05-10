/**
 * Boot-time reconciliation of stale Product-Architect history events.
 *
 * Item 6.9 follow-up (2026-05-09): the PA launcher's `finally` block
 * is the canonical place that flips a `running` history event to
 * `completed` / `failed` after the agent exits. That works for the
 * common case (agent exits normally, Ctrl-C inside the agent's TUI,
 * etc.) but it does NOT cover:
 *
 *   - **User Ctrl-C'd the launcher process itself**, not the agent —
 *     `cfcf spec` got SIGINT before its finally block ran.
 *   - **cfcf server crashed or was kill -9'd** during a PA session.
 *   - **OS panic / power loss** mid-session.
 *
 * In all three cases the `running` history event sits stale forever:
 * the PA process is long-dead but the web UI / `cfcf workspace show`
 * still reports a session as "running". Real dogfood (2026-05-09
 * tracker workspace) caught this exact gap.
 *
 * Fix: on every server boot, scan every workspace's history for
 * `running` PA events. For each, compare the on-disk session-log
 * file's mtime against a staleness threshold (5 minutes by default —
 * a live session writes turn-by-turn, so a quiet 5+ min gap means
 * the launcher is gone). Stale entries get flipped to `failed` with
 * a clear note + the cfcf-side fallback ingest fires so the
 * session's content reaches Clio. Live sessions (mtime within the
 * threshold) are left untouched.
 *
 * Safe to run on every boot — idempotent + read-mostly. Costs are:
 *
 *   - One `readHistory()` per workspace (small JSON file)
 *   - One `stat()` per running PA event found
 *   - One Clio ingest per stale event with content (sha256-deduped
 *     so a second run is a no-op)
 *   - One `meta.json` write per reconciled event
 *
 * Mirrors the orphan-reaper boot pass for stale agent processes
 * (item 6.31), but reaps **history-state drift** rather than
 * processes.
 */

import { stat, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { listWorkspaces } from "../workspaces.js";
import {
  readHistory,
  updateHistoryEvent,
  type HistoryEvent,
  type PaSessionHistoryEvent,
} from "../workspace-history.js";
import { getClioBackend } from "../clio/index.js";
import { effectiveClioProject, formatClioActor, ROLE_PRODUCT_ARCHITECT } from "../clio/index.js";

/**
 * Default staleness threshold. A live PA session writes to its
 * session log on every user turn, so a 5-min quiet period strongly
 * implies the launcher has exited without finalising. Tuneable via
 * the `staleAfterMs` parameter for tests.
 */
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;

export interface PaReconcileResult {
  scannedWorkspaces: number;
  scannedEvents: number;
  staleEvents: number;
  /** Events whose archive cfcf successfully ingested into Clio. */
  archivedToClio: number;
  /** Events that were stale but had no on-disk content to archive. */
  staleNoContent: number;
  /** Per-workspace breakdown for surface logging. */
  perWorkspace: Array<{
    workspaceId: string;
    workspaceName: string;
    staleSessions: string[];
  }>;
}

/**
 * Scan every workspace and flip stale `running` PA events to `failed`,
 * ingesting the on-disk session archive into Clio along the way.
 *
 * Best-effort throughout: any single workspace failure is logged + the
 * scan continues. Returns a summary the caller can surface.
 */
export async function reconcileStalePaSessions(opts: {
  staleAfterMs?: number;
} = {}): Promise<PaReconcileResult> {
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const now = Date.now();

  const result: PaReconcileResult = {
    scannedWorkspaces: 0,
    scannedEvents: 0,
    staleEvents: 0,
    archivedToClio: 0,
    staleNoContent: 0,
    perWorkspace: [],
  };

  let workspaces: Awaited<ReturnType<typeof listWorkspaces>>;
  try {
    workspaces = await listWorkspaces();
  } catch (err) {
    console.warn(
      `[pa-reconcile] couldn't list workspaces (${err instanceof Error ? err.message : String(err)}); skipping reconciliation.`,
    );
    return result;
  }

  for (const ws of workspaces) {
    result.scannedWorkspaces++;
    const stale: string[] = [];
    let events: HistoryEvent[];
    try {
      events = await readHistory(ws.id);
    } catch {
      continue; // skip unreadable history files
    }

    for (const ev of events) {
      if (ev.type !== "pa-session" || ev.status !== "running") continue;
      result.scannedEvents++;

      const paEvent = ev as PaSessionHistoryEvent;
      const sessionFile = join(ws.repoPath, paEvent.sessionFilePath);
      let sessionMtimeMs: number | null = null;
      try {
        const st = await stat(sessionFile);
        sessionMtimeMs = st.mtimeMs;
      } catch { /* file missing → still treat the event as stale */ }

      // Live? mtime within the threshold means a turn-by-turn writer
      // is alive — leave the event untouched.
      if (sessionMtimeMs !== null && now - sessionMtimeMs < staleAfterMs) {
        continue;
      }

      result.staleEvents++;
      stale.push(paEvent.sessionId);

      // Flip the event to "failed" with a self-describing note. We
      // don't claim "completed" because we genuinely don't know if the
      // agent finished its work — only that the launcher didn't reach
      // its finalisation hook. The web UI surfaces this state clearly.
      try {
        await updateHistoryEvent(ws.id, paEvent.id, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: "Process detection lost — launcher didn't finalise this session before exiting (likely SIGINT to the parent shell, server crash, or OS panic). Session log on disk was preserved + ingested to Clio if it had content.",
        });
      } catch (err) {
        console.warn(
          `[pa-reconcile] failed to update event ${paEvent.id} for workspace ${ws.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      // Run the cfcf-side fallback ingest (mirrors what the launcher
      // would have done in its `finally` block). Inlined here rather
      // than importing from launcher.ts to avoid the circular dep
      // (launcher imports from workspaces, which would now import
      // boot-reconcile, which would import launcher).
      const ingested = await fallbackIngestPaSessionArchiveLite({
        sessionFile,
        workspaceId: ws.id,
        workspaceClioProject: effectiveClioProject({
          id: ws.id,
          clioProject: ws.clioProject,
        }),
        sessionId: paEvent.sessionId,
        paAgentAdapter: paEvent.agent ?? "unknown",
        paAgentModel: paEvent.model,
      });

      if (ingested) {
        result.archivedToClio++;
      } else {
        result.staleNoContent++;
      }

      // Item 6.9 follow-up: PA's primary job is editing problem-pack
      // files, so a stale session likely left some mid-edit state. The
      // workspace.repoPath disk version is the truth — push it to Clio
      // with the PA actor stamp so the audit log shows PA as the
      // writer (not the default user-stamp). Idempotent — sha256
      // dedup means already-ingested content is a no-op. Closes the
      // "PA died mid-session, edits trapped on disk" gap that the
      // session-end fallback covers in the happy path.
      try {
        const { ingestProblemPack } = await import("../clio/loop-ingest.js");
        const paActor = formatClioActor(
          ROLE_PRODUCT_ARCHITECT,
          paEvent.agent ?? "unknown",
          paEvent.model,
        );
        await ingestProblemPack(
          getClioBackend(),
          ws,
          "pa-boot-reconcile",
          paActor,
        );
      } catch (err) {
        console.warn(
          `[pa-reconcile] problem-pack ingest failed for ${paEvent.sessionId} (best-effort): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Item 6.35 follow-up: also rescue the workspace-memory digest
      // (`PA-memory.md`). Symmetric with the session-end fallback.
      // If PA was mid-edit on `.cfcf-pa/workspace-summary.md` when
      // it died, the disk version is the truth — push it.
      try {
        const { fallbackIngestPaWorkspaceMemory } = await import("./launcher.js");
        await fallbackIngestPaWorkspaceMemory({
          paCachePath: join(ws.repoPath, ".cfcf-pa"),
          workspaceId: ws.id,
          workspaceClioProject: effectiveClioProject({
            id: ws.id,
            clioProject: ws.clioProject,
          }),
          sessionId: paEvent.sessionId,
          paAgentAdapter: paEvent.agent ?? "unknown",
          paAgentModel: paEvent.model,
        });
      } catch (err) {
        console.warn(
          `[pa-reconcile] PA-memory.md ingest failed for ${paEvent.sessionId} (best-effort): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (stale.length > 0) {
      result.perWorkspace.push({
        workspaceId: ws.id,
        workspaceName: ws.name,
        staleSessions: stale,
      });
    }
  }

  return result;
}

/**
 * Trimmed-down variant of `fallbackIngestPaSessionArchive` that takes
 * an absolute session-file path + project name (rather than re-deriving
 * them inside). Lives here to avoid a circular import between
 * `launcher.ts` and this file.
 *
 * Returns `true` iff a doc was successfully created in Clio; `false`
 * for all skip / failure paths (file missing, content < 500 chars,
 * Clio unreachable).
 */
async function fallbackIngestPaSessionArchiveLite(opts: {
  sessionFile: string;
  workspaceId: string;
  workspaceClioProject: string;
  sessionId: string;
  paAgentAdapter: string;
  paAgentModel?: string;
}): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(opts.sessionFile, "utf-8");
  } catch {
    return false;
  }
  if (content.trim().length < 500) return false;

  const actor = formatClioActor(ROLE_PRODUCT_ARCHITECT, opts.paAgentAdapter, opts.paAgentModel);

  let archiveDocId: string;
  try {
    const backend = getClioBackend();
    const result = await backend.ingest({
      project: opts.workspaceClioProject,
      title: `pa-session-${opts.sessionId}`,
      content,
      source: "cfcf-auto:pa-session-boot-reconcile",
      author: actor,
      metadata: {
        role: "pa",
        artifact_type: "session-archive",
        workspace_id: opts.workspaceId,
        session_id: opts.sessionId,
        ingested_by: "cfcf-boot-reconcile",
      },
      // Item 6.35 follow-up (2026-05-10): see launcher.ts comment
      // — update-if-exists prevents duplicate docs when the agent
      // pushed an earlier snapshot during the session.
      updateIfExists: true,
    });
    archiveDocId = result.document?.id ?? "";
    // Internal-path usage log (item 6.35 follow-up): boot-reconcile
    // bypasses the HTTP middleware, so the Usage tab wouldn't see
    // the rescue without this call.
    try {
      backend.logUsage({
        operation: "ingest",
        accessPath: "internal",
        requestor: actor,
        documentId: archiveDocId || null,
        projectId: result.document?.projectId ?? null,
        queryText: null,
        resultCount: null,
        extra: { artifact_type: "session-archive", ingested_by: "cfcf-boot-reconcile", action: result.action },
      });
    } catch { /* best-effort */ }
  } catch (err) {
    console.warn(
      `[pa-reconcile] couldn't ingest session archive for ${opts.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
  if (!archiveDocId) return false;

  // Update meta.json so the next launcher's discrepancy check sees the
  // synced state. The session file's parent dir IS the .cfcf-pa dir.
  try {
    const paCachePath = opts.sessionFile.replace(/\/[^/]+$/, "");
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(await readFile(join(paCachePath, "meta.json"), "utf-8"));
    } catch { /* treat as new file */ }
    parsed.lastSyncAt = new Date().toISOString();
    parsed.lastSessionArchiveDocId = archiveDocId;
    await writeFile(
      join(paCachePath, "meta.json"),
      JSON.stringify(parsed, null, 2) + "\n",
      "utf-8",
    );
  } catch { /* best-effort */ }

  return true;
}
