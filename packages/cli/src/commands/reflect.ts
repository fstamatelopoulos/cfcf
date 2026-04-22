/**
 * Reflect command: run the Reflection agent ad-hoc (item 5.6 U5).
 *
 * Reviews the full run history and optionally rewrites pending items in
 * cfcf-docs/plan.md. Can be run at any time; does NOT modify loop-state,
 * does NOT write an iteration-log (no iteration happened).
 */

import type { Command } from "commander";
import { isServerReachable, post, get } from "../client.js";
import { formatElapsed } from "../format.js";

interface ReflectStartResponse {
  workspaceId: string;
  status: string;
  logFile: string;
  message: string;
}

interface ReflectStatusResponse {
  workspaceId: string;
  workspaceName: string;
  status: "preparing" | "executing" | "collecting" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  logFile: string;
  logFileName: string;
  iteration: number;
  trigger: "loop" | "manual";
  signals?: {
    iteration: number;
    plan_modified: boolean;
    iteration_health: string;
    key_observation: string;
    recommend_stop?: boolean;
  };
  error?: string;
}

export function registerReflectCommand(program: Command): void {
  program
    .command("reflect")
    .description("Run the Reflection agent ad-hoc against the current state (reviews cross-iteration history, may rewrite pending plan items)")
    .requiredOption("--workspace <name>", "Workspace name or ID")
    .option("--prompt <hint>", "Optional focus hint for the reflection agent")
    .action(async (opts) => {
      if (!(await isServerReachable())) {
        console.error("cfcf server is not running. Start it with: cfcf server start");
        process.exit(1);
      }

      console.log(`Workspace: ${opts.workspace}`);
      console.log(`Mode:      Reflection (ad-hoc)`);
      if (opts.prompt) console.log(`Focus:     ${opts.prompt}`);
      console.log();

      const startRes = await post<ReflectStartResponse>(
        `/api/workspaces/${encodeURIComponent(opts.workspace)}/reflect`,
        opts.prompt ? { prompt: opts.prompt } : {},
      );
      if (!startRes.ok) {
        console.error(`Failed to start reflection: ${startRes.error}`);
        process.exit(1);
      }

      const start = startRes.data!;
      console.log(`Reflection started`);
      console.log(`Log file: ${start.logFile}`);
      console.log();

      const workspaceParam = encodeURIComponent(opts.workspace);
      let lastStatus = "";
      let statusStartTime = Date.now();

      while (true) {
        const statusRes = await get<ReflectStatusResponse>(
          `/api/workspaces/${workspaceParam}/reflect/status`,
        );
        if (!statusRes.ok) {
          console.error(`Failed to get reflection status: ${statusRes.error}`);
          process.exit(1);
        }
        const s = statusRes.data!;
        if (s.status !== lastStatus) {
          if (lastStatus) process.stdout.write("\n");
          process.stdout.write(`${s.status}`);
          lastStatus = s.status;
          statusStartTime = Date.now();
        } else {
          const elapsed = Math.floor((Date.now() - statusStartTime) / 1000);
          process.stdout.write(`\r${s.status} ${formatElapsed(elapsed)}`);
        }
        if (s.status === "completed" || s.status === "failed") {
          process.stdout.write("\n\n");
          printReflectResult(s);
          process.exit(s.status === "failed" ? 1 : 0);
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    });
}

function printReflectResult(r: ReflectStatusResponse): void {
  console.log(`=== Reflection ${r.status.toUpperCase()} ===`);
  console.log();
  if (r.error) {
    console.log(`Error:    ${r.error}`);
    console.log();
  }
  if (r.signals) {
    console.log(`Health:          ${r.signals.iteration_health}`);
    console.log(`Plan modified:   ${r.signals.plan_modified ? "yes" : "no"}`);
    console.log(`Key observation: ${r.signals.key_observation || "(none)"}`);
    if (r.signals.recommend_stop) {
      console.log();
      console.log("!! Reflection recommends STOPPING the loop: it believes the workspace is fundamentally stuck.");
    }
    console.log();
  }
  console.log("What to do next:");
  console.log(`  Read analysis: cat cfcf-docs/reflection-analysis.md`);
  console.log(`  Re-run:        cfcf reflect --workspace ${r.workspaceName}`);
}
