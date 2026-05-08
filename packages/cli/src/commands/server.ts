/**
 * Server management commands: start, stop, status.
 */

import type { Command } from "commander";
import { createInterface } from "readline";
import { homedir } from "node:os";
import { DEFAULT_PORT, VERSION, getLogsDir } from "@cfcf/core";
import { readPidFile, isProcessRunning, removePidFile, writePidFile } from "@cfcf/core";
import {
  findOrphanAgentProcesses,
  reapOrphans,
  formatOrphanLine,
} from "@cfcf/core";
import { get, isServerReachable, post } from "../client.js";

/**
 * Read a single line from stdin. Used for the `cfcf server reap` y/N
 * confirmation. Returns the empty string on EOF or non-TTY input.
 */
function readLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Replace a leading `$HOME` path prefix with `~` so paths read more
 * naturally in the start banner. Falls back to the absolute path if
 * the home dir can't be determined or doesn't match.
 */
function tildify(path: string): string {
  const home = homedir();
  if (home && path.startsWith(home + "/")) {
    return "~" + path.slice(home.length);
  }
  return path;
}

/**
 * Format the Clio status line for the server start banner. Best-effort:
 * a failed stats fetch falls through to the bare DB path so a broken
 * Clio (corrupt DB, missing migrations, embedder load failure, …) never
 * breaks `cfcf server start`.
 */
async function formatClioStatus(): Promise<string> {
  try {
    const res = await get<{
      dbPath: string;
      dbSizeBytes: number;
      documentCount: number;
      activeEmbedder: { name: string } | null;
    }>("/api/clio/stats");
    if (!res.ok || !res.data) {
      return tildify(`${homedir()}/.cfcf/clio.db`);
    }
    const { dbPath, documentCount, activeEmbedder } = res.data;
    const docPart = `${documentCount} doc${documentCount === 1 ? "" : "s"}`;
    const embPart = activeEmbedder ? `, embedder: ${activeEmbedder.name}` : "";
    return `${tildify(dbPath)} (${docPart}${embPart})`;
  } catch {
    return tildify(`${homedir()}/.cfcf/clio.db`);
  }
}

/**
 * Wait until the cfcf server has actually exited: the HTTP port is
 * unreachable AND (when we know the pid) the OS process is gone. Used
 * by `cfcf server stop` so a follow-up `cfcf server start` doesn't
 * race the prior process for port 7233.
 *
 * Caps at ~3 seconds so a stuck server doesn't hang the CLI; if we
 * time out, downstream code falls through to the PID-file fallback
 * which can SIGTERM/SIGKILL the stragglers.
 */
async function waitForServerToExit(pid?: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const portFree = !(await isServerReachable());
    const procDead = pid === undefined ? true : !isProcessRunning(pid);
    if (portFree && procDead) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

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
        const baseUrl = `http://localhost:${port}`;
        const clioLine = await formatClioStatus();
        const logsLine = tildify(getLogsDir()) + "/";

        console.log(`✓ cfcf server v${VERSION} started`);
        console.log();
        console.log(`  Web UI:     ${baseUrl}`);
        console.log(`  API:        ${baseUrl}/api`);
        console.log(`  Clio DB:    ${clioLine}`);
        console.log(`  Logs:       ${logsLine}`);
        console.log(`  PID:        ${child.pid}`);
        console.log();
        console.log("Next steps:");
        console.log("    cfcf workspace init --repo <path> --name <name>");
        console.log("    cfcf status        — overview of running loops");
        console.log("    cfcf server stop   — graceful shutdown");
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
          // Wait until the server has actually released the port AND
          // the OS process has exited. A fixed sleep (the previous 500ms)
          // races: the server's event loop may still be holding the
          // listening socket when stop returns, so an immediate `cfcf
          // server start` would fail to bind port 7233. Poll instead.
          // Cap at ~3s -- well under the 5s start-readiness budget on
          // the next invocation.
          const pidInfo = await readPidFile();
          await waitForServerToExit(pidInfo?.pid);
          await removePidFile();
          console.log("cfcf server stopped.");
          return;
        }
      }

      // Fallback: use PID file
      const pidInfo = await readPidFile();
      if (pidInfo && isProcessRunning(pidInfo.pid)) {
        process.kill(pidInfo.pid, "SIGTERM");
        await waitForServerToExit(pidInfo.pid);
        await removePidFile();
        console.log(`cfcf server stopped (pid: ${pidInfo.pid})`);
        return;
      }

      console.log("cfcf server is not running.");
    });

  server
    .command("reap")
    .description("Detect + interactively kill orphan agent processes left by a crashed server")
    .option("-y, --yes", "Kill without prompting (non-interactive use)")
    .action(async (opts) => {
      // Pure system call — does NOT require the cfcf server to be
      // running. Boot-time auto-reap handles the common case; this is
      // for ad-hoc cleanup if a hard-crashed server left orphans
      // behind without restarting the server (or for the user who
      // wants to verify there's nothing stale before launching a loop).
      const orphans = await findOrphanAgentProcesses();
      if (orphans.length === 0) {
        console.log("No zombie agent processes detected.");
        return;
      }

      console.log(`Found ${orphans.length} potentially orphan agent process(es):`);
      for (const o of orphans) {
        console.log(`  ${formatOrphanLine(o)}`);
      }
      console.log();

      let proceed = false;
      if (opts.yes) {
        proceed = true;
      } else {
        const answer = await readLine(`Kill these ${orphans.length} process(es)? [y/N]: `);
        proceed = /^y(es)?$/i.test(answer);
      }

      if (!proceed) {
        console.log("Aborted. No processes killed.");
        return;
      }

      const result = await reapOrphans(orphans);
      console.log(`Reap complete: ${result.killed} signaled, ${result.failed} failed.`);
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
