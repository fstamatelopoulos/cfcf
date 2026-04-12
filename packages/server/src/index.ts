/**
 * cfcf Server -- the backbone of cf².
 *
 * Hono-based HTTP server that manages project lifecycles,
 * iteration execution, and real-time event streaming.
 */

import { DEFAULT_PORT } from "@cfcf/core";

export { createApp } from "./app.js";
export { startServer, stopServer } from "./start.js";

/** Entry point when run directly */
if (import.meta.main) {
  const { startServer } = await import("./start.js");
  const port = parseInt(process.env.CFCF_PORT || String(DEFAULT_PORT), 10);
  await startServer(port);
}
