/**
 * Server start/stop lifecycle.
 */

import { createApp } from "./app.js";
import { VERSION } from "@cfcf/core";
import { writePidFile, removePidFile, cleanupAllStaleRunningEvents } from "@cfcf/core";

let serverInstance: ReturnType<typeof Bun.serve> | null = null;

/**
 * Start the cfcf server on the specified port.
 */
export async function startServer(port: number): Promise<ReturnType<typeof Bun.serve>> {
  if (serverInstance) {
    console.error("Server is already running");
    return serverInstance;
  }

  const app = createApp();

  // Clean up any stale "running" history events from a previous crash/restart.
  // Agent processes don't survive server restarts, so any "running" event
  // is orphaned and should be marked as failed.
  const cleaned = await cleanupAllStaleRunningEvents(
    "Server restarted while this event was running",
  );
  if (cleaned > 0) {
    console.log(`Marked ${cleaned} stale running event(s) as failed`);
  }

  serverInstance = Bun.serve({
    port,
    fetch: app.fetch,
    // Generous timeout for SSE streaming connections
    idleTimeout: 120,
  });

  // Write PID file so `cfcf server stop` can find us
  await writePidFile(process.pid, port);

  // Clean up PID file on exit
  process.on("SIGINT", async () => {
    await removePidFile();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await removePidFile();
    process.exit(0);
  });

  console.log(`cfcf server v${VERSION} listening on http://localhost:${port}`);
  return serverInstance;
}

/**
 * Stop the running server.
 */
export async function stopServer(): Promise<void> {
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
