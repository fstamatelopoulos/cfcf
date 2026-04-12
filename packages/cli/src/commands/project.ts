/**
 * Project management commands: init, list, show.
 */

import type { Command } from "commander";
import { resolve } from "path";
import { post, get } from "../client.js";
import { isServerReachable } from "../client.js";
import { createInterface } from "readline";
import type { ProjectConfig } from "@cfcf/core";

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
      console.log(`Project created: ${p.name}`);
      console.log(`  ID:         ${p.id}`);
      console.log(`  Repo:       ${p.repoPath}`);
      console.log(`  Dev agent:  ${p.devAgent.adapter}`);
      console.log(`  Judge:      ${p.judgeAgent.adapter}`);
      console.log(`  Max iters:  ${p.maxIterations}`);
      console.log();
      console.log(`Run a command: cfcf run --project ${p.name} -- <command>`);
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
        console.log(`    Dev:   ${p.devAgent.adapter}  Judge: ${p.judgeAgent.adapter}`);
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
      console.log(`  Dev agent:      ${p.devAgent.adapter}${p.devAgent.model ? ` (${p.devAgent.model})` : ""}`);
      console.log(`  Judge agent:    ${p.judgeAgent.adapter}${p.judgeAgent.model ? ` (${p.judgeAgent.model})` : ""}`);
      console.log(`  Max iterations: ${p.maxIterations}`);
      console.log(`  Pause every:    ${p.pauseEvery === 0 ? "never" : `${p.pauseEvery} iterations`}`);
      console.log(`  On stalled:     ${p.onStalled}`);
      console.log(`  Merge strategy: ${p.mergeStrategy}`);
      console.log(`  Template:       ${p.processTemplate}`);
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
