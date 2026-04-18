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

      // Start server as a detached background process.
      //
      // Two modes:
      //   (a) Dev mode: we're running via `bun run packages/cli/src/index.ts`.
      //       Spawn `bun run packages/server/src/index.ts` directly. The
      //       server entry file is on disk, so this path works.
      //   (b) Compiled binary: we're running via `cfcf-binary`. The server
      //       source file does not exist on disk. Re-spawn ourselves with
      //       CFCF_INTERNAL_SERVE=1 so the single binary hosts both the CLI
      //       and the server (item 5.3).
      //
      // We detect which mode by checking if the server entry file exists
      // on disk. No Bun-specific magic required.
      const { spawnServerChild } = await import("../server-spawn.js");
      const child = await spawnServerChild(port);

      // The client helpers below read CFCF_PORT from our own env to pick
      // which port to probe. If the user passed --port, make sure we probe
      // that one, not the default.
      process.env.CFCF_PORT = String(port);

      // Poll for readiness. Dev mode (bun run) is fast (~300ms); the
      // compiled binary cold-starts in ~1-2s on a cool macOS disk, so we
      // give it up to ~5s before reporting a failure.
      const deadline = Date.now() + 5000;
      let ready = false;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (await isServerReachable()) {
          ready = true;
          break;
        }
      }

      if (ready) {
        console.log(`cfcf server v${VERSION} started on port ${port} (pid: ${child.pid})`);
        console.log();
        console.log("Ready. Create a project:  cfcf project init --repo <path> --name <name>");
        console.log("Or check status:          cfcf status");
        // Explicit exit so the CLI parent doesn't stay tethered to the
        // spawned server child (Bun.spawn children keep the parent alive
        // until they exit unless we detach; simplest is to exit on success).
        process.exit(0);
      } else {
        console.error("Failed to start cfcf server after 5s. Try running directly: bun run dev:server");
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
