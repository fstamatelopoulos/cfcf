/**
 * Run command: start the iteration loop for a cfcf project.
 *
 * Agent mode (default, no --): starts the full iteration loop
 *   (dev → judge → decide → loop) and polls for status.
 * Manual mode (with --): runs a single command iteration (testing/debugging).
 */

import type { Command } from "commander";
import { isServerReachable, post, get } from "../client.js";

interface LoopStartResponse {
  projectId: string;
  phase: string;
  maxIterations: number;
  pauseEvery: number;
  message: string;
}

interface LoopStatusResponse {
  projectId: string;
  projectName: string;
  phase: string;
  currentIteration: number;
  maxIterations: number;
  pauseEvery: number;
  startedAt: string;
  completedAt?: string;
  pauseReason?: string;
  pendingQuestions?: string[];
  outcome?: string;
  error?: string;
  consecutiveStalled: number;
  iterations: Array<{
    number: number;
    branch: string;
    devExitCode?: number;
    judgeExitCode?: number;
    devSignals?: { status: string; self_assessment: string; tests_passed?: number; tests_total?: number };
    judgeSignals?: { determination: string; quality_score: number; key_concern?: string };
    merged: boolean;
  }>;
}

interface SingleIterationStartResponse {
  iteration: number;
  branch: string;
  mode: "manual" | "agent";
  status: string;
  logFile: string;
  message: string;
}

interface SingleIterationStatusResponse {
  iteration: number;
  projectId: string;
  projectName: string;
  status: string;
  exitCode?: number;
  durationMs?: number;
  logFile: string;
  committed?: boolean;
  error?: string;
}

export function registerRunCommand(program: Command): void {
  program
    .command("run")
    .description(
      "Start the iteration loop for a project.\n" +
      "Without -- : launches the dark factory loop (dev → judge → decide → repeat).\n" +
      "With -- <cmd>: runs a single command iteration (manual/testing mode)."
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
        await runManualMode(commandParts, opts);
      } else {
        await runLoopMode(opts);
      }
    });
}

async function runLoopMode(opts: { project: string; problemPack?: string }): Promise<void> {
  console.log(`Project:  ${opts.project}`);
  console.log(`Mode:     dark factory (iteration loop)`);
  console.log();

  const body: Record<string, unknown> = {};
  if (opts.problemPack) {
    body.problemPackPath = opts.problemPack;
  }

  // Start the loop
  const startRes = await post<LoopStartResponse>(
    `/api/projects/${encodeURIComponent(opts.project)}/loop/start`,
    Object.keys(body).length > 0 ? body : undefined,
  );

  if (!startRes.ok) {
    console.error(`Failed to start loop: ${startRes.error}`);
    process.exit(1);
  }

  const start = startRes.data!;
  console.log(`Iteration loop started (max ${start.maxIterations} iterations)`);
  if (start.pauseEvery > 0) {
    console.log(`Will pause for review every ${start.pauseEvery} iterations`);
  }
  console.log();

  // Poll for status until completed, paused, or failed
  await pollLoopStatus(opts.project);
}

async function pollLoopStatus(project: string): Promise<void> {
  const projectParam = encodeURIComponent(project);
  let lastPhase = "";
  let lastIteration = 0;

  while (true) {
    const statusRes = await get<LoopStatusResponse>(
      `/api/projects/${projectParam}/loop/status`,
    );

    if (!statusRes.ok) {
      console.error(`Failed to get loop status: ${statusRes.error}`);
      process.exit(1);
    }

    const s = statusRes.data!;

    // Show phase transitions
    if (s.phase !== lastPhase || s.currentIteration !== lastIteration) {
      if (lastPhase) process.stdout.write("\n");
      const iterInfo = s.currentIteration > 0 ? ` [iteration ${s.currentIteration}]` : "";
      process.stdout.write(`${s.phase}${iterInfo}`);
      lastPhase = s.phase;
      lastIteration = s.currentIteration;
    } else {
      process.stdout.write(".");
    }

    // Terminal states
    if (s.phase === "completed" || s.phase === "failed" || s.phase === "stopped") {
      process.stdout.write("\n\n");
      printLoopResult(s);
      process.exit(s.phase === "completed" && s.outcome === "success" ? 0 : 1);
    }

    if (s.phase === "paused") {
      process.stdout.write("\n\n");
      printPausedState(s);
      process.exit(0); // User needs to run `cfcf resume`
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

function printLoopResult(s: LoopStatusResponse): void {
  console.log(`=== Iteration Loop ${s.phase.toUpperCase()} ===`);
  console.log();

  if (s.error) {
    console.log(`Error:      ${s.error}`);
    console.log();
  }

  console.log(`Project:    ${s.projectName}`);
  console.log(`Outcome:    ${s.outcome ?? s.phase}`);
  console.log(`Iterations: ${s.currentIteration}/${s.maxIterations}`);
  console.log(`Duration:   ${formatDuration(s.startedAt, s.completedAt)}`);
  console.log();

  // Show iteration summary table
  if (s.iterations.length > 0) {
    console.log("Iteration history:");
    for (const iter of s.iterations) {
      const judge = iter.judgeSignals
        ? `${iter.judgeSignals.determination} (${iter.judgeSignals.quality_score}/10)`
        : "no judge";
      const merged = iter.merged ? "merged" : "unmerged";
      console.log(`  ${iter.number}: ${judge} [${merged}]`);
    }
    console.log();
  }

  // Next steps
  console.log("What to do next:");
  if (s.outcome === "success") {
    console.log(`  Review final code in the repo`);
    console.log(`  Push to remote:     git push`);
  } else {
    console.log(`  Review iteration handoff: cat cfcf-docs/iteration-handoff.md`);
    console.log(`  Check the plan:          cat cfcf-docs/plan.md`);
    console.log(`  Resume the loop:         cfcf resume --project ${s.projectName}`);
  }
}

function printPausedState(s: LoopStatusResponse): void {
  console.log(`=== Loop PAUSED ===`);
  console.log();
  console.log(`Project:    ${s.projectName}`);
  console.log(`Iteration:  ${s.currentIteration}/${s.maxIterations}`);
  console.log(`Reason:     ${s.pauseReason}`);

  if (s.pendingQuestions && s.pendingQuestions.length > 0) {
    console.log();
    console.log("Questions needing your input:");
    for (const q of s.pendingQuestions) {
      console.log(`  -> ${q}`);
    }
  }

  // Show latest judge assessment if available
  const lastIter = s.iterations[s.iterations.length - 1];
  if (lastIter?.judgeSignals) {
    console.log();
    console.log(`Last judge: ${lastIter.judgeSignals.determination} (quality: ${lastIter.judgeSignals.quality_score}/10)`);
    if (lastIter.judgeSignals.key_concern) {
      console.log(`Concern:    ${lastIter.judgeSignals.key_concern}`);
    }
  }

  console.log();
  console.log("What to do next:");
  console.log(`  Review: cat cfcf-docs/judge-assessment.md`);
  console.log(`  Resume: cfcf resume --project ${s.projectName}`);
  console.log(`  Resume with feedback: cfcf resume --project ${s.projectName} --feedback "your direction"`);
  console.log(`  Stop:   cfcf stop --project ${s.projectName}`);
}

function formatDuration(startedAt: string, completedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = end - start;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

// --- Manual mode (single iteration, backwards compatible) ---

async function runManualMode(commandParts: string[], opts: { project: string; problemPack?: string }): Promise<void> {
  const [command, ...args] = commandParts;
  console.log(`Project:  ${opts.project}`);
  console.log(`Mode:     manual (single iteration)`);
  console.log(`Command:  ${command} ${args.join(" ")}`);
  console.log();

  const body: Record<string, unknown> = { command, args };
  if (opts.problemPack) {
    body.problemPackPath = opts.problemPack;
  }

  const startRes = await post<SingleIterationStartResponse>(
    `/api/projects/${encodeURIComponent(opts.project)}/iterate`,
    body,
  );

  if (!startRes.ok) {
    console.error(`Failed to start iteration: ${startRes.error}`);
    process.exit(1);
  }

  const start = startRes.data!;
  console.log(`Iteration ${start.iteration} started on branch ${start.branch}`);
  console.log(`Log file: ${start.logFile}`);
  console.log();

  // Poll for status
  const projectParam = encodeURIComponent(opts.project);
  let lastStatus = "";

  while (true) {
    const statusRes = await get<SingleIterationStatusResponse>(
      `/api/projects/${projectParam}/iterations/${start.iteration}/status`,
    );

    if (!statusRes.ok) {
      console.error(`Failed to get status: ${statusRes.error}`);
      process.exit(1);
    }

    const s = statusRes.data!;

    if (s.status !== lastStatus) {
      if (lastStatus) process.stdout.write("\n");
      process.stdout.write(`Status: ${s.status}`);
      lastStatus = s.status;
    } else {
      process.stdout.write(".");
    }

    if (s.status === "completed" || s.status === "failed") {
      process.stdout.write("\n\n");
      console.log(`Exit code: ${s.exitCode ?? "N/A"}`);
      console.log(`Duration:  ${s.durationMs ? `${Math.round(s.durationMs / 1000)}s` : "N/A"}`);
      console.log(`Log file:  ${s.logFile}`);
      console.log(`Committed: ${s.committed ?? false}`);
      if (s.error) console.log(`Error:     ${s.error}`);
      process.exit(s.exitCode !== 0 ? s.exitCode ?? 1 : 0);
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
