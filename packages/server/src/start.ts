/**
 * Server start/stop lifecycle.
 */

import { createApp } from "./app.js";
import { VERSION } from "@cfcf/core";
import { writePidFile, removePidFile } from "@cfcf/core";

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

  serverInstance = Bun.serve({
    port,
    fetch: app.fetch,
    // Agent runs can take minutes/hours -- disable idle timeout
    idleTimeout: 255, // max value in Bun (seconds)
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
