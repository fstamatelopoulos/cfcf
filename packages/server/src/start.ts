/**
 * Server start/stop lifecycle.
 *
 * Handles graceful shutdown: on SIGINT/SIGTERM, all active agent processes
 * are killed, loop states are marked failed (preserves disk state), history
 * events are finalized, and the PID file is removed before exit.
 *
 * Also installs uncaught exception / unhandled rejection handlers that log
 * and attempt graceful shutdown instead of dying silently.
 */

import { createApp } from "./app.js";
import { VERSION } from "@cfcf/core";
import {
  writePidFile,
  removePidFile,
  cleanupAllStaleRunningEvents,
  cleanupStaleActiveLoops,
  killAllActiveProcesses,
  getAllActiveProcesses,
  updateHistoryEvent,
  JobScheduler,
  makeUpdateCheckJob,
  clearStaleUpdateFlag,
} from "@cfcf/core";
import { closeClioBackend } from "./clio-backend.js";

let serverInstance: ReturnType<typeof Bun.serve> | null = null;
let scheduler: JobScheduler | null = null;
let shuttingDown = false;

/**
 * Detect if the server process was started with bun --watch.
 * Bun sets BUN_WATCH=1 when running in watch mode (verified via testing).
 * Falls back to checking process.execArgv for '--watch' if that env is not set.
 */
function isWatchMode(): boolean {
  if (process.env.BUN_WATCH === "1" || process.env.BUN_WATCH === "true") return true;
  if (process.execArgv.some((a) => a.includes("--watch"))) return true;
  return false;
}

/**
 * Gracefully shut down the server: kill active agent processes, mark their
 * state as failed, remove PID file, exit.
 *
 * Called on SIGINT/SIGTERM and after uncaught errors.
 */
async function gracefulShutdown(signal: string, exitCode: number = 0): Promise<void> {
  if (shuttingDown) {
    // Already shutting down — second signal forces immediate exit
    console.log(`\nReceived second ${signal}, exiting immediately`);
    process.exit(1);
  }
  shuttingDown = true;

  console.log(`\nReceived ${signal}, shutting down gracefully...`);

  const active = getAllActiveProcesses();
  if (active.length > 0) {
    console.log(`  Killing ${active.length} active agent process(es)...`);

    // Mark each active process's history event as failed (do this first
    // so the state is recorded even if the kill or the server stop races).
    const reason = `Server shutdown (${signal}) while agent was running`;
    for (const entry of active) {
      if (entry.historyEventId) {
        try {
          await updateHistoryEvent(entry.workspaceId, entry.historyEventId, {
            status: "failed",
            error: reason,
            completedAt: new Date().toISOString(),
          });
        } catch {
          // Swallow — we're shutting down
        }
      }
    }

    // Kill all the processes
    killAllActiveProcesses();
  }

  // Stop the JobScheduler so its periodic timer doesn't keep the event
  // loop alive past process.exit (timer is unref'd, but stop() is also
  // explicit about intent for tests / programmatic restarts).
  if (scheduler) {
    try { scheduler.stop(); } catch { /* ignore */ }
    scheduler = null;
  }

  // Close Clio backend (flushes WAL, releases SQLite handle)
  try {
    await closeClioBackend();
  } catch { /* ignore */ }

  // Flush PID file and stop the HTTP listener
  try {
    await removePidFile();
  } catch { /* ignore */ }

  if (serverInstance) {
    try {
      serverInstance.stop();
    } catch { /* ignore */ }
    serverInstance = null;
  }

  console.log("cfcf server stopped");
  process.exit(exitCode);
}

/**
 * Start the cfcf server on the specified port.
 */
export async function startServer(port: number): Promise<ReturnType<typeof Bun.serve>> {
  if (serverInstance) {
    console.error("Server is already running");
    return serverInstance;
  }

  const app = createApp();

  // Warn if we're running in watch mode — file changes will kill active agents
  if (isWatchMode()) {
    console.log(
      "⚠️  Running in watch mode. File changes will restart the server and kill any active agent runs.",
    );
    console.log(
      "    Use plain 'bun run packages/server/src/index.ts' for production testing.",
    );
  }

  // Startup recovery: clean up state from a previous crash/restart
  const staleHistoryCount = await cleanupAllStaleRunningEvents(
    "Server restarted while this event was running",
  );
  if (staleHistoryCount > 0) {
    console.log(`Marked ${staleHistoryCount} stale running history event(s) as failed`);
  }
  const staleLoopCount = await cleanupStaleActiveLoops(
    "Server restarted while this loop was in progress",
  );
  if (staleLoopCount > 0) {
    console.log(`Marked ${staleLoopCount} stale active loop(s) as failed`);
  }

  serverInstance = Bun.serve({
    port,
    fetch: app.fetch,
    // Generous timeout for SSE streaming connections
    idleTimeout: 120,
  });

  // Write PID file so `cfcf server stop` can find us
  await writePidFile(process.pid, port);

  // Signal handlers: graceful shutdown
  process.on("SIGINT", () => {
    gracefulShutdown("SIGINT", 0);
  });
  process.on("SIGTERM", () => {
    gracefulShutdown("SIGTERM", 0);
  });

  // Catch-all error handlers: log then attempt graceful shutdown
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason);
    gracefulShutdown("unhandledRejection", 1).catch(() => process.exit(1));
  });
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err);
    gracefulShutdown("uncaughtException", 1).catch(() => process.exit(1));
  });

  // Local stale-flag GC (item 6.20 follow-up). If the user upgraded within
  // 24h of the last update-check tick, the flag file lingers on disk until
  // the scheduler runs again. Defensive `latestVersion <= VERSION` checks
  // at every read site mean users never see a stale banner, but the file
  // itself doesn't need to stick around. Pure local: no network call, the
  // 24h scheduler tick stays the canonical "is anything newer?" check.
  try {
    const cleared = await clearStaleUpdateFlag(VERSION);
    if (cleared) console.log(`Cleared stale update-available flag (running v${VERSION} caught up to flagged version)`);
  } catch { /* best-effort */ }

  // Start the JobScheduler with the built-in update-check job (item 6.20).
  // The scheduler's loadState + runOnStartIfDue catches missed-tick across
  // server restarts, so a freshly-restarted server usually re-checks
  // immediately. Network failures inside the job are recorded on the job's
  // lastError -- they never crash the server.
  try {
    scheduler = new JobScheduler();
    scheduler.register(makeUpdateCheckJob({ currentVersion: VERSION }));
    // Fire-and-forget: scheduler.start() awaits state-load + first tick,
    // but we don't want server startup to block on a 24h-interval job
    // catching up over a slow network. Errors are best-effort logged.
    scheduler.start().catch((err) => {
      console.error(
        `JobScheduler start failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  } catch (err) {
    console.error(
      `JobScheduler init failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  console.log(`cfcf server v${VERSION} listening on http://localhost:${port}`);
  return serverInstance;
}

/**
 * Stop the running server (programmatic, e.g. from tests or /api/shutdown).
 */
export async function stopServer(): Promise<void> {
  if (scheduler) {
    try { scheduler.stop(); } catch { /* ignore */ }
    scheduler = null;
  }
  if (serverInstance) {
    serverInstance.stop();
    serverInstance = null;
    await removePidFile();
    console.log("cfcf server stopped");
  }
}

/**
 * Check if the server is currently running.
 */
export function isServerRunning(): boolean {
  return serverInstance !== null;
}
