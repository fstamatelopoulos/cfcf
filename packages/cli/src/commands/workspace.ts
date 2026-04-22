/**
 * Workspace management commands: init, list, show, delete.
 */

import type { Command } from "commander";
import { resolve, join } from "path";
import { mkdir, writeFile, access } from "fs/promises";
import { post, get } from "../client.js";
import { isServerReachable } from "../client.js";
import { createInterface } from "readline";
import type { WorkspaceConfig } from "@cfcf/core";
import { formatAgent } from "../format.js";

export function registerWorkspaceCommands(program: Command): void {
  const workspace = program
    .command("workspace")
    .description("Manage cfcf workspaces");

  workspace
    .command("init")
    .description("Initialize a new cfcf workspace")
    .requiredOption("--repo <path>", "Path to the git repository")
    .requiredOption("--name <name>", "Workspace name")
    .action(async (opts) => {
      if (!(await isServerReachable())) {
        console.error("cfcf server is not running. Start it with: cfcf server start");
        process.exit(1);
      }

      const repoPath = resolve(opts.repo);

      const res = await post<WorkspaceConfig>("/api/workspaces", {
        name: opts.name,
        repoPath,
      });

      if (!res.ok) {
        console.error(`Failed to create workspace: ${res.error}`);
        process.exit(1);
      }

      const w = res.data!;

      // Scaffold problem-pack/ directory in the repo if it doesn't exist
      const packDir = join(repoPath, "problem-pack");
      try {
        await access(packDir);
        console.log("problem-pack/ directory already exists, skipping scaffold.");
      } catch {
        await mkdir(packDir, { recursive: true });
        await writeFile(
          join(packDir, "problem.md"),
          "# Problem Definition\n\n<!-- Describe what needs to be built or fixed. -->\n",
          "utf-8",
        );
        await writeFile(
          join(packDir, "success.md"),
          "# Success Criteria\n\n<!-- Define how success is measured. Which tests must pass? -->\n",
          "utf-8",
        );
        console.log("Created problem-pack/ directory with templates.");
      }

      console.log();
      console.log(`Workspace created: ${w.name}`);
      console.log(`  ID:         ${w.id}`);
      console.log(`  Repo:       ${w.repoPath}`);
      console.log(`  Dev:        ${formatAgent(w.devAgent)}`);
      console.log(`  Judge:      ${formatAgent(w.judgeAgent)}`);
      console.log(`  Architect:  ${formatAgent(w.architectAgent)}`);
      console.log(`  Documenter: ${formatAgent(w.documenterAgent)}`);
      console.log(`  Max iters:  ${w.maxIterations}`);
      console.log();
      console.log("Next steps:");
      console.log(`  1. Edit problem-pack/problem.md with your problem definition`);
      console.log(`  2. Edit problem-pack/success.md with success criteria`);
      console.log(`  3. Optionally add: constraints.md, hints.md, style-guide.md, context/`);
      console.log(`  4. Review your problem definition:  cfcf review --workspace ${w.name}  (recommended)`);
      console.log(`  5. Launch development:              cfcf run --workspace ${w.name}`);
    });

  workspace
    .command("list")
    .description("List all workspaces")
    .action(async () => {
      if (!(await isServerReachable())) {
        console.error("cfcf server is not running. Start it with: cfcf server start");
        process.exit(1);
      }

      const res = await get<WorkspaceConfig[]>("/api/workspaces");
      if (!res.ok) {
        console.error(`Failed to list workspaces: ${res.error}`);
        process.exit(1);
      }

      const workspaces = res.data!;
      if (workspaces.length === 0) {
        console.log("No workspaces. Create one with: cfcf workspace init --repo <path> --name <name>");
        return;
      }

      console.log(`${workspaces.length} workspace(s):\n`);
      for (const w of workspaces) {
        console.log(`  ${w.name} (${w.id})`);
        console.log(`    Repo:  ${w.repoPath}`);
        console.log(`    Dev: ${formatAgent(w.devAgent)}  Judge: ${formatAgent(w.judgeAgent)}  Architect: ${formatAgent(w.architectAgent)}  Documenter: ${formatAgent(w.documenterAgent)}`);
        console.log();
      }
    });

  workspace
    .command("show <name>")
    .description("Show workspace configuration")
    .action(async (name) => {
      if (!(await isServerReachable())) {
        console.error("cfcf server is not running. Start it with: cfcf server start");
        process.exit(1);
      }

      const res = await get<WorkspaceConfig>(`/api/workspaces/${encodeURIComponent(name)}`);
      if (!res.ok) {
        console.error(`Workspace not found: ${name}`);
        process.exit(1);
      }

      const w = res.data!;
      console.log(`Workspace: ${w.name}`);
      console.log(`  ID:             ${w.id}`);
      console.log(`  Repo:           ${w.repoPath}`);
      console.log(`  Dev agent:         ${formatAgent(w.devAgent)}`);
      console.log(`  Judge agent:       ${formatAgent(w.judgeAgent)}`);
      console.log(`  Architect:         ${formatAgent(w.architectAgent)}`);
      console.log(`  Documenter:        ${formatAgent(w.documenterAgent)}`);
      if (w.reflectionAgent) {
        console.log(`  Reflection:        ${formatAgent(w.reflectionAgent)}`);
      }
      console.log(`  Max iterations:    ${w.maxIterations}`);
      console.log(`  Pause every:       ${w.pauseEvery === 0 ? "never" : `${w.pauseEvery} iterations`}`);
      console.log(`  On stalled:        ${w.onStalled}`);
      console.log(`  Merge strategy:    ${w.mergeStrategy}`);
      console.log(`  Reflect safeguard: force after ${w.reflectSafeguardAfter ?? 3} consecutive opt-outs`);
      console.log(`  Auto review specs: ${w.autoReviewSpecs ? "yes (runs Solution Architect before every loop)" : "no (Review is optional)"}`);
      if (w.autoReviewSpecs) {
        console.log(`  Readiness gate:    ${w.readinessGate ?? "blocked"}`);
      }
      console.log(`  Auto documenter:   ${w.autoDocumenter === false ? "no (user invokes cfcf document manually)" : "yes (runs on SUCCESS)"}`);
      console.log(`  Cleanup branches:  ${w.cleanupMergedBranches ? "yes (delete after merge)" : "no (keep for audit)"}`);
      console.log(`  Template:          ${w.processTemplate}`);
      console.log(`  Iterations:        ${w.currentIteration || 0} completed`);
    });

  workspace
    .command("delete <name>")
    .description("Delete a cfcf workspace (removes config only, not the repo)")
    .action(async (name) => {
      if (!(await isServerReachable())) {
        console.error("cfcf server is not running. Start it with: cfcf server start");
        process.exit(1);
      }

      // Look up the workspace first to get its ID
      const lookup = await get<WorkspaceConfig>(`/api/workspaces/${encodeURIComponent(name)}`);
      if (!lookup.ok) {
        console.error(`Workspace not found: ${name}`);
        process.exit(1);
      }

      const w = lookup.data!;

      // Confirm deletion
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question(`Delete workspace "${w.name}" (${w.id})? This does not delete the repo. [yes/no]: `, resolve);
      });
      rl.close();

      if (answer.toLowerCase() !== "yes" && answer.toLowerCase() !== "y") {
        console.log("Cancelled.");
        return;
      }

      const res = await fetch(`http://localhost:${process.env.CFCF_PORT || "7233"}/api/workspaces/${w.id}`, {
        method: "DELETE",
      });

      if (res.ok) {
        console.log(`Deleted workspace: ${w.name}`);
      } else {
        console.error("Failed to delete workspace.");
        process.exit(1);
      }
    });
}
