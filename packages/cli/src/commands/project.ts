/**
 * Project management commands: init, list, show.
 */

import type { Command } from "commander";
import { resolve, join } from "path";
import { mkdir, writeFile, access } from "fs/promises";
import { post, get } from "../client.js";
import { isServerReachable } from "../client.js";
import { createInterface } from "readline";
import type { ProjectConfig } from "@cfcf/core";
import { formatAgent } from "../format.js";

export function registerProjectCommands(program: Command): void {
  const project = program
    .command("project")
    .description("Manage cfcf projects");

  project
    .command("init")
    .description("Initialize a new cfcf project")
    .requiredOption("--repo <path>", "Path to the git repository")
    .requiredOption("--name <name>", "Project name")
    .option("--repo-url <url>", "Remote git repo URL")
    .action(async (opts) => {
      if (!(await isServerReachable())) {
        console.error("cfcf server is not running. Start it with: cfcf server start");
        process.exit(1);
      }

      const repoPath = resolve(opts.repo);

      const res = await post<ProjectConfig>("/api/projects", {
        name: opts.name,
        repoPath,
        repoUrl: opts.repoUrl,
      });

      if (!res.ok) {
        console.error(`Failed to create project: ${res.error}`);
        process.exit(1);
      }

      const p = res.data!;

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
      console.log(`Project created: ${p.name}`);
      console.log(`  ID:         ${p.id}`);
      console.log(`  Repo:       ${p.repoPath}`);
      console.log(`  Dev:        ${formatAgent(p.devAgent)}`);
      console.log(`  Judge:      ${formatAgent(p.judgeAgent)}`);
      console.log(`  Architect:  ${formatAgent(p.architectAgent)}`);
      console.log(`  Documenter: ${formatAgent(p.documenterAgent)}`);
      console.log(`  Max iters:  ${p.maxIterations}`);
      console.log();
      console.log("Next steps:");
      console.log(`  1. Edit problem-pack/problem.md with your problem definition`);
      console.log(`  2. Edit problem-pack/success.md with success criteria`);
      console.log(`  3. Optionally add: constraints.md, hints.md, style-guide.md, context/`);
      console.log(`  4. Review your problem definition:  cfcf review --project ${p.name}  (recommended)`);
      console.log(`  5. Launch development:              cfcf run --project ${p.name}`);
    });

  project
    .command("list")
    .description("List all projects")
    .action(async () => {
      if (!(await isServerReachable())) {
        console.error("cfcf server is not running. Start it with: cfcf server start");
        process.exit(1);
      }

      const res = await get<ProjectConfig[]>("/api/projects");
      if (!res.ok) {
        console.error(`Failed to list projects: ${res.error}`);
        process.exit(1);
      }

      const projects = res.data!;
      if (projects.length === 0) {
        console.log("No projects. Create one with: cfcf project init --repo <path> --name <name>");
        return;
      }

      console.log(`${projects.length} project(s):\n`);
      for (const p of projects) {
        console.log(`  ${p.name} (${p.id})`);
        console.log(`    Repo:  ${p.repoPath}`);
        console.log(`    Dev: ${formatAgent(p.devAgent)}  Judge: ${formatAgent(p.judgeAgent)}  Architect: ${formatAgent(p.architectAgent)}  Documenter: ${formatAgent(p.documenterAgent)}`);
        console.log();
      }
    });

  project
    .command("show <name>")
    .description("Show project configuration")
    .action(async (name) => {
      if (!(await isServerReachable())) {
        console.error("cfcf server is not running. Start it with: cfcf server start");
        process.exit(1);
      }

      const res = await get<ProjectConfig>(`/api/projects/${encodeURIComponent(name)}`);
      if (!res.ok) {
        console.error(`Project not found: ${name}`);
        process.exit(1);
      }

      const p = res.data!;
      console.log(`Project: ${p.name}`);
      console.log(`  ID:             ${p.id}`);
      console.log(`  Repo:           ${p.repoPath}`);
      console.log(`  Remote:         ${p.repoUrl || "(not set)"}`);
      console.log(`  Dev agent:         ${formatAgent(p.devAgent)}`);
      console.log(`  Judge agent:       ${formatAgent(p.judgeAgent)}`);
      console.log(`  Architect:         ${formatAgent(p.architectAgent)}`);
      console.log(`  Documenter:        ${formatAgent(p.documenterAgent)}`);
      if (p.reflectionAgent) {
        console.log(`  Reflection:        ${formatAgent(p.reflectionAgent)}`);
      }
      console.log(`  Max iterations:    ${p.maxIterations}`);
      console.log(`  Pause every:       ${p.pauseEvery === 0 ? "never" : `${p.pauseEvery} iterations`}`);
      console.log(`  On stalled:        ${p.onStalled}`);
      console.log(`  Merge strategy:    ${p.mergeStrategy}`);
      console.log(`  Reflect safeguard: force after ${p.reflectSafeguardAfter ?? 3} consecutive opt-outs`);
      console.log(`  Auto review specs: ${p.autoReviewSpecs ? "yes (runs Solution Architect before every loop)" : "no (Review is optional)"}`);
      if (p.autoReviewSpecs) {
        console.log(`  Readiness gate:    ${p.readinessGate ?? "blocked"}`);
      }
      console.log(`  Auto documenter:   ${p.autoDocumenter === false ? "no (user invokes cfcf document manually)" : "yes (runs on SUCCESS)"}`);
      console.log(`  Cleanup branches:  ${p.cleanupMergedBranches ? "yes (delete after merge)" : "no (keep for audit)"}`);
      console.log(`  Template:          ${p.processTemplate}`);
      console.log(`  Iterations:        ${p.currentIteration || 0} completed`);
    });

  project
    .command("delete <name>")
    .description("Delete a cfcf project (removes config only, not the repo)")
    .action(async (name) => {
      if (!(await isServerReachable())) {
        console.error("cfcf server is not running. Start it with: cfcf server start");
        process.exit(1);
      }

      // Look up the project first to get its ID
      const lookup = await get<ProjectConfig>(`/api/projects/${encodeURIComponent(name)}`);
      if (!lookup.ok) {
        console.error(`Project not found: ${name}`);
        process.exit(1);
      }

      const p = lookup.data!;

      // Confirm deletion
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question(`Delete project "${p.name}" (${p.id})? This does not delete the repo. [yes/no]: `, resolve);
      });
      rl.close();

      if (answer.toLowerCase() !== "yes" && answer.toLowerCase() !== "y") {
        console.log("Cancelled.");
        return;
      }

      const res = await fetch(`http://localhost:${process.env.CFCF_PORT || "7233"}/api/projects/${p.id}`, {
        method: "DELETE",
      });

      if (res.ok) {
        console.log(`Deleted project: ${p.name}`);
      } else {
        console.error("Failed to delete project.");
        process.exit(1);
      }
    });
}
