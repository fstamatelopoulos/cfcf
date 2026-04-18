/**
 * Judge runner for cfcf.
 *
 * Spawns a judge agent after the dev agent completes an iteration.
 * The judge evaluates the dev's work and produces an assessment + signal file.
 * cfcf reads the signal file to make deterministic loop decisions.
 */

import { join } from "path";
import { readFile, writeFile, mkdir, access, copyFile } from "fs/promises";
import type { ProjectConfig, JudgeSignals } from "./types.js";
import { getAdapter } from "./adapters/index.js";
import { getTemplate, writeTemplate } from "./templates.js";

/**
 * Generate judge instructions for a specific iteration.
 * Writes cfcf-judge-instructions.md into cfcf-docs/.
 */
export async function writeJudgeInstructions(
  repoPath: string,
  project: ProjectConfig,
  iteration: number,
): Promise<void> {
  let template = await getTemplate("cfcf-judge-instructions.md", { repoPath });
  template = template.replace(/\{\{ITERATION\}\}/g, String(iteration));
  template = template.replace(/\{\{PROJECT_NAME\}\}/g, project.name);

  const destPath = join(repoPath, "cfcf-docs", "cfcf-judge-instructions.md");
  await writeFile(destPath, template, "utf-8");
}

/**
 * Reset the judge signal file to the template (empty/default values).
 */
export async function resetJudgeSignals(
  repoPath: string,
): Promise<void> {
  await writeTemplate(
    join(repoPath, "cfcf-docs"),
    "cfcf-judge-signals.json",
    { repoPath },
  );
}

/**
 * Build the command to run the judge agent.
 */
export function buildJudgeCommand(
  project: ProjectConfig,
): { command: string; args: string[] } | null {
  const adapter = getAdapter(project.judgeAgent.adapter);
  if (!adapter) return null;

  const prompt = `Read cfcf-docs/cfcf-judge-instructions.md and follow the instructions exactly. Evaluate the dev agent's iteration work, then write cfcf-docs/judge-assessment.md and cfcf-docs/cfcf-judge-signals.json before exiting.`;
  return adapter.buildCommand("", prompt, project.judgeAgent.model);
}

/**
 * Parse the judge signal file after the judge exits.
 * Returns null if missing or malformed.
 */
export async function parseJudgeSignals(
  repoPath: string,
): Promise<JudgeSignals | null> {
  try {
    const content = await readFile(
      join(repoPath, "cfcf-docs", "cfcf-judge-signals.json"),
      "utf-8",
    );
    const signals = JSON.parse(content) as JudgeSignals;
    // Basic validation: check that the determination is filled in and not the template default
    if (!signals.determination) {
      return null;
    }
    // Check it's not the untouched template (iteration 0 is the template default)
    if (signals.iteration === 0 && signals.quality_score === 5) {
      return null;
    }
    return signals;
  } catch {
    return null;
  }
}

/**
 * Parse the judge assessment markdown document.
 * Returns null if the file doesn't exist or is essentially the template.
 */
export async function parseJudgeAssessment(
  repoPath: string,
): Promise<string | null> {
  try {
    const content = await readFile(
      join(repoPath, "cfcf-docs", "judge-assessment.md"),
      "utf-8",
    );
    // Check if it's a meaningful assessment (has content beyond template)
    if (content.trim().length < 50) {
      return null;
    }
    return content;
  } catch {
    return null;
  }
}

/**
 * Archive the current judge assessment to iteration-reviews/iteration-N.md.
 * This preserves the full history of judge feedback.
 */
export async function archiveJudgeAssessment(
  repoPath: string,
  iteration: number,
): Promise<boolean> {
  const src = join(repoPath, "cfcf-docs", "judge-assessment.md");
  const reviewsDir = join(repoPath, "cfcf-docs", "iteration-reviews");
  const dest = join(reviewsDir, `iteration-${iteration}.md`);

  try {
    await access(src);
    await mkdir(reviewsDir, { recursive: true });
    await copyFile(src, dest);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract a compressed summary from the judge assessment for iteration history.
 */
export function summarizeJudgeAssessment(
  judgeSignals: JudgeSignals | null,
  judgeAssessment: string | null,
): string {
  if (!judgeSignals) {
    return "Judge assessment: not received or malformed.";
  }

  const parts: string[] = [];
  parts.push(`Judge: ${judgeSignals.determination}`);
  parts.push(`Quality: ${judgeSignals.quality_score}/10`);

  if (judgeSignals.tests_verified && judgeSignals.tests_total) {
    parts.push(`Tests: ${judgeSignals.tests_passed}/${judgeSignals.tests_total}`);
  }
  if (judgeSignals.key_concern) {
    parts.push(`Concern: ${judgeSignals.key_concern}`);
  }

  // Extract summary paragraph from assessment if available
  if (judgeAssessment) {
    const summaryMatch = judgeAssessment.match(/## Summary\n+([\s\S]*?)(?=\n## |\n*$)/);
    if (summaryMatch && summaryMatch[1].trim()) {
      parts.push(`Summary: ${summaryMatch[1].trim().split("\n")[0]}`);
    }
  }

  return parts.join(". ");
}
