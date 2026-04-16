/**
 * Review command: invoke the Solution Architect to review the Problem Pack.
 *
 * User-invoked, advisory, repeatable. The architect reviews the problem
 * definition, identifies gaps, and produces an initial implementation plan.
 */

import type { Command } from "commander";
import { isServerReachable, post, get } from "../client.js";
import { formatElapsed } from "../format.js";

interface ReviewStartResponse {
  projectId: string;
  status: string;
  logFile: string;
  message: string;
}

interface ReviewStatusResponse {
  projectId: string;
  projectName: string;
  status: "preparing" | "executing" | "collecting" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  logFile: string;
  signals?: {
    readiness: string;
    gaps: string[];
    suggestions: string[];
    risks: string[];
    recommended_approach?: string;
  };
  error?: string;
}

export function registerReviewCommand(program: Command): void {
  program
    .command("review")
    .description("Run Solution Architect review on the Problem Pack (advisory, repeatable)")
    .requiredOption("--project <name>", "Project name or ID")
    .option("--problem-pack <path>", "Path to Problem Pack directory")
    .action(async (opts) => {
      if (!(await isServerReachable())) {
        console.error("cfcf server is not running. Start it with: cfcf server start");
        process.exit(1);
      }

      console.log(`Project:  ${opts.project}`);
      console.log(`Mode:     Solution Architect review`);
      console.log();

      const body: Record<string, unknown> = {};
      if (opts.problemPack) {
        body.problemPackPath = opts.problemPack;
      }

      // Start the review
      const startRes = await post<ReviewStartResponse>(
        `/api/projects/${encodeURIComponent(opts.project)}/review`,
        Object.keys(body).length > 0 ? body : undefined,
      );

      if (!startRes.ok) {
        console.error(`Failed to start review: ${startRes.error}`);
        process.exit(1);
      }

      const start = startRes.data!;
      console.log(`Architect review started`);
      console.log(`Log file: ${start.logFile}`);
      console.log();

      // Poll for status with elapsed time
      const projectParam = encodeURIComponent(opts.project);
      let lastStatus = "";
      let statusStartTime = Date.now();

      while (true) {
        const statusRes = await get<ReviewStatusResponse>(
          `/api/projects/${projectParam}/review/status`,
        );

        if (!statusRes.ok) {
          console.error(`Failed to get review status: ${statusRes.error}`);
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
          printReviewResult(s);
          process.exit(s.status === "failed" ? 1 : 0);
        }

        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    });
}

function printReviewResult(r: ReviewStatusResponse): void {
  console.log(`=== Architect Review ${r.status.toUpperCase()} ===`);
  console.log();

  if (r.error) {
    console.log(`Error:      ${r.error}`);
    console.log();
  }

  if (r.signals) {
    console.log(`Readiness:  ${r.signals.readiness}`);
    console.log();

    if (r.signals.gaps.length > 0) {
      console.log("Gaps identified:");
      for (const gap of r.signals.gaps) {
        console.log(`  - ${gap}`);
      }
      console.log();
    }

    if (r.signals.suggestions.length > 0) {
      console.log("Suggestions:");
      for (const s of r.signals.suggestions) {
        console.log(`  - ${s}`);
      }
      console.log();
    }

    if (r.signals.risks.length > 0) {
      console.log("Risks:");
      for (const risk of r.signals.risks) {
        console.log(`  - ${risk}`);
      }
      console.log();
    }

    if (r.signals.recommended_approach) {
      console.log(`Approach:   ${r.signals.recommended_approach}`);
      console.log();
    }
  } else {
    console.log("Architect signal file not received. Check the review document manually.");
    console.log();
  }

  console.log("What to do next:");
  console.log(`  Read full review:   cat cfcf-docs/architect-review.md`);
  console.log(`  Read plan outline:  cat cfcf-docs/plan.md`);
  console.log(`  Refine & re-review: cfcf review --project ${r.projectName}`);
  console.log(`  Start development:  cfcf run --project ${r.projectName}`);
}
