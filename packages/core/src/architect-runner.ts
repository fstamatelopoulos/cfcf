/**
 * Solution Architect runner for cfcf.
 *
 * Spawns a Solution Architect agent to review the Problem Pack
 * and produce a readiness assessment + initial implementation plan.
 * User-invoked, advisory, repeatable.
 */

import { join, dirname } from "path";
import { readFile, writeFile, mkdir, copyFile, access } from "fs/promises";
import type { ProjectConfig, ArchitectSignals } from "./types.js";
import { getAdapter } from "./adapters/index.js";
import { spawnProcess } from "./process-manager.js";
import { getIterationLogPath, ensureProjectLogDir } from "./log-storage.js";
import { readProblemPack, validateProblemPack } from "./problem-pack.js";
import { writeContextToRepo, type IterationContext } from "./context-assembler.js";

const TEMPLATES_DIR = join(dirname(new URL(import.meta.url).pathname), "templates");

// --- Review State ---

export interface ReviewState {
  projectId: string;
  projectName: string;
  status: "preparing" | "executing" | "collecting" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  logFile: string;
  signals?: ArchitectSignals;
  error?: string;
}

const reviewStore = new Map<string, ReviewState>();

export function getReviewState(projectId: string): ReviewState | undefined {
  return reviewStore.get(projectId);
}

// --- Core Functions ---

/**
 * Write architect instructions into cfcf-docs/.
 */
export async function writeArchitectInstructions(
  repoPath: string,
  project: ProjectConfig,
): Promise<void> {
  const templatePath = join(TEMPLATES_DIR, "cfcf-architect-instructions.md");
  let template = await readFile(templatePath, "utf-8");

  template = template.replace(/\{\{PROJECT_NAME\}\}/g, project.name);

  const cfcfDocsDir = join(repoPath, "cfcf-docs");
  await mkdir(cfcfDocsDir, { recursive: true });

  await writeFile(
    join(cfcfDocsDir, "cfcf-architect-instructions.md"),
    template,
    "utf-8",
  );
}

/**
 * Reset the architect signal file to the template.
 */
export async function resetArchitectSignals(repoPath: string): Promise<void> {
  const src = join(TEMPLATES_DIR, "cfcf-architect-signals.json");
  const dest = join(repoPath, "cfcf-docs", "cfcf-architect-signals.json");
  await mkdir(join(repoPath, "cfcf-docs"), { recursive: true });
  await copyFile(src, dest);
}

/**
 * Parse the architect signal file after the architect exits.
 */
export async function parseArchitectSignals(
  repoPath: string,
): Promise<ArchitectSignals | null> {
  try {
    const content = await readFile(
      join(repoPath, "cfcf-docs", "cfcf-architect-signals.json"),
      "utf-8",
    );
    const signals = JSON.parse(content) as ArchitectSignals;
    // Basic validation
    if (!signals.readiness) return null;
    // Check it's not the untouched template
    if (signals.gaps.length === 0 && signals.suggestions.length === 0 && signals.risks.length === 0 && !signals.recommended_approach) {
      return null;
    }
    return signals;
  } catch {
    return null;
  }
}

/**
 * Start an architect review for a project.
 * Runs asynchronously -- returns the initial state immediately.
 */
export async function startReview(
  project: ProjectConfig,
  opts?: { problemPackPath?: string },
): Promise<ReviewState> {
  const logFile = getIterationLogPath(project.id, 0, "architect");
  await ensureProjectLogDir(project.id);

  const state: ReviewState = {
    projectId: project.id,
    projectName: project.name,
    status: "preparing",
    startedAt: new Date().toISOString(),
    logFile,
  };

  reviewStore.set(project.id, state);

  // Run in background
  runReview(project, state, opts).catch((err) => {
    state.status = "failed";
    state.error = err instanceof Error ? err.message : String(err);
    state.completedAt = new Date().toISOString();
  });

  return state;
}

/**
 * Execute the architect review.
 */
async function runReview(
  project: ProjectConfig,
  state: ReviewState,
  opts?: { problemPackPath?: string },
): Promise<void> {
  const adapter = getAdapter(project.architectAgent.adapter);
  if (!adapter) {
    throw new Error(`Unknown architect agent adapter: ${project.architectAgent.adapter}`);
  }

  // Validate and read Problem Pack
  const packPath = opts?.problemPackPath || join(project.repoPath, "problem-pack");
  const packValidation = await validateProblemPack(packPath);
  if (!packValidation.valid) {
    throw new Error(
      `Problem Pack invalid: ${packValidation.errors.join(", ")}. Create a problem-pack/ directory with problem.md and success.md.`,
    );
  }
  const problemPack = await readProblemPack(packPath);

  // Write context files (so the architect can read them)
  const ctx: IterationContext = {
    iteration: 0, // Architect runs before any iteration
    problemPack,
    project,
  };
  await writeContextToRepo(project.repoPath, ctx);

  // Write architect-specific instructions
  await writeArchitectInstructions(project.repoPath, project);
  await resetArchitectSignals(project.repoPath);

  // Build and run the architect agent
  state.status = "executing";

  const prompt = `Read cfcf-docs/cfcf-architect-instructions.md and follow the instructions exactly. Review the problem definition, produce cfcf-docs/architect-review.md, cfcf-docs/plan.md, and cfcf-docs/cfcf-architect-signals.json before exiting.`;
  const cmd = adapter.buildCommand(project.repoPath, prompt, project.architectAgent.model);

  const managed = await spawnProcess({
    command: cmd.command,
    args: cmd.args,
    cwd: project.repoPath,
    logFile: state.logFile,
  });

  const result = await managed.result;
  state.exitCode = result.exitCode;

  // Collect results
  state.status = "collecting";
  const signals = await parseArchitectSignals(project.repoPath);
  state.signals = signals ?? undefined;

  state.status = "completed";
  state.completedAt = new Date().toISOString();
}
