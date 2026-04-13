/**
 * Status command: show cfcf server status and active loop state.
 */

import type { Command } from "commander";
import { get } from "../client.js";
import { configExists, readConfig } from "@cfcf/core";
import { formatAgent } from "../format.js";

interface LoopStatusResponse {
  projectId: string;
  projectName: string;
  phase: string;
  currentIteration: number;
  maxIterations: number;
  pauseReason?: string;
  pendingQuestions?: string[];
  outcome?: string;
  consecutiveStalled: number;
  iterations: Array<{
    number: number;
    judgeSignals?: { determination: string; quality_score: number; key_concern?: string };
    merged: boolean;
  }>;
}

interface ProjectListItem {
  id: string;
  name: string;
  status?: string;
  currentIteration: number;
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show cfcf status (server, config, project loops)")
    .option("--project <name>", "Show detailed status for a specific project")
    .action(async (opts) => {
      // Check config
      const hasConfig = await configExists();
      if (!hasConfig) {
        console.log("cfcf is not configured. Run 'cfcf init' to set up.");
        console.log();
        return;
      }

      const config = await readConfig();
      if (config) {
        console.log("Configuration:");
        console.log(`  Dev agent:       ${formatAgent(config.devAgent)}`);
        console.log(`  Judge agent:     ${formatAgent(config.judgeAgent)}`);
        console.log(`  Architect agent: ${formatAgent(config.architectAgent)}`);
        console.log(`  Max iterations:  ${config.maxIterations}`);
        console.log(`  Pause every:     ${config.pauseEvery === 0 ? "never" : `${config.pauseEvery} iterations`}`);
        console.log();
      }

      // Check server
      const healthRes = await get("/api/health");
      if (!healthRes.ok) {
        console.log("Server: not running");
        console.log("  Start with: cfcf server start");
        return;
      }
      console.log("Server: running");
      console.log();

      if (opts.project) {
        // Detailed project status
        await showProjectStatus(opts.project);
      } else {
        // Overview of all projects
        await showProjectOverview();
      }
    });
}

async function showProjectOverview(): Promise<void> {
  const res = await get<ProjectListItem[]>("/api/projects");
  if (!res.ok || !res.data || res.data.length === 0) {
    console.log("No projects found. Create one with: cfcf project init --repo <path> --name <name>");
    return;
  }

  console.log("Projects:");
  for (const p of res.data) {
    const status = p.status ?? "idle";
    const iter = p.currentIteration > 0 ? ` (iteration ${p.currentIteration})` : "";
    console.log(`  ${p.name}: ${status}${iter}`);
  }
}

async function showProjectStatus(project: string): Promise<void> {
  const loopRes = await get<LoopStatusResponse>(
    `/api/projects/${encodeURIComponent(project)}/loop/status`,
  );

  if (!loopRes.ok) {
    // No active loop -- show basic project info
    const projRes = await get<ProjectListItem>(
      `/api/projects/${encodeURIComponent(project)}`,
    );
    if (!projRes.ok) {
      console.error(`Project not found: ${project}`);
      return;
    }
    const p = projRes.data!;
    console.log(`Project:    ${p.name}`);
    console.log(`Status:     ${p.status ?? "idle"}`);
    console.log(`Iterations: ${p.currentIteration}`);
    console.log();
    console.log("No active loop. Start with: cfcf run --project " + p.name);
    return;
  }

  const s = loopRes.data!;
  console.log(`Project:     ${s.projectName}`);
  console.log(`Phase:       ${s.phase}`);
  console.log(`Iteration:   ${s.currentIteration}/${s.maxIterations}`);

  if (s.pauseReason) {
    console.log(`Pause reason: ${s.pauseReason}`);
  }
  if (s.outcome) {
    console.log(`Outcome:     ${s.outcome}`);
  }
  if (s.consecutiveStalled > 0) {
    console.log(`Stalled:     ${s.consecutiveStalled} consecutive`);
  }

  if (s.pendingQuestions && s.pendingQuestions.length > 0) {
    console.log();
    console.log("Pending questions:");
    for (const q of s.pendingQuestions) {
      console.log(`  -> ${q}`);
    }
  }

  if (s.iterations.length > 0) {
    console.log();
    console.log("Iteration history:");
    for (const iter of s.iterations) {
      const judge = iter.judgeSignals
        ? `${iter.judgeSignals.determination} (${iter.judgeSignals.quality_score}/10)`
        : "pending";
      const merged = iter.merged ? "merged" : "";
      console.log(`  ${iter.number}: ${judge} ${merged}`);
    }
  }
}
