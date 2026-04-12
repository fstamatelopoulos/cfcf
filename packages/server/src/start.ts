/**
 * Server start/stop lifecycle.
 */

import { createApp } from "./app.js";
import { VERSION } from "@cfcf/core";

let serverInstance: ReturnType<typeof Bun.serve> | null = null;

/**
 * Start the cfcf server on the specified port.
 */
export function startServer(port: number): ReturnType<typeof Bun.serve> {
  if (serverInstance) {
    console.error("Server is already running");
    return serverInstance;
  }

  const app = createApp();

  serverInstance = Bun.serve({
    port,
    fetch: app.fetch,
  });

  console.log(`cfcf server v${VERSION} listening on http://localhost:${port}`);
  return serverInstance;
}

/**
 * Stop the running server.
 */
export function stopServer(): void {
  if (serverInstance) {
    serverInstance.stop();
    serverInstance = null;
    console.log("cfcf server stopped");
  }
}

/**
 * Check if the server is currently running.
 */
export function isServerRunning(): boolean {
  return serverInstance !== null;
}
