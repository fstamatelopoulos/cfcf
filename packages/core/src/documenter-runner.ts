/**
 * Documenter runner for cfcf.
 *
 * Spawns a Documenter agent to produce polished final project documentation.
 * Runs automatically after judge says SUCCESS, or on demand via `cfcf document`.
 */

import { join, dirname } from "path";
import { readFile, writeFile, mkdir } from "fs/promises";
import { randomBytes } from "crypto";
import type { ProjectConfig } from "./types.js";
import { getAdapter } from "./adapters/index.js";
import { spawnProcess } from "./process-manager.js";
import { getAgentRunLogPath, nextAgentRunSequence, ensureProjectLogDir } from "./log-storage.js";
import { appendHistoryEvent, updateHistoryEvent } from "./project-history.js";

const TEMPLATES_DIR = join(dirname(new URL(import.meta.url).pathname), "templates");

// --- Document State ---

export interface DocumentState {
  projectId: string;
  projectName: string;
  status: "preparing" | "executing" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  /** Absolute path to the log file */
  logFile: string;
  /** Log file name only */
  logFileName: string;
  /** Sequence number */
  sequence: number;
  /** History event ID */
  historyEventId: string;
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
  await ensureProjectLogDir(project.id);
  const sequence = await nextAgentRunSequence(project.id, "documenter");
  const logFile = getAgentRunLogPath(project.id, "documenter", sequence);
  const logFileName = `documenter-${String(sequence).padStart(3, "0")}.log`;

  const historyEventId = randomBytes(8).toString("hex");
  const startedAt = new Date().toISOString();

  // Record the history event immediately
  await appendHistoryEvent(project.id, {
    id: historyEventId,
    type: "document",
    status: "running",
    startedAt,
    logFile: logFileName,
    agent: project.documenterAgent.adapter,
    model: project.documenterAgent.model,
  });

  const state: DocumentState = {
    projectId: project.id,
    projectName: project.name,
    status: "preparing",
    startedAt,
    logFile,
    logFileName,
    sequence,
    historyEventId,
  };

  documentStore.set(project.id, state);

  // Run in background
  runDocument(project, state).catch(async (err) => {
    state.status = "failed";
    state.error = err instanceof Error ? err.message : String(err);
    state.completedAt = new Date().toISOString();
    await updateHistoryEvent(project.id, historyEventId, {
      status: "failed",
      error: state.error,
      completedAt: state.completedAt,
    });
  });

  return state;
}

/**
 * Run the documenter agent synchronously (used by the loop post-SUCCESS).
 * Allocates its own sequence number and writes a history event.
 * Returns the exit code and log file info.
 */
export async function runDocumentSync(
  project: ProjectConfig,
): Promise<{ exitCode: number; logFile: string; logFileName: string; sequence: number }> {
  await ensureProjectLogDir(project.id);
  const sequence = await nextAgentRunSequence(project.id, "documenter");
  const logFile = getAgentRunLogPath(project.id, "documenter", sequence);
  const logFileName = `documenter-${String(sequence).padStart(3, "0")}.log`;

  const adapter = getAdapter(project.documenterAgent.adapter);
  if (!adapter) {
    throw new Error(`Unknown documenter agent adapter: ${project.documenterAgent.adapter}`);
  }

  // Record history event
  const historyEventId = randomBytes(8).toString("hex");
  const startedAt = new Date().toISOString();
  await appendHistoryEvent(project.id, {
    id: historyEventId,
    type: "document",
    status: "running",
    startedAt,
    logFile: logFileName,
    agent: project.documenterAgent.adapter,
    model: project.documenterAgent.model,
  });

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

  // Finalize history event
  await updateHistoryEvent(project.id, historyEventId, {
    status: result.exitCode === 0 ? "completed" : "failed",
    completedAt: new Date().toISOString(),
  });

  return { exitCode: result.exitCode, logFile, logFileName, sequence };
}

/**
 * Execute the documenter (async version for CLI).
 */
async function runDocument(
  project: ProjectConfig,
  state: DocumentState,
): Promise<void> {
  state.status = "executing";

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
    logFile: state.logFile,
  });

  const result = await managed.result;
  state.exitCode = result.exitCode;

  state.status = "completed";
  state.completedAt = new Date().toISOString();

  await updateHistoryEvent(project.id, state.historyEventId, {
    status: result.exitCode === 0 ? "completed" : "failed",
    completedAt: state.completedAt,
  });
}
