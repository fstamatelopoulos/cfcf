/**
 * Context assembler for cfcf.
 *
 * Assembles the full context for an iteration: reads the Problem Pack,
 * merges with iteration history, judge feedback, user feedback,
 * and writes everything into the project repo as cfcf-docs/ + CLAUDE.md.
 */

import { join, dirname } from "path";
import { mkdir, writeFile, readFile, copyFile, access, readdir } from "fs/promises";
import type { ProblemPack } from "./problem-pack.js";
import type { ProjectConfig, DevSignals } from "./types.js";

const TEMPLATES_DIR = join(dirname(new URL(import.meta.url).pathname), "templates");

export interface IterationContext {
  /** Current iteration number */
  iteration: number;
  /** The problem pack contents */
  problemPack: ProblemPack;
  /** Project configuration */
  project: ProjectConfig;
  /** Previous iteration's handoff summary (if any) */
  previousHandoff?: string;
  /** Previous iteration's judge assessment (if any) */
  previousJudgeAssessment?: string;
  /** User feedback (if any) */
  userFeedback?: string;
  /** Compressed iteration history */
  iterationHistory?: string;
}

/**
 * Write all cfcf context files into the project repo.
 *
 * This is called before each iteration to set up the agent's context.
 * On first iteration, it scaffolds the full cfcf-docs/ directory.
 * On subsequent iterations, it updates the dynamic files.
 */
export async function writeContextToRepo(
  repoPath: string,
  ctx: IterationContext,
): Promise<void> {
  const cfcfDocsDir = join(repoPath, "cfcf-docs");
  await mkdir(cfcfDocsDir, { recursive: true });
  await mkdir(join(cfcfDocsDir, "context"), { recursive: true });
  await mkdir(join(cfcfDocsDir, "iteration-reviews"), { recursive: true });
  await mkdir(join(cfcfDocsDir, "iteration-logs"), { recursive: true });

  // --- Static files (from Problem Pack, written once or updated if changed) ---

  await writeFile(join(cfcfDocsDir, "problem.md"), ctx.problemPack.problem, "utf-8");
  await writeFile(join(cfcfDocsDir, "success.md"), ctx.problemPack.success, "utf-8");

  if (ctx.problemPack.constraints) {
    await writeFile(join(cfcfDocsDir, "constraints.md"), ctx.problemPack.constraints, "utf-8");
  }
  if (ctx.problemPack.hints) {
    await writeFile(join(cfcfDocsDir, "hints.md"), ctx.problemPack.hints, "utf-8");
  }
  if (ctx.problemPack.styleGuide) {
    await writeFile(join(cfcfDocsDir, "style-guide.md"), ctx.problemPack.styleGuide, "utf-8");
  }

  // Copy context files
  for (const ctxFile of ctx.problemPack.context) {
    await writeFile(join(cfcfDocsDir, "context", ctxFile.filename), ctxFile.content, "utf-8");
  }

  // --- Template files (written on first iteration only, agent updates them) ---

  await copyTemplateIfMissing(cfcfDocsDir, "process.md");
  await copyTemplateIfMissing(cfcfDocsDir, "decision-log.md");
  await copyTemplateIfMissing(cfcfDocsDir, "plan.md");

  // Handoff and signal templates are always refreshed (agent fills them in each iteration)
  await copyTemplate(cfcfDocsDir, "iteration-handoff.md");
  await copyTemplate(cfcfDocsDir, "cfcf-iteration-signals.json");

  // --- Dynamic files (cfcf regenerates these each iteration) ---

  // Iteration history
  const historyContent = ctx.iterationHistory || "# Iteration History\n\nNo previous iterations.\n";
  await writeFile(join(cfcfDocsDir, "iteration-history.md"), historyContent, "utf-8");

  // Judge assessment from previous iteration
  const judgeContent = ctx.previousJudgeAssessment ||
    "# Judge Assessment\n\nNo previous judge assessment. This is the first iteration.\n";
  await writeFile(join(cfcfDocsDir, "judge-assessment.md"), judgeContent, "utf-8");

  // User feedback
  const feedbackContent = ctx.userFeedback ||
    "# User Feedback\n\nNo user feedback yet.\n";
  await writeFile(join(cfcfDocsDir, "user-feedback.md"), feedbackContent, "utf-8");
}

/**
 * Generate the CLAUDE.md (or equivalent) instruction file content.
 *
 * This is the Tier 1 context -- inlined in the agent instruction file so it's
 * read immediately. ~500 words of essential context + pointers to Tier 2 and 3.
 */
export function generateInstructionContent(ctx: IterationContext): string {
  const lines: string[] = [];

  lines.push(`# cfcf Iteration ${ctx.iteration} Instructions`);
  lines.push("");
  lines.push(`You are a dev agent working on iteration ${ctx.iteration} of the project "${ctx.project.name}".`);
  lines.push(`Read this file first, then follow the process defined in cfcf-docs/process.md.`);
  lines.push("");

  // Tier 1: Essential context (embedded here)
  lines.push("## Problem Summary");
  lines.push("");
  // Take first 5 lines of problem.md as summary
  const problemLines = ctx.problemPack.problem.split("\n").slice(0, 8);
  lines.push(problemLines.join("\n"));
  lines.push("");
  lines.push("Full problem definition: cfcf-docs/problem.md");
  lines.push("");

  lines.push("## Success Criteria");
  lines.push("");
  const successLines = ctx.problemPack.success.split("\n").slice(0, 8);
  lines.push(successLines.join("\n"));
  lines.push("");
  lines.push("Full success criteria: cfcf-docs/success.md");
  lines.push("");

  // Previous judge feedback (if any)
  if (ctx.previousJudgeAssessment) {
    lines.push("## Previous Judge Feedback");
    lines.push("");
    // Take first 10 lines as summary
    const judgeLines = ctx.previousJudgeAssessment.split("\n").slice(0, 10);
    lines.push(judgeLines.join("\n"));
    lines.push("");
    lines.push("Full assessment: cfcf-docs/judge-assessment.md");
    lines.push("");
  }

  // Iteration directive
  lines.push("## This Iteration");
  lines.push("");
  if (ctx.iteration === 1) {
    lines.push("This is the first iteration. Read all context files, create an initial plan in cfcf-docs/plan.md, and begin implementation.");
  } else {
    lines.push(`This is iteration ${ctx.iteration}. Review the previous iteration's results, update the plan, and continue implementation.`);
    lines.push("Read cfcf-docs/iteration-history.md for what happened in previous iterations.");
  }
  lines.push("");

  // --- Iteration scope discipline (always injected, not just in process.md template) ---
  lines.push("## Iteration Scope -- one phase per iteration");
  lines.push("");
  lines.push("**Each iteration is a separate, clean process.** cfcf spawns a fresh agent invocation per iteration with no session continuity. The next iteration inherits nothing from this one except the files you leave on disk. Plan for that:");
  lines.push("");
  lines.push("1. Read `cfcf-docs/plan.md` first. It is the shared source of truth between iterations.");
  if (ctx.iteration === 1) {
    lines.push("2. If the plan is missing or not mapped to iterations, **map phases to concrete iterations now** (e.g. `## Iteration 1 -- Foundation`, `## Iteration 2 -- Core features`). Pick chunks small enough that one unattended run can complete and test them.");
  } else {
    lines.push("2. If the plan already maps phases to iterations, locate the **next pending iteration** and execute only that chunk. Do not skip ahead. Do not try to finish everything in one run.");
  }
  lines.push("3. Before you exit, update `cfcf-docs/plan.md`:");
  lines.push("   - Mark completed items `[x]` with a brief note of what you actually did (files touched, tests added, deviations).");
  lines.push("   - Leave everything else pending so the next iteration picks up from there.");
  lines.push("   - Add new pending items if you discover work.");
  lines.push("4. This is what makes the judge's per-iteration assessment meaningful and the loop resumable after a pause. Do one chunk well; the next iteration will do the next one.");
  lines.push("");

  // Tier 2 pointers
  lines.push("## Context Files to Read");
  lines.push("");
  lines.push("**Must read (Tier 2):**");
  lines.push("- cfcf-docs/plan.md -- current implementation plan");
  lines.push("- cfcf-docs/iteration-history.md -- compressed previous iteration summaries");
  lines.push("- cfcf-docs/decision-log.md -- past decisions and lessons");
  lines.push("- cfcf-docs/judge-assessment.md -- latest judge feedback");
  lines.push("- cfcf-docs/user-feedback.md -- user direction (if any)");
  lines.push("");
  lines.push("**Reference (Tier 3 -- read if needed):**");
  lines.push("- cfcf-docs/problem.md -- full problem definition");
  lines.push("- cfcf-docs/success.md -- full success criteria");
  if (ctx.problemPack.constraints) lines.push("- cfcf-docs/constraints.md -- guardrails and limitations");
  if (ctx.problemPack.hints) lines.push("- cfcf-docs/hints.md -- technical hints");
  if (ctx.problemPack.styleGuide) lines.push("- cfcf-docs/style-guide.md -- code style guide");
  if (ctx.problemPack.context.length > 0) {
    lines.push("- cfcf-docs/context/ -- additional context files:");
    for (const f of ctx.problemPack.context) {
      lines.push(`  - ${f.filename}`);
    }
  }
  lines.push("");

  // What to produce
  lines.push("## What to Produce");
  lines.push("");
  lines.push("Before exiting, you MUST:");
  lines.push("1. Update cfcf-docs/plan.md with your progress");
  lines.push("2. Append to cfcf-docs/decision-log.md");
  lines.push("3. Fill in cfcf-docs/iteration-handoff.md");
  lines.push("4. Fill in cfcf-docs/cfcf-iteration-signals.json with structured data");
  lines.push("5. Update project docs (docs/architecture.md, docs/api-reference.md, docs/setup-guide.md) -- create if missing");
  lines.push("6. Commit your work frequently with meaningful messages");
  lines.push("");
  lines.push("See cfcf-docs/process.md for the full process definition.");

  return lines.join("\n") + "\n";
}

/**
 * Parse the iteration handoff document after the agent exits.
 * Returns null if the file doesn't exist or is empty.
 */
export async function parseHandoffDocument(
  repoPath: string,
): Promise<string | null> {
  try {
    const content = await readFile(
      join(repoPath, "cfcf-docs", "iteration-handoff.md"),
      "utf-8",
    );
    // Check if it's still the template (not filled in)
    if (content.includes("<!-- What was accomplished")) {
      return null; // Agent didn't fill it in
    }
    return content;
  } catch {
    return null;
  }
}

/**
 * Parse the iteration signal file after the agent exits.
 * Returns null if missing or malformed.
 */
export async function parseSignalFile(
  repoPath: string,
): Promise<DevSignals | null> {
  try {
    const content = await readFile(
      join(repoPath, "cfcf-docs", "cfcf-iteration-signals.json"),
      "utf-8",
    );
    const signals = JSON.parse(content) as DevSignals;
    // Basic validation
    if (!signals.status || !signals.agent) {
      return null; // Template not filled in
    }
    return signals;
  } catch {
    return null; // Missing or malformed
  }
}

/**
 * Generate a compressed summary of an iteration for the history file.
 */
export function generateIterationSummary(
  iteration: number,
  handoff: string | null,
  signals: DevSignals | null,
  exitCode: number,
): string {
  const lines: string[] = [];
  lines.push(`### Iteration ${iteration}`);
  lines.push("");

  if (signals) {
    lines.push(`- Status: ${signals.status}`);
    lines.push(`- Self-assessment: ${signals.self_assessment}`);
    if (signals.tests_run) {
      lines.push(`- Tests: ${signals.tests_passed}/${signals.tests_total} passed, ${signals.tests_failed} failed`);
    }
    if (signals.blockers && signals.blockers.length > 0) {
      lines.push(`- Blockers: ${signals.blockers.join("; ")}`);
    }
  } else {
    lines.push(`- Exit code: ${exitCode}`);
    lines.push(`- Signal file: not filled in or malformed`);
  }

  // Extract summary from handoff if available
  if (handoff) {
    const summaryMatch = handoff.match(/## Summary\n+([\s\S]*?)(?=\n## |\n$)/);
    if (summaryMatch && summaryMatch[1].trim()) {
      lines.push(`- Summary: ${summaryMatch[1].trim().split("\n")[0]}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

// --- Template helpers ---

async function copyTemplate(destDir: string, filename: string): Promise<void> {
  const src = join(TEMPLATES_DIR, filename);
  const dest = join(destDir, filename);
  await copyFile(src, dest);
}

async function copyTemplateIfMissing(destDir: string, filename: string): Promise<void> {
  const dest = join(destDir, filename);
  try {
    await access(dest);
    // File exists, don't overwrite
  } catch {
    await copyTemplate(destDir, filename);
  }
}
