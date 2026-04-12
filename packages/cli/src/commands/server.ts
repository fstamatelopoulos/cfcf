/**
 * Server management commands: start, stop, status.
 */

import type { Command } from "commander";
import { DEFAULT_PORT, VERSION } from "@cfcf/core";
import { readPidFile, isProcessRunning, removePidFile, writePidFile } from "@cfcf/core";
import { get, isServerReachable, post } from "../client.js";

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

      // Check if already running via PID file
      const pidInfo = await readPidFile();
      if (pidInfo && isProcessRunning(pidInfo.pid)) {
        console.log(`cfcf server is already running (pid: ${pidInfo.pid}, port: ${pidInfo.port})`);
        return;
      }

      // Clean up stale PID file if process is dead
      if (pidInfo) {
        await removePidFile();
      }

      // Start server as a detached background process
      const serverEntry = new URL("../../server/src/index.ts", import.meta.url).pathname;
      const child = Bun.spawn(["bun", "run", serverEntry], {
        env: { ...process.env, CFCF_PORT: String(port) },
        stdio: ["ignore", "ignore", "ignore"],
      });

      // Give the server a moment to start
      await new Promise((resolve) => setTimeout(resolve, 800));

      if (await isServerReachable()) {
        console.log(`cfcf server v${VERSION} started on port ${port} (pid: ${child.pid})`);
        console.log();
        console.log("Ready. Create a project:  cfcf project init --repo <path> --name <name>");
        console.log("Or check status:          cfcf status");
      } else {
        console.error("Failed to start cfcf server. Try running directly: bun run dev:server");
        process.exit(1);
      }
    });

  server
    .command("stop")
    .description("Stop the cfcf server")
    .action(async () => {
      // Try graceful shutdown via API first
      if (await isServerReachable()) {
        const res = await post("/api/shutdown");
        if (res.ok) {
          console.log("cfcf server is shutting down...");
          // Wait briefly then verify
          await new Promise((resolve) => setTimeout(resolve, 500));
          await removePidFile();
          console.log("cfcf server stopped.");
          return;
        }
      }

      // Fallback: use PID file
      const pidInfo = await readPidFile();
      if (pidInfo && isProcessRunning(pidInfo.pid)) {
        process.kill(pidInfo.pid, "SIGTERM");
        await removePidFile();
        console.log(`cfcf server stopped (pid: ${pidInfo.pid})`);
        return;
      }

      console.log("cfcf server is not running.");
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
