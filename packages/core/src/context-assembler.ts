/**
 * Context assembler for cfcf.
 *
 * Assembles the full context for an iteration: reads the Problem Pack,
 * merges with iteration history, judge feedback, user feedback,
 * and writes everything into the workspace repo as cfcf-docs/ + CLAUDE.md.
 */

import { join } from "path";
import { mkdir, writeFile, readFile, readdir } from "fs/promises";
import type { ProblemPack } from "./problem-pack.js";
import type { WorkspaceConfig, DevSignals } from "./types.js";
import { writeTemplate, writeTemplateIfMissing } from "./templates.js";

// Templates are now resolved via `getTemplate()` from templates.ts (embedded
// at build time with optional per-repo / per-user filesystem overrides).

/**
 * Banner prepended to every `cfcf-docs/` file that is a generated copy
 * of a user-authored source file (Problem Pack). Makes it explicit that
 * the file in `cfcf-docs/` is NOT the source of truth -- editing there
 * is clobbered on the next run. Uses an HTML comment so it renders
 * invisibly in markdown viewers while still being visible in editors.
 */
export function generatedBanner(sourcePath: string): string {
  return (
    `<!--\n` +
    `  cfcf: this file is generated from ${sourcePath} and is overwritten\n` +
    `  on every run (pre-loop review, iteration, or architect review).\n` +
    `  DO NOT EDIT HERE -- your changes will be lost. Edit the source at\n` +
    `  ${sourcePath} instead.\n` +
    `-->\n`
  );
}

/**
 * Prepend the generated-copy banner to user-authored content. Idempotent:
 * if the content already starts with a banner pointing at the same source
 * (e.g. the caller re-ran and the Problem Pack source was already a
 * banner-wrapped file for some reason), we don't stack banners.
 */
export function withGeneratedBanner(sourcePath: string, content: string): string {
  const banner = generatedBanner(sourcePath);
  // Avoid stacking -- if the content already leads with THIS banner,
  // don't double-prepend. (Normal case: source content is plain user
  // markdown; banner is added fresh every time.)
  if (content.startsWith(banner)) return content;
  return banner + content;
}

export interface IterationContext {
  /** Current iteration number */
  iteration: number;
  /** The problem pack contents */
  problemPack: ProblemPack;
  /** Workspace configuration */
  workspace: WorkspaceConfig;
  /** Previous iteration's judge assessment (if any) */
  previousJudgeAssessment?: string;
  /** User feedback (if any) */
  userFeedback?: string;
  /** Compressed iteration history */
  iterationHistory?: string;
}

/**
 * Write all cfcf context files into the workspace repo.
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

  // --- Static files (from Problem Pack, regenerated every run) ---
  //
  // Each file under `cfcf-docs/` that mirrors a Problem Pack file gets a
  // `<!-- cfcf: generated ... -->` banner prepended so the user knows
  // this is a *copy* and editing it here will be clobbered on the next
  // run. The source of truth is under `<repo>/problem-pack/`. See
  // `docs/guides/workflow.md` ("Files you edit vs. files cfcf generates").

  await writeFile(
    join(cfcfDocsDir, "problem.md"),
    withGeneratedBanner("problem-pack/problem.md", ctx.problemPack.problem),
    "utf-8",
  );
  await writeFile(
    join(cfcfDocsDir, "success.md"),
    withGeneratedBanner("problem-pack/success.md", ctx.problemPack.success),
    "utf-8",
  );

  if (ctx.problemPack.constraints) {
    await writeFile(
      join(cfcfDocsDir, "constraints.md"),
      withGeneratedBanner("problem-pack/constraints.md", ctx.problemPack.constraints),
      "utf-8",
    );
  }
  if (ctx.problemPack.hints) {
    await writeFile(
      join(cfcfDocsDir, "hints.md"),
      withGeneratedBanner("problem-pack/hints.md", ctx.problemPack.hints),
      "utf-8",
    );
  }
  if (ctx.problemPack.styleGuide) {
    await writeFile(
      join(cfcfDocsDir, "style-guide.md"),
      withGeneratedBanner("problem-pack/style-guide.md", ctx.problemPack.styleGuide),
      "utf-8",
    );
  }

  // Copy context files
  for (const ctxFile of ctx.problemPack.context) {
    await writeFile(
      join(cfcfDocsDir, "context", ctxFile.filename),
      withGeneratedBanner(`problem-pack/context/${ctxFile.filename}`, ctxFile.content),
      "utf-8",
    );
  }

  // --- Template files (written on first iteration only, agent updates them) ---

  const tplOpts = { repoPath };
  await writeTemplateIfMissing(cfcfDocsDir, "process.md", tplOpts);
  await writeTemplateIfMissing(cfcfDocsDir, "decision-log.md", tplOpts);
  await writeTemplateIfMissing(cfcfDocsDir, "plan.md", tplOpts);

  // iteration-handoff.md: fresh template only when missing (v0.7.6 change).
  // Previous iteration's handoff is preserved as context for the next
  // iteration's dev agent. Dev agents are instructed to READ it for
  // context, then REPLACE with their own iteration's handoff before
  // exiting. We also archive the committed handoff per iteration to
  // `cfcf-docs/iteration-handoffs/iteration-N.md` via `archiveHandoff()`
  // in judge-runner.ts (called post-dev-commit).
  await writeTemplateIfMissing(cfcfDocsDir, "iteration-handoff.md", tplOpts);
  // Signals file still always reset -- it's machine-written by the agent
  // every iteration with no cross-iteration carry-over expected.
  await writeTemplate(cfcfDocsDir, "cfcf-iteration-signals.json", tplOpts);

  // Clio agent cue card (item 5.7 PR3). Refreshed every iteration so
  // any template edit (new artifact types, new CLI verbs) propagates
  // without waiting for a workspace re-init. `clio-relevant.md` is
  // generated by the loop's prepare phase after writeContextToRepo
  // (when Clio has hits to show). We don't create the relevant file
  // here -- leaving it empty is a valid state for a fresh workspace.
  await writeTemplate(cfcfDocsDir, "clio-guide.md", tplOpts);

  // --- Dynamic files (cfcf regenerates these each iteration) ---

  // Iteration history is rebuilt from the committed iteration-log files
  // each iteration. Those files live in cfcf-docs/iteration-logs/ and are
  // written by the dev agent at the end of each iteration (item 5.6 PR 1).
  // If no iteration-log files exist yet (fresh project, iteration 1, or
  // a pre-5.6 project that never wrote them), we fall back to the caller-
  // supplied `ctx.iterationHistory` for backwards compatibility.
  const rebuilt = await rebuildIterationHistoryFromLogs(repoPath);
  const historyContent =
    rebuilt ??
    ctx.iterationHistory ??
    "# Iteration History\n\nNo previous iterations.\n";
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
  lines.push(`You are a dev agent working on iteration ${ctx.iteration} of the workspace "${ctx.workspace.name}".`);
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
  lines.push("- cfcf-docs/iteration-logs/ -- curated per-iteration changelogs (more detail than history)");
  lines.push("- cfcf-docs/iteration-handoffs/ -- archived forward-looking notes from each previous iteration's dev agent");
  lines.push("- cfcf-docs/iteration-handoff.md -- the LIVE handoff file; on a brownfield loop this starts with the previous iteration's handoff as starting context. You will REPLACE it with your own handoff before exiting (do not append)");
  lines.push("- cfcf-docs/decision-log.md -- tagged decisions and lessons from all roles (read the tail)");
  lines.push("- cfcf-docs/judge-assessment.md -- latest judge feedback");
  lines.push("- cfcf-docs/user-feedback.md -- user direction (if any)");
  lines.push("- cfcf-docs/clio-guide.md -- how to query cross-workspace memory via `cfcf clio search` (item 5.7)");
  lines.push("- cfcf-docs/clio-relevant.md -- per-iteration top-k Clio hits matched against this workspace's problem.md (auto-generated; may be missing on fresh workspaces or when no hits exist yet)");
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
  lines.push(`2. Write cfcf-docs/iteration-logs/iteration-${ctx.iteration}.md (backward-looking changelog of this iteration -- see process.md "Iteration Log Format")`);
  lines.push("3. Append tagged entries to cfcf-docs/decision-log.md when you make non-obvious decisions or learn lessons (format: `## <ISO-UTC>  [role: dev]  [iter: N]  [category: decision|lesson]`)");
  lines.push("4. REPLACE cfcf-docs/iteration-handoff.md with YOUR iteration's handoff (forward-looking: what's next, open questions, blockers). On a brownfield loop it starts with the previous iteration's content; read it for context, then overwrite with your own. cfcf will archive the committed version to cfcf-docs/iteration-handoffs/iteration-N.md automatically.");
  lines.push("5. Fill in cfcf-docs/cfcf-iteration-signals.json with structured data");
  lines.push("6. Update workspace docs (docs/architecture.md, docs/api-reference.md, docs/setup-guide.md) -- create if missing");
  lines.push("7. Commit your work frequently with meaningful messages");
  lines.push("");
  lines.push("See cfcf-docs/process.md for the full process definition.");

  return lines.join("\n") + "\n";
}

/**
 * Rebuild `iteration-history.md` content from the per-iteration log files
 * under `cfcf-docs/iteration-logs/`.
 *
 * Each `iteration-N.md` is a small, curated changelog written by the dev
 * agent at the end of iteration N (see process.md "Iteration Log Format").
 * We extract the `## Summary` body of each and concatenate newest-first.
 *
 * Returns `null` when no iteration-log files are found (fresh project or
 * pre-5.6 project). In that case the caller falls back to the legacy
 * in-memory history content.
 */
export async function rebuildIterationHistoryFromLogs(
  repoPath: string,
): Promise<string | null> {
  const logsDir = join(repoPath, "cfcf-docs", "iteration-logs");
  let entries: string[];
  try {
    entries = await readdir(logsDir);
  } catch {
    return null;
  }

  const logFiles: { iter: number; file: string }[] = [];
  for (const name of entries) {
    const m = /^iteration-(\d+)\.md$/.exec(name);
    if (!m) continue;
    logFiles.push({ iter: parseInt(m[1], 10), file: name });
  }
  if (logFiles.length === 0) return null;

  // Newest first
  logFiles.sort((a, b) => b.iter - a.iter);

  const lines: string[] = ["# Iteration History", ""];
  for (const { iter, file } of logFiles) {
    const content = await readFile(join(logsDir, file), "utf-8");
    const title = extractTitle(content) ?? "";
    const summary = extractSummary(content) ?? "(no summary section)";
    lines.push(`## Iteration ${iter}${title ? ` -- ${title}` : ""}`);
    lines.push("");
    lines.push(summary.trim());
    lines.push("");
    lines.push(`[full log: cfcf-docs/iteration-logs/${file}]`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Rebuild `cfcf-docs/iteration-history.md` from the per-iteration log
 * files on disk and write the result. Best-effort wrapper around
 * `rebuildIterationHistoryFromLogs` + `writeFile` — silently no-ops
 * when the rebuild returns null (no log files yet, e.g. fresh project).
 *
 * Use this anywhere you want history.md to reflect the current state
 * of `cfcf-docs/iteration-logs/`. Called at the START of each
 * iteration via `writeContextToRepo`, AND at the END of each
 * iteration's dev phase (after the dev agent writes iteration-N.md
 * to disk) so the final iteration of a loop is included — without
 * this end-of-phase refresh, history.md is permanently one
 * iteration behind whenever the loop terminates (the start-of-next-
 * iteration rebuild never fires for the final iteration).
 *
 * Bug-fix for the off-by-one in iter-history rebuild placement
 * surfaced by dogfood on the calc workspace: iter 4 completed +
 * iteration-4.md was on disk, but iteration-history.md still
 * stopped at iter 3.
 */
export async function refreshIterationHistory(repoPath: string): Promise<void> {
  const rebuilt = await rebuildIterationHistoryFromLogs(repoPath);
  if (rebuilt === null) return;
  const dest = join(repoPath, "cfcf-docs", "iteration-history.md");
  await writeFile(dest, rebuilt, "utf-8");
}

/**
 * Extract the short title from an iteration-log's `# Iteration N -- Title`
 * first heading. Returns null if the heading is missing or malformed.
 */
function extractTitle(content: string): string | null {
  const m = /^#\s*Iteration\s+\d+\s*(?:--|\u2014|-)\s*(.+)$/m.exec(content);
  if (!m) return null;
  return m[1].trim();
}

/**
 * Extract the body of the `## Summary` section (up to the next level-2
 * heading). Returns null if absent.
 */
function extractSummary(content: string): string | null {
  const m = /^##\s+Summary\s*\n+([\s\S]*?)(?=\n##\s|\n#\s|$)/m.exec(content);
  if (!m) return null;
  // Strip HTML/MD comments commonly used as placeholder hints.
  const body = m[1].replace(/<!--[\s\S]*?-->/g, "").trim();
  return body.length > 0 ? body : null;
}

// --- Instruction file merge (sentinel-based) ------------------------------
//
// cfcf regenerates the dev agent's instruction file (CLAUDE.md / AGENTS.md /
// adapter-equivalent) every iteration. The first-run problem: if the user
// already has a hand-curated CLAUDE.md in the repo -- their own notes,
// skills, team conventions -- the old unconditional `writeFile` call
// nuked it. This helper fixes that by carving out a cfcf-owned section
// via sentinel markers:
//
//   <!-- cfcf:begin -->
//   # cfcf Iteration N Instructions
//   ...generated each iteration...
//   <!-- cfcf:end -->
//
//   # User's own content
//   ...preserved forever, cfcf never touches...
//
// Rules:
//   - First run, file doesn't exist:
//       write `<BEGIN>\n<cfcf content>\n<END>\n` by itself.
//   - First run, file exists *without* markers:
//       prepend `<BEGIN>\n<cfcf content>\n<END>\n\n` + original content.
//   - Subsequent runs, file exists *with* markers:
//       replace only the content between the markers; leave everything
//       outside untouched.
//   - Subsequent runs, markers somehow missing (user removed them):
//       fall back to the "prepend" branch again -- re-inserts the
//       sentinel section at the top without touching the rest.

export const CFCF_INSTRUCTION_BEGIN = "<!-- cfcf:begin -->";
export const CFCF_INSTRUCTION_END = "<!-- cfcf:end -->";

/**
 * Build the sentinel-wrapped block for a given cfcf-generated body.
 * Exported so tests and tooling can inspect the exact bytes we write.
 */
export function wrapCfcfInstructionBlock(body: string): string {
  const trimmed = body.endsWith("\n") ? body : body + "\n";
  return `${CFCF_INSTRUCTION_BEGIN}\n${trimmed}${CFCF_INSTRUCTION_END}\n`;
}

/**
 * Pure function: given the existing file contents (or null if absent)
 * and the new cfcf-generated body, return the next file contents.
 * Separated from the I/O so it can be unit-tested.
 */
export function mergeInstructionFile(
  existing: string | null,
  cfcfBody: string,
): string {
  const block = wrapCfcfInstructionBlock(cfcfBody);

  if (existing === null) {
    // File doesn't exist: write just the cfcf block.
    return block;
  }

  const beginIdx = existing.indexOf(CFCF_INSTRUCTION_BEGIN);
  const endIdx = existing.indexOf(CFCF_INSTRUCTION_END);
  const hasMarkers = beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx;

  if (hasMarkers) {
    // Replace content between markers (inclusive of both). Preserve
    // everything before the begin marker and everything after the end
    // marker line. We include the end marker line's trailing newline in
    // the "after" segment when present so the user's content layout is
    // preserved byte-for-byte.
    const before = existing.slice(0, beginIdx);
    const afterStart = endIdx + CFCF_INSTRUCTION_END.length;
    // If the end marker is followed by a newline, consume one so we don't
    // double up when re-inserting our block (which ends in "\n").
    const after = existing[afterStart] === "\n"
      ? existing.slice(afterStart + 1)
      : existing.slice(afterStart);
    return before + block + after;
  }

  // Markers missing: prepend our block, keep original content below.
  // Ensure a blank line separates the sentinel block from the user's
  // content.
  const sep = existing.startsWith("\n") ? "" : "\n";
  return block + sep + existing;
}

/**
 * Write the dev agent's instruction file (`CLAUDE.md`, `AGENTS.md`, etc.)
 * into the repo root, preserving any user-authored content outside the
 * `<!-- cfcf:begin --> ... <!-- cfcf:end -->` sentinel block. See the
 * comment above `mergeInstructionFile` for the rules.
 */
export async function writeInstructionFile(
  repoPath: string,
  filename: string,
  cfcfBody: string,
): Promise<void> {
  const dest = join(repoPath, filename);
  let existing: string | null;
  try {
    existing = await readFile(dest, "utf-8");
  } catch {
    existing = null;
  }
  const merged = mergeInstructionFile(existing, cfcfBody);
  await writeFile(dest, merged, "utf-8");
}

/**
 * Archive the current iteration-handoff.md to
 * `cfcf-docs/iteration-handoffs/iteration-N.md` so the full per-iteration
 * handoff history is queryable without git archaeology. Same pattern as
 * `archiveJudgeAssessment` (iteration-reviews/) and
 * `archiveReflectionAnalysis` (reflection-reviews/). Called from the
 * iteration loop right after the dev agent commits. (item 5.x polish,
 * v0.7.6)
 *
 * Returns true on success, false if the source file doesn't exist
 * (shouldn't happen in normal flow but defensive).
 */
export async function archiveHandoff(
  repoPath: string,
  iteration: number,
): Promise<boolean> {
  const { copyFile, access } = await import("fs/promises");
  const src = join(repoPath, "cfcf-docs", "iteration-handoff.md");
  const archiveDir = join(repoPath, "cfcf-docs", "iteration-handoffs");
  const dest = join(archiveDir, `iteration-${iteration}.md`);
  try {
    await access(src);
    await mkdir(archiveDir, { recursive: true });
    await copyFile(src, dest);
    return true;
  } catch {
    return false;
  }
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

// Template helpers now live in `./templates.ts` (getTemplate / writeTemplate /
// writeTemplateIfMissing). Call those directly.
