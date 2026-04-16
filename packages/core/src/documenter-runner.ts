/**
 * Documenter runner for cfcf.
 *
 * Spawns a Documenter agent to produce polished final project documentation.
 * Runs automatically after judge says SUCCESS, or on demand via `cfcf document`.
 */

import { join, dirname } from "path";
import { readFile, writeFile, mkdir } from "fs/promises";
import type { ProjectConfig } from "./types.js";
import { getAdapter } from "./adapters/index.js";
import { spawnProcess } from "./process-manager.js";
import { getIterationLogPath, ensureProjectLogDir } from "./log-storage.js";

const TEMPLATES_DIR = join(dirname(new URL(import.meta.url).pathname), "templates");

// --- Document State ---

export interface DocumentState {
  projectId: string;
  projectName: string;
  status: "preparing" | "executing" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  logFile: string;
  error?: string;
}

const documentStore = new Map<string, DocumentState>();

export function getDocumentState(projectId: string): DocumentState | undefined {
  return documentStore.get(projectId);
}

// --- Core Functions ---

/**
 * Write documenter instructions into cfcf-docs/.
 */
export async function writeDocumenterInstructions(
  repoPath: string,
  project: ProjectConfig,
): Promise<void> {
  const templatePath = join(TEMPLATES_DIR, "cfcf-documenter-instructions.md");
  let template = await readFile(templatePath, "utf-8");

  template = template.replace(/\{\{PROJECT_NAME\}\}/g, project.name);

  const cfcfDocsDir = join(repoPath, "cfcf-docs");
  await mkdir(cfcfDocsDir, { recursive: true });

  await writeFile(
    join(cfcfDocsDir, "cfcf-documenter-instructions.md"),
    template,
    "utf-8",
  );
}

/**
 * Start a documenter run for a project.
 * Runs asynchronously -- returns the initial state immediately.
 */
export async function startDocument(
  project: ProjectConfig,
): Promise<DocumentState> {
  const logFile = getIterationLogPath(project.id, 0, "documenter");
  await ensureProjectLogDir(project.id);

  const state: DocumentState = {
    projectId: project.id,
    projectName: project.name,
    status: "preparing",
    startedAt: new Date().toISOString(),
    logFile,
  };

  documentStore.set(project.id, state);

  // Run in background
  runDocument(project, state).catch((err) => {
    state.status = "failed";
    state.error = err instanceof Error ? err.message : String(err);
    state.completedAt = new Date().toISOString();
  });

  return state;
}

/**
 * Run the documenter agent synchronously (used by the loop post-SUCCESS).
 * Returns the exit code.
 */
export async function runDocumentSync(
  project: ProjectConfig,
): Promise<{ exitCode: number; logFile: string }> {
  const logFile = getIterationLogPath(project.id, 0, "documenter");
  await ensureProjectLogDir(project.id);

  const adapter = getAdapter(project.documenterAgent.adapter);
  if (!adapter) {
    throw new Error(`Unknown documenter agent adapter: ${project.documenterAgent.adapter}`);
  }

  await writeDocumenterInstructions(project.repoPath, project);

  const prompt = `Read cfcf-docs/cfcf-documenter-instructions.md and follow the instructions exactly. Produce comprehensive project documentation in the docs/ directory before exiting.`;
  const cmd = adapter.buildCommand(project.repoPath, prompt, project.documenterAgent.model);

  const managed = await spawnProcess({
    command: cmd.command,
    args: cmd.args,
    cwd: project.repoPath,
    logFile,
  });

  const result = await managed.result;
  return { exitCode: result.exitCode, logFile };
}

/**
 * Execute the documenter (async version for CLI).
 */
async function runDocument(
  project: ProjectConfig,
  state: DocumentState,
): Promise<void> {
  state.status = "executing";

  const result = await runDocumentSync(project);
  state.exitCode = result.exitCode;

  state.status = "completed";
  state.completedAt = new Date().toISOString();
}
