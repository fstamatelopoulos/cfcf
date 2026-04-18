/**
 * Documenter runner for cfcf.
 *
 * Spawns a Documenter agent to produce polished final project documentation.
 * Runs automatically after judge says SUCCESS, or on demand via `cfcf document`.
 */

import { join, dirname } from "path";
import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { randomBytes } from "crypto";
import type { ProjectConfig } from "./types.js";
import { getAdapter } from "./adapters/index.js";
import { spawnProcess, type ManagedProcess } from "./process-manager.js";
import { getAgentRunLogPath, nextAgentRunSequence, ensureProjectLogDir } from "./log-storage.js";
import { appendHistoryEvent, updateHistoryEvent } from "./project-history.js";
import { registerProcess } from "./active-processes.js";

/**
 * Count markdown files in the project's docs/ directory.
 * Returns 0 if the directory doesn't exist.
 */
async function countDocsFiles(repoPath: string): Promise<number> {
  try {
    const entries = await readdir(join(repoPath, "docs"));
    return entries.filter((e) => e.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

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
const documentProcessStore = new Map<string, ManagedProcess>();

export function getDocumentState(projectId: string): DocumentState | undefined {
  return documentStore.get(projectId);
}

/**
 * Stop a running documenter for a project. Kills the process and updates state.
 * Only works for user-invoked document runs (not the in-loop documenter).
 */
export async function stopDocument(projectId: string): Promise<DocumentState | null> {
  const state = documentStore.get(projectId);
  if (!state) return null;
  if (!["preparing", "executing"].includes(state.status)) {
    return state;
  }

  const proc = documentProcessStore.get(projectId);
  if (proc) {
    proc.kill();
    documentProcessStore.delete(projectId);
  }

  state.status = "failed";
  state.error = "Stopped by user";
  state.completedAt = new Date().toISOString();

  await updateHistoryEvent(projectId, state.historyEventId, {
    status: "failed",
    error: "Stopped by user",
    completedAt: state.completedAt,
  });

  return state;
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

  // Run in background. Error handler is itself wrapped in try/catch so that
  // a failure to record the error (disk write, etc.) doesn't silently swallow it.
  runDocument(project, state).catch(async (err) => {
    try {
      state.status = "failed";
      state.error = err instanceof Error ? err.message : String(err);
      state.completedAt = new Date().toISOString();
      await updateHistoryEvent(project.id, historyEventId, {
        status: "failed",
        error: state.error,
        completedAt: state.completedAt,
      });
    } catch (handlerErr) {
      console.error(`[documenter-runner] Failed to record error for ${project.id}:`, handlerErr);
      console.error(`  Original error:`, err);
    }
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
): Promise<{ exitCode: number; logFile: string; logFileName: string; sequence: number; historyEventId: string }> {
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
  const unregister = registerProcess({
    projectId: project.id,
    role: "documenter",
    process: managed,
    startedAt,
    historyEventId,
    logFileName,
  });

  try {
    const result = await managed.result;
    const docsFileCount = await countDocsFiles(project.repoPath);

    // Finalize history event. `committed` is updated separately by iteration-loop
    // after it commits (if there were changes).
    await updateHistoryEvent(project.id, historyEventId, {
      status: result.exitCode === 0 ? "completed" : "failed",
      completedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      docsFileCount,
    } as Partial<import("./project-history.js").DocumentHistoryEvent>);

    return { exitCode: result.exitCode, logFile, logFileName, sequence, historyEventId };
  } finally {
    unregister();
  }
}

/**
 * Execute the documenter (async version for CLI / web).
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
  documentProcessStore.set(project.id, managed);
  const unregister = registerProcess({
    projectId: project.id,
    role: "documenter",
    process: managed,
    startedAt: state.startedAt,
    historyEventId: state.historyEventId,
    logFileName: state.logFileName,
  });

  try {
    const result = await managed.result;
    state.exitCode = result.exitCode;

    if ((state.status as string) === "failed") return; // externally stopped

    state.status = "completed";
    state.completedAt = new Date().toISOString();

    const docsFileCount = await countDocsFiles(project.repoPath);

    await updateHistoryEvent(project.id, state.historyEventId, {
      status: result.exitCode === 0 ? "completed" : "failed",
      completedAt: state.completedAt,
      exitCode: result.exitCode,
      docsFileCount,
      committed: false, // standalone document runs don't auto-commit
    } as Partial<import("./project-history.js").DocumentHistoryEvent>);
  } finally {
    documentProcessStore.delete(project.id);
    unregister();
  }
}
