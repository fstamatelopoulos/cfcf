/**
 * Resume command: continue a paused iteration loop.
 *
 * Optionally accepts feedback that gets injected into the next iteration's context.
 */

import type { Command } from "commander";
import { isServerReachable, post, get } from "../client.js";

export function registerResumeCommand(program: Command): void {
  program
    .command("resume")
    .description("Resume a paused iteration loop")
    .requiredOption("--project <name>", "Project name or ID")
    .option("--feedback <text>", "Feedback/direction for the next iteration")
    .action(async (opts) => {
      if (!(await isServerReachable())) {
        console.error("cfcf server is not running. Start it with: cfcf server start");
        process.exit(1);
      }

      const body: Record<string, unknown> = {};
      if (opts.feedback) {
        body.feedback = opts.feedback;
      }

      const res = await post<{ projectId: string; phase: string; currentIteration: number; message: string }>(
        `/api/projects/${encodeURIComponent(opts.project)}/loop/resume`,
        Object.keys(body).length > 0 ? body : undefined,
      );

      if (!res.ok) {
        console.error(`Failed to resume: ${res.error}`);
        process.exit(1);
      }

      const data = res.data!;
      console.log(`Loop resumed for project (iteration ${data.currentIteration})`);
      if (opts.feedback) {
        console.log(`Feedback injected: "${opts.feedback}"`);
      }
      console.log();
      console.log("Monitor progress with: cfcf status --project " + opts.project);
    });
}
