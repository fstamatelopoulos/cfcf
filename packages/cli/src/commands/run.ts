/**
 * Run command: execute the next iteration for a cfcf project.
 *
 * Two modes:
 * - Agent mode (no --): cfcf assembles context + launches configured dev agent
 * - Manual mode (with --): cfcf runs the specified command (for testing/debugging)
 */

import type { Command } from "commander";
import { isServerReachable, post } from "../client.js";

interface IterateResponse {
  iteration: number;
  branch: string;
  mode: "manual" | "agent";
  exitCode: number;
  durationMs: number;
  logFile: string;
  committed: boolean;
  killed: boolean;
  handoffReceived?: boolean;
  signalsReceived?: boolean;
  signals?: {
    status: string;
    self_assessment: string;
    tests_passed?: number;
    tests_failed?: number;
    tests_total?: number;
    user_input_needed?: boolean;
    questions?: string[];
    blockers?: string[];
  };
}

export function registerRunCommand(program: Command): void {
  program
    .command("run")
    .description(
      "Execute the next iteration for a project.\n" +
      "Without -- : launches the configured dev agent with assembled context.\n" +
      "With -- <cmd>: runs the specified command (manual/testing mode)."
    )
    .requiredOption("--project <name>", "Project name or ID")
    .option("--problem-pack <path>", "Path to Problem Pack directory (default: <repo>/problem-pack)")
    .argument("[command...]", "Manual command to run (e.g., npm test)")
    .action(async (commandParts: string[], opts) => {
      if (!(await isServerReachable())) {
        console.error("cfcf server is not running. Start it with: cfcf server start");
        process.exit(1);
      }

      const isManualMode = commandParts.length > 0;

      if (isManualMode) {
        const [command, ...args] = commandParts;
        console.log(`Project:  ${opts.project}`);
        console.log(`Mode:     manual`);
        console.log(`Command:  ${command} ${args.join(" ")}`);
      } else {
        console.log(`Project:  ${opts.project}`);
        console.log(`Mode:     agent (launching configured dev agent)`);
      }
      console.log();

      const body: Record<string, unknown> = {};
      if (isManualMode) {
        const [command, ...args] = commandParts;
        body.command = command;
        body.args = args;
      }
      if (opts.problemPack) {
        body.problemPackPath = opts.problemPack;
      }

      const res = await post<IterateResponse>(
        `/api/projects/${encodeURIComponent(opts.project)}/iterate`,
        Object.keys(body).length > 0 ? body : undefined,
      );

      if (!res.ok) {
        console.error(`Iteration failed: ${res.error}`);
        process.exit(1);
      }

      const r = res.data!;
      console.log(`Iteration: ${r.iteration}`);
      console.log(`Branch:    ${r.branch}`);
      console.log(`Mode:      ${r.mode}`);
      console.log(`Exit code: ${r.exitCode}`);
      console.log(`Duration:  ${r.durationMs}ms`);
      console.log(`Log file:  ${r.logFile}`);
      console.log(`Committed: ${r.committed}`);

      if (r.mode === "agent") {
        console.log();
        console.log(`Handoff:   ${r.handoffReceived ? "received" : "NOT received (agent may not have filled it in)"}`);
        console.log(`Signals:   ${r.signalsReceived ? "received" : "NOT received (anomaly -- check logs)"}`);

        if (r.signals) {
          console.log();
          console.log("Agent signals:");
          console.log(`  Status:      ${r.signals.status}`);
          console.log(`  Assessment:  ${r.signals.self_assessment}`);
          if (r.signals.tests_total !== undefined) {
            console.log(`  Tests:       ${r.signals.tests_passed}/${r.signals.tests_total} passed`);
          }
          if (r.signals.user_input_needed) {
            console.log();
            console.log("⚠ Agent needs user input:");
            for (const q of r.signals.questions ?? []) {
              console.log(`  → ${q}`);
            }
          }
          if (r.signals.blockers && r.signals.blockers.length > 0) {
            console.log();
            console.log("Blockers:");
            for (const b of r.signals.blockers) {
              console.log(`  → ${b}`);
            }
          }
        }
      }

      if (r.exitCode !== 0) {
        console.log();
        console.log("Command failed. Check the log file for details.");
        process.exit(r.exitCode);
      }
    });
}
