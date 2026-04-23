/**
 * Workspace management commands: init, list, show, delete, set.
 */

import type { Command } from "commander";
import { resolve, join } from "path";
import { mkdir, writeFile, access } from "fs/promises";
import { post, get, put } from "../client.js";
import { isServerReachable } from "../client.js";
import { createInterface } from "readline";
import type { WorkspaceConfig } from "@cfcf/core";
import { formatAgent } from "../format.js";

// ── Clio Project types (mirrors packages/core/src/clio/types.ts; kept here
// ── to avoid the CLI importing the Clio backend) ────────────────────────
interface ClioProjectListItem {
  id: string;
  name: string;
  description?: string;
  documentCount?: number;
}

export function registerWorkspaceCommands(program: Command): void {
  const workspace = program
    .command("workspace")
    .description("Manage cfcf workspaces");

  workspace
    .command("init")
    .description("Initialize a new cfcf workspace")
    .requiredOption("--repo <path>", "Path to the git repository")
    .requiredOption("--name <name>", "Workspace name")
    .option(
      "--project <clio-project>",
      "Clio Project (cross-workspace memory grouping) this workspace belongs to. " +
      "Skip to pick interactively, or leave unset to auto-route to 'default'.",
    )
    .option(
      "--no-prompt",
      "Skip all interactive prompts. Workspace is created with whatever is passed via flags.",
    )
    .action(async (opts) => {
      if (!(await isServerReachable())) {
        console.error("cfcf server is not running. Start it with: cfcf server start");
        process.exit(1);
      }

      const repoPath = resolve(opts.repo);

      // If no --project flag + interactive TTY + --no-prompt not set, ask
      // the user which Clio Project to attach to. This matches the design
      // doc §12.1 Q4 ("strongly suggested interactive nudge").
      let clioProject: string | undefined = opts.project;
      if (clioProject === undefined && opts.prompt !== false && process.stdin.isTTY) {
        clioProject = await promptForClioProject();
      }

      const res = await post<WorkspaceConfig>("/api/workspaces", {
        name: opts.name,
        repoPath,
        clioProject,
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
      console.log(`  ID:             ${w.id}`);
      console.log(`  Repo:           ${w.repoPath}`);
      console.log(`  Clio Project:   ${w.clioProject ?? "(none — will auto-route to 'default' on first ingest)"}`);
      console.log(`  Dev:            ${formatAgent(w.devAgent)}`);
      console.log(`  Judge:          ${formatAgent(w.judgeAgent)}`);
      console.log(`  Architect:      ${formatAgent(w.architectAgent)}`);
      console.log(`  Documenter:     ${formatAgent(w.documenterAgent)}`);
      console.log(`  Max iters:      ${w.maxIterations}`);
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
        const projectLabel = w.clioProject ? `  [Clio: ${w.clioProject}]` : "";
        console.log(`  ${w.name} (${w.id})${projectLabel}`);
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
      console.log(`  Clio Project:   ${w.clioProject ?? "(none — auto-routes to 'default' on first ingest)"}`);
      console.log(`  Clio policy:    ${w.clio?.ingestPolicy ?? "(inherit global)"}`);
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

  // `cfcf workspace set` — rewire workspace's Clio Project assignment
  // (item 5.7, §12.1 Q1). `--migrate-history` re-keys this workspace's
  // historical Clio documents into the new Project; add
  // `--all-in-project` to additionally sweep every sibling workspace's
  // docs out of the old Project too (rare; for collapsing an empty
  // Project into another).
  workspace
    .command("set <name>")
    .description(
      "Modify a workspace's configuration. Today: change the Clio Project assignment.\n" +
      "\n" +
      "Default: future cf²-auto ingests route to the new Project; existing\n" +
      "documents stay under the old one (audit-faithful, no schema change).\n" +
      "\n" +
      "With --migrate-history: additionally re-keys this workspace's past docs\n" +
      "(filtered by metadata.workspace_id) into the new Project. Sibling\n" +
      "workspaces sharing the old Project are NOT touched.\n" +
      "\n" +
      "With --migrate-history --all-in-project: re-keys every doc currently\n" +
      "in the old Project into the new one regardless of which workspace\n" +
      "produced it. Use this when you're collapsing a Project into another\n" +
      "(you understand you're moving sibling workspaces' memory too).",
    )
    .requiredOption(
      "--project <clio-project>",
      "New Clio Project name. Auto-created if it doesn't exist.",
    )
    .option(
      "--migrate-history",
      "Re-key this workspace's historical Clio documents from the old Project to the new one (filtered by metadata.workspace_id).",
    )
    .option(
      "--all-in-project",
      "Only with --migrate-history: widen the re-key to every document in the old Project, not just this workspace's. Use only when collapsing Projects.",
    )
    .action(async (name, opts) => {
      if (!(await isServerReachable())) {
        console.error("cfcf server is not running. Start it with: cfcf server start");
        process.exit(1);
      }
      if (opts.allInProject && !opts.migrateHistory) {
        console.error("--all-in-project has no effect without --migrate-history. Add --migrate-history or remove --all-in-project.");
        process.exit(1);
      }

      const lookup = await get<WorkspaceConfig>(`/api/workspaces/${encodeURIComponent(name)}`);
      if (!lookup.ok) {
        console.error(`Workspace not found: ${name}`);
        process.exit(1);
      }
      const w = lookup.data!;
      const oldProject = w.clioProject ?? "(unset)";

      const res = await put<{ workspace: WorkspaceConfig; migrated?: number }>(
        `/api/workspaces/${w.id}/clio-project`,
        {
          project: opts.project,
          migrateHistory: !!opts.migrateHistory,
          allInProject: !!opts.allInProject,
        },
      );

      if (!res.ok) {
        console.error(`Failed to set Clio Project: ${res.error}`);
        process.exit(1);
      }

      console.log(`Workspace ${w.name}: Clio Project ${oldProject} → ${res.data!.workspace.clioProject}`);
      if (opts.migrateHistory) {
        const scope = opts.allInProject ? "all docs in old Project" : `docs tagged to workspace ${w.id}`;
        console.log(`  Re-keyed ${res.data!.migrated ?? 0} historical document(s) (${scope}).`);
      } else {
        console.log(`  Historical documents remain under "${oldProject}". Pass --migrate-history to re-key this workspace's docs.`);
      }
    });
}

/**
 * Interactive Clio Project picker for `cfcf workspace init` when --project
 * is not passed. Lists existing Projects + offers "new" + offers "skip".
 */
async function promptForClioProject(): Promise<string | undefined> {
  // Pull the list of existing Clio Projects via the server.
  const res = await get<{ projects: ClioProjectListItem[] }>("/api/clio/projects");
  const existing = res.ok && res.data ? res.data.projects : [];

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));

  console.log();
  console.log("Clio Project assignment (cross-workspace memory)");
  console.log("─".repeat(50));
  console.log("Workspaces can share memory through a Clio Project -- a named grouping");
  console.log("of workspaces in related domains (e.g. 'backend-services' for a bunch of");
  console.log("TypeScript API repos, or 'cf-ecosystem' for cf² + Clio + Cerefox code).");
  console.log("Searches made inside this workspace see cross-workspace knowledge from");
  console.log("siblings in the same Project; workspaces in different Projects stay");
  console.log("isolated by default.");
  console.log();

  if (existing.length === 0) {
    console.log("No Clio Projects exist yet.");
    const answer = await ask(
      "Create a new one for this workspace? (enter a name, or press Enter to skip and use 'default'): ",
    );
    rl.close();
    const trimmed = answer.trim();
    return trimmed || undefined;
  }

  console.log("Existing Clio Projects:");
  existing.forEach((p, i) => {
    const desc = p.description ? ` — ${p.description}` : "";
    const count = p.documentCount != null ? ` (${p.documentCount} doc${p.documentCount === 1 ? "" : "s"})` : "";
    console.log(`  ${i + 1}) ${p.name}${count}${desc}`);
  });
  console.log(`  N) Create a new Project`);
  console.log(`  S) Skip (route to 'default' Project on first ingest)`);

  const answer = (await ask("Pick one [1-" + existing.length + " / N / S]: ")).trim();
  const asNum = parseInt(answer, 10);
  if (!isNaN(asNum) && asNum >= 1 && asNum <= existing.length) {
    rl.close();
    return existing[asNum - 1].name;
  }
  if (answer.toLowerCase() === "n") {
    const newName = (await ask("New Clio Project name: ")).trim();
    rl.close();
    return newName || undefined;
  }
  // "S", empty, or anything else -> skip
  rl.close();
  return undefined;
}
