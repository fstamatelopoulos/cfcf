/**
 * Run command: execute the next iteration for a cfcf project.
 *
 * Starts the iteration (returns immediately), then polls for status
 * until the iteration completes. Shows real-time progress.
 *
 * Two modes:
 * - Agent mode (no --): cfcf assembles context + launches configured dev agent
 * - Manual mode (with --): cfcf runs the specified command (for testing/debugging)
 */

import type { Command } from "commander";
import { isServerReachable, post, get } from "../client.js";

interface StartResponse {
  iteration: number;
  branch: string;
  mode: "manual" | "agent";
  status: string;
  logFile: string;
  message: string;
}

interface StatusResponse {
  iteration: number;
  projectId: string;
  projectName: string;
  branch: string;
  mode: "manual" | "agent";
  status: "preparing" | "executing" | "collecting" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  durationMs?: number;
  logFile: string;
  committed?: boolean;
  killed?: boolean;
  error?: string;
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

      // Build request body
      const body: Record<string, unknown> = {};
      if (isManualMode) {
        const [command, ...args] = commandParts;
        body.command = command;
        body.args = args;
      }
      if (opts.problemPack) {
        body.problemPackPath = opts.problemPack;
      }

      // Start the iteration (returns immediately)
      const startRes = await post<StartResponse>(
        `/api/projects/${encodeURIComponent(opts.project)}/iterate`,
        Object.keys(body).length > 0 ? body : undefined,
      );

      if (!startRes.ok) {
        console.error(`Failed to start iteration: ${startRes.error}`);
        process.exit(1);
      }

      const start = startRes.data!;
      console.log(`Iteration ${start.iteration} started on branch ${start.branch}`);
      console.log(`Log file: ${start.logFile}`);
      console.log();

      // Poll for status until completed or failed
      const projectParam = encodeURIComponent(opts.project);
      let lastStatus = "";
      let dotCount = 0;

      while (true) {
        const statusRes = await get<StatusResponse>(
          `/api/projects/${projectParam}/iterations/${start.iteration}/status`,
        );

        if (!statusRes.ok) {
          console.error(`Failed to get iteration status: ${statusRes.error}`);
          process.exit(1);
        }

        const s = statusRes.data!;

        if (s.status !== lastStatus) {
          if (lastStatus) process.stdout.write("\n");
          process.stdout.write(`Status: ${s.status}`);
          lastStatus = s.status;
          dotCount = 0;
        } else {
          process.stdout.write(".");
          dotCount++;
        }

        if (s.status === "completed" || s.status === "failed") {
          process.stdout.write("\n\n");
          printResult(s);
          process.exit(s.exitCode !== 0 ? s.exitCode ?? 1 : 0);
        }

        // Poll every 2 seconds
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    });
}

function printResult(r: StatusResponse): void {
  console.log(`--- Iteration ${r.iteration} ${r.status} ---`);
  console.log();

  if (r.error) {
    console.log(`Error:     ${r.error}`);
    console.log();
  }

  console.log(`Branch:    ${r.branch}`);
  console.log(`Mode:      ${r.mode}`);
  console.log(`Exit code: ${r.exitCode ?? "N/A"}`);
  console.log(`Duration:  ${r.durationMs ? `${Math.round(r.durationMs / 1000)}s` : "N/A"}`);
  console.log(`Log file:  ${r.logFile}`);
  console.log(`Committed: ${r.committed ?? false}`);

  if (r.mode === "agent") {
    console.log();
    console.log(`Handoff:   ${r.handoffReceived ? "received" : "NOT received"}`);
    console.log(`Signals:   ${r.signalsReceived ? "received" : "NOT received (check logs)"}`);

    if (r.signals) {
      console.log();
      console.log("Agent signals:");
      console.log(`  Status:      ${r.signals.status}`);
      console.log(`  Assessment:  ${r.signals.self_assessment}`);
      if (r.signals.tests_passed !== undefined) {
        console.log(`  Tests:       ${r.signals.tests_passed}/${r.signals.tests_total} passed`);
      }
      if (r.signals.user_input_needed) {
        console.log();
        console.log("Agent needs user input:");
        for (const q of r.signals.questions ?? []) {
          console.log(`  -> ${q}`);
        }
      }
      if (r.signals.blockers && r.signals.blockers.length > 0) {
        console.log();
        console.log("Blockers:");
        for (const b of r.signals.blockers) {
          console.log(`  -> ${b}`);
        }
      }
    }
  }
}
