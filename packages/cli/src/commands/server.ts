/**
 * Server management commands: start, stop, status.
 */

import type { Command } from "commander";
import { DEFAULT_PORT, VERSION } from "@cfcf/core";
import { get, isServerReachable } from "../client.js";

export function registerServerCommands(program: Command): void {
  const server = program
    .command("server")
    .description("Manage the cfcf background server");

  server
    .command("start")
    .description("Start the cfcf server")
    .option("-p, --port <port>", "Port to listen on", String(DEFAULT_PORT))
    .action(async (opts) => {
      const port = parseInt(opts.port, 10);

      // Check if already running
      if (await isServerReachable()) {
        console.log("cfcf server is already running.");
        return;
      }

      // Start server as a detached background process
      const serverEntry = require.resolve("@cfcf/server/src/index.ts");
      const child = Bun.spawn(["bun", "run", serverEntry], {
        env: { ...process.env, CFCF_PORT: String(port) },
        stdio: ["ignore", "ignore", "ignore"],
        // Note: Bun.spawn doesn't have 'detached' like Node.
        // For iteration 0, we run in background via & in the shell.
        // A proper daemonization approach will be added later.
      });

      // Give the server a moment to start
      await new Promise((resolve) => setTimeout(resolve, 500));

      if (await isServerReachable()) {
        console.log(`cfcf server v${VERSION} started on port ${port} (pid: ${child.pid})`);
      } else {
        console.error("Failed to start cfcf server. Check logs for details.");
        process.exit(1);
      }
    });

  server
    .command("stop")
    .description("Stop the cfcf server")
    .action(async () => {
      if (!(await isServerReachable())) {
        console.log("cfcf server is not running.");
        return;
      }
      // For iteration 0, we don't have a proper shutdown endpoint.
      // The user can kill the process manually or we add this in iteration 1.
      console.log("Server shutdown not yet implemented. Use 'kill' or Ctrl+C on the server process.");
    });

  server
    .command("status")
    .description("Check if the cfcf server is running")
    .action(async () => {
      const res = await get<{
        status: string;
        version: string;
        uptime: number;
        pid: number;
        port: number;
        configured: boolean;
        availableAgents: string[];
      }>("/api/status");

      if (!res.ok) {
        console.log("cfcf server is not running.");
        console.log(`  ${res.error}`);
        return;
      }

      const d = res.data!;
      console.log(`cfcf server v${d.version}`);
      console.log(`  Status:     ${d.status}`);
      console.log(`  Port:       ${d.port}`);
      console.log(`  PID:        ${d.pid}`);
      console.log(`  Uptime:     ${d.uptime}s`);
      console.log(`  Configured: ${d.configured ? "yes" : "no (run 'cfcf init')"}`);
      if (d.availableAgents.length > 0) {
        console.log(`  Agents:     ${d.availableAgents.join(", ")}`);
      }
    });
}
