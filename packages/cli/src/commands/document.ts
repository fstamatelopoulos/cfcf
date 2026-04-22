/**
 * Document command: run the Documenter agent to produce polished workspace documentation.
 *
 * User-invoked, repeatable. Also runs automatically post-SUCCESS in the loop.
 */

import type { Command } from "commander";
import { isServerReachable, post, get } from "../client.js";
import { formatElapsed } from "../format.js";

interface DocumentStartResponse {
  workspaceId: string;
  status: string;
  logFile: string;
  message: string;
}

interface DocumentStatusResponse {
  workspaceId: string;
  workspaceName: string;
  status: "preparing" | "executing" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  logFile: string;
  error?: string;
}

export function registerDocumentCommand(program: Command): void {
  program
    .command("document")
    .description("Generate polished workspace documentation (runs the Documenter agent)")
    .requiredOption("--workspace <name>", "Workspace name or ID")
    .action(async (opts) => {
      if (!(await isServerReachable())) {
        console.error("cfcf server is not running. Start it with: cfcf server start");
        process.exit(1);
      }

      console.log(`Workspace: ${opts.workspace}`);
      console.log(`Mode:      Documenter (final documentation)`);
      console.log();

      // Start the documenter
      const startRes = await post<DocumentStartResponse>(
        `/api/workspaces/${encodeURIComponent(opts.workspace)}/document`,
      );

      if (!startRes.ok) {
        console.error(`Failed to start documenter: ${startRes.error}`);
        process.exit(1);
      }

      const start = startRes.data!;
      console.log(`Documenter started`);
      console.log(`Log file: ${start.logFile}`);
      console.log();

      // Poll for status with elapsed time
      const workspaceParam = encodeURIComponent(opts.workspace);
      let lastStatus = "";
      let statusStartTime = Date.now();

      while (true) {
        const statusRes = await get<DocumentStatusResponse>(
          `/api/workspaces/${workspaceParam}/document/status`,
        );

        if (!statusRes.ok) {
          console.error(`Failed to get documenter status: ${statusRes.error}`);
          process.exit(1);
        }

        const s = statusRes.data!;

        if (s.status !== lastStatus) {
          if (lastStatus) process.stdout.write("\n");
          process.stdout.write(`${s.status}`);
          lastStatus = s.status;
          statusStartTime = Date.now();
        } else {
          const elapsed = Math.floor((Date.now() - statusStartTime) / 1000);
          process.stdout.write(`\r${s.status} ${formatElapsed(elapsed)}`);
        }

        if (s.status === "completed" || s.status === "failed") {
          process.stdout.write("\n\n");
          printDocumentResult(s);
          process.exit(s.status === "failed" ? 1 : 0);
        }

        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    });
}

function printDocumentResult(r: DocumentStatusResponse): void {
  console.log(`=== Documenter ${r.status.toUpperCase()} ===`);
  console.log();

  if (r.error) {
    console.log(`Error:    ${r.error}`);
    console.log();
  }

  if (r.status === "completed") {
    console.log("Documentation generated in docs/:");
    console.log("  docs/architecture.md   -- system architecture");
    console.log("  docs/api-reference.md  -- API documentation (if applicable)");
    console.log("  docs/setup-guide.md    -- setup and usage guide");
    console.log("  docs/README.md         -- workspace overview");
    console.log();
  }

  console.log("What to do next:");
  console.log(`  Review docs:  ls docs/`);
  console.log(`  Re-generate:  cfcf document --workspace ${r.workspaceName}`);
}
