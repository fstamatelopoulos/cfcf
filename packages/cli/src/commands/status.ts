/**
 * Status command: show cfcf server status and active loop state.
 */

import type { Command } from "commander";
import { get } from "../client.js";
import { configExists, readConfig } from "@cfcf/core";
import { formatAgent } from "../format.js";

interface LoopStatusResponse {
  workspaceId: string;
  workspaceName: string;
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

interface WorkspaceListItem {
  id: string;
  name: string;
  status?: string;
  currentIteration: number;
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show cfcf status (server, config, workspace loops)")
    .option("--workspace <name>", "Show detailed status for a specific workspace")
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
        console.log(`  Documenter:      ${formatAgent(config.documenterAgent)}`);
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

      if (opts.workspace) {
        // Detailed workspace status
        await showWorkspaceStatus(opts.workspace);
      } else {
        // Overview of all workspaces
        await showWorkspaceOverview();
      }
    });
}

async function showWorkspaceOverview(): Promise<void> {
  const res = await get<WorkspaceListItem[]>("/api/workspaces");
  if (!res.ok || !res.data || res.data.length === 0) {
    console.log("No workspaces found. Create one with: cfcf workspace init --repo <path> --name <name>");
    return;
  }

  console.log("Workspaces:");
  for (const w of res.data) {
    const status = w.status ?? "idle";
    const iter = w.currentIteration > 0 ? ` (iteration ${w.currentIteration})` : "";
    console.log(`  ${w.name}: ${status}${iter}`);
  }
}

async function showWorkspaceStatus(workspace: string): Promise<void> {
  const loopRes = await get<LoopStatusResponse>(
    `/api/workspaces/${encodeURIComponent(workspace)}/loop/status`,
  );

  if (!loopRes.ok) {
    // No active loop -- show basic workspace info
    const wsRes = await get<WorkspaceListItem>(
      `/api/workspaces/${encodeURIComponent(workspace)}`,
    );
    if (!wsRes.ok) {
      console.error(`Workspace not found: ${workspace}`);
      return;
    }
    const w = wsRes.data!;
    console.log(`Workspace:  ${w.name}`);
    console.log(`Status:     ${w.status ?? "idle"}`);
    console.log(`Iterations: ${w.currentIteration}`);
    console.log();
    console.log("No active loop. Start with: cfcf run --workspace " + w.name);
    return;
  }

  const s = loopRes.data!;
  console.log(`Workspace:   ${s.workspaceName}`);
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
