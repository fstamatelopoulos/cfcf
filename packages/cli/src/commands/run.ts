/**
 * Run command: execute the next iteration for a cfcf project.
 *
 * Creates a feature branch, runs the command, captures logs, commits results.
 * The project's iteration counter is incremented automatically.
 */

import type { Command } from "commander";
import { isServerReachable, post } from "../client.js";

export function registerRunCommand(program: Command): void {
  program
    .command("run")
    .description("Execute the next iteration for a project (creates branch, captures logs, commits)")
    .requiredOption("--project <name>", "Project name or ID")
    .argument("<command...>", "Command to run (e.g., npm test)")
    .action(async (commandParts: string[], opts) => {
      if (!(await isServerReachable())) {
        console.error("cfcf server is not running. Start it with: cfcf server start");
        process.exit(1);
      }

      const [command, ...args] = commandParts;

      console.log(`Project:  ${opts.project}`);
      console.log(`Command:  ${command} ${args.join(" ")}`);
      console.log();

      const res = await post<{
        iteration: number;
        branch: string;
        exitCode: number;
        durationMs: number;
        logFile: string;
        committed: boolean;
        killed: boolean;
      }>(`/api/projects/${encodeURIComponent(opts.project)}/iterate`, {
        command,
        args,
      });

      if (!res.ok) {
        console.error(`Iteration failed: ${res.error}`);
        process.exit(1);
      }

      const r = res.data!;
      console.log(`Iteration: ${r.iteration}`);
      console.log(`Branch:    ${r.branch}`);
      console.log(`Exit code: ${r.exitCode}`);
      console.log(`Duration:  ${r.durationMs}ms`);
      console.log(`Log file:  ${r.logFile}`);
      console.log(`Committed: ${r.committed}`);

      if (r.exitCode !== 0) {
        console.log();
        console.log("Command failed. Check the log file for details.");
        process.exit(r.exitCode);
      }
    });
}
