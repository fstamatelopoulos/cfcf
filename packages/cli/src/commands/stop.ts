/**
 * Stop command: halt a running or paused iteration loop.
 */

import type { Command } from "commander";
import { isServerReachable, post } from "../client.js";

export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description("Stop the iteration loop for a workspace")
    .requiredOption("--workspace <name>", "Workspace name or ID")
    .action(async (opts) => {
      if (!(await isServerReachable())) {
        console.error("cfcf server is not running. Start it with: cfcf server start");
        process.exit(1);
      }

      const res = await post<{ workspaceId: string; phase: string; currentIteration: number; outcome: string; message: string }>(
        `/api/workspaces/${encodeURIComponent(opts.workspace)}/loop/stop`,
      );

      if (!res.ok) {
        console.error(`Failed to stop: ${res.error}`);
        process.exit(1);
      }

      const data = res.data!;
      console.log(`Loop stopped at iteration ${data.currentIteration}`);
      console.log();
      console.log("The iteration branch is preserved. You can:");
      console.log(`  Review code:  cd <repo> && git log --oneline`);
      console.log(`  Restart loop: cfcf run --workspace ${opts.workspace}`);
    });
}
