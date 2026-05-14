/**
 * `cfcf agents` — manage loop-spawned agent processes.
 *
 * Today only `reap` is implemented: list + kill subprocesses
 * registered with the cfcf server. Mirrors the UX of `cfcf server
 * reap` (item 6.31) but scoped differently:
 *
 *   - `cfcf server reap` finds ORPHANS (PPID==1) — children of a
 *     prior cfcf server that hard-crashed and got reparented to
 *     init. Works without a running cfcf server.
 *
 *   - `cfcf agents reap` lists LIVE-SERVER CHILDREN — what the
 *     current cfcf server is still tracking. Requires the server
 *     to be running. Use case: a subprocess survived a `cfcf stop`
 *     (rare, but the missing-signals follow-up + this command
 *     close that gap), or the user wants to inspect what's still
 *     attached to the server.
 *
 * **Safety**: this only ever lists / kills processes in the
 * `active-processes` registry, which is scoped to loop-spawned
 * agent roles (dev / judge / architect / documenter / reflection).
 * PA (`cfcf spec`) and HA (`cfcf help assistant`) run interactively
 * outside the cfcf server (`stdio: "inherit"`), are NOT in the
 * registry, and CANNOT be killed via this command.
 */

import type { Command } from "commander";
import { createInterface } from "node:readline";
import { isServerReachable, get, post } from "../client.js";

interface ActiveProcessSummary {
  workspaceId: string;
  workspaceName: string;
  role: "dev" | "judge" | "architect" | "documenter" | "reflection";
  pid: number | undefined;
  startedAt: string;
  runtimeMs: number;
  logFileName: string | null;
}

function readLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function formatRuntime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m${seconds % 60}s`;
  return `${seconds}s`;
}

function formatRow(p: ActiveProcessSummary): string {
  const pidStr = p.pid !== undefined ? `pid ${p.pid}` : "pid ?";
  const runtime = formatRuntime(p.runtimeMs);
  const log = p.logFileName ? ` log=${p.logFileName}` : "";
  return `  ${p.workspaceName} / ${p.role}: ${pidStr}, running for ${runtime}${log}`;
}

export function registerAgentsCommands(program: Command): void {
  const agents = program
    .command("agents")
    .description("Manage running agent subprocesses");

  agents
    .command("reap")
    .description("List + interactively kill active agent processes (loop-spawned only — PA/HA are untouched)")
    .option("--workspace <name>", "Limit to a single workspace (by name or ID)")
    .option("-y, --yes", "Kill without prompting (non-interactive use)")
    .action(async (opts: { workspace?: string; yes?: boolean }) => {
      if (!(await isServerReachable())) {
        console.error(
          "cfcf server is not running. Start it with: cfcf server start",
        );
        console.error(
          "(For orphans from a previously-crashed server, use `cfcf server reap` instead.)",
        );
        process.exit(1);
      }

      const query = opts.workspace
        ? `?workspace=${encodeURIComponent(opts.workspace)}`
        : "";
      const res = await get<{ active: ActiveProcessSummary[] }>(
        `/api/active-processes${query}`,
      );
      if (!res.ok) {
        console.error(`Failed to list active processes: ${res.error}`);
        process.exit(1);
      }

      const procs = res.data!.active;
      if (procs.length === 0) {
        console.log(
          opts.workspace
            ? `No active agent processes for workspace "${opts.workspace}".`
            : "No active agent processes.",
        );
        return;
      }

      console.log(
        `Found ${procs.length} active agent process${procs.length === 1 ? "" : "es"}:`,
      );
      for (const p of procs) {
        console.log(formatRow(p));
      }
      console.log();

      let proceed = false;
      if (opts.yes) {
        proceed = true;
      } else {
        const answer = await readLine(
          `Kill ${procs.length === 1 ? "this process" : `these ${procs.length} processes`}? [y/N]: `,
        );
        proceed = /^y(es)?$/i.test(answer);
      }
      if (!proceed) {
        console.log("Aborted. No processes killed.");
        return;
      }

      let killed = 0;
      let failed = 0;
      for (const p of procs) {
        const r = await post<{ ok: boolean; error?: string }>(
          `/api/active-processes/${encodeURIComponent(p.workspaceId)}/${p.role}/kill`,
          {},
        );
        if (r.ok && r.data?.ok) {
          console.log(`  ✓ ${p.workspaceName} / ${p.role} (pid ${p.pid})`);
          killed++;
        } else {
          console.log(
            `  ✗ ${p.workspaceName} / ${p.role} (pid ${p.pid}): ${r.data?.error ?? r.error ?? "unknown error"}`,
          );
          failed++;
        }
      }
      console.log();
      console.log(`Reap complete: ${killed} signaled, ${failed} failed.`);
      if (failed > 0) process.exit(1);
    });
}
