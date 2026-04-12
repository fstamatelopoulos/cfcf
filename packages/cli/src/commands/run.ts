/**
 * Run command: execute a command within a cfcf project.
 *
 * Creates a feature branch, runs the command, captures logs, commits results.
 */

import type { Command } from "commander";
import { isServerReachable, post } from "../client.js";

export function registerRunCommand(program: Command): void {
  program
    .command("run")
    .description("Run a command in a cfcf project (creates branch, captures logs, commits)")
    .requiredOption("--project <name>", "Project name or ID")
    .argument("<command...>", "Command to run (e.g., npm test)")
    .action(async (commandParts: string[], opts) => {
      if (!(await isServerReachable())) {
        console.error("cfcf server is not running. Start it with: cfcf server start");
        process.exit(1);
      }

      const [command, ...args] = commandParts;

      console.log(`Running: ${command} ${args.join(" ")}`);
      console.log(`Project: ${opts.project}`);
      console.log();

      const res = await post<{
        runId: string;
        branch: string;
        exitCode: number;
        durationMs: number;
        logFile: string;
        committed: boolean;
        killed: boolean;
      }>(`/api/projects/${encodeURIComponent(opts.project)}/run`, {
        command,
        args,
      });

      if (!res.ok) {
        console.error(`Run failed: ${res.error}`);
        process.exit(1);
      }

      const r = res.data!;
      console.log(`Run ID:    ${r.runId}`);
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
