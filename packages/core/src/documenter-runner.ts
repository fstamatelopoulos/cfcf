/**
 * Documenter runner for cfcf.
 *
 * Spawns a Documenter agent to produce polished final workspace documentation.
 * Runs automatically after judge says SUCCESS, or on demand via `cfcf document`.
 */

import { join } from "path";
import { writeFile, mkdir, readdir } from "fs/promises";
import { randomBytes } from "crypto";
import type { WorkspaceConfig } from "./types.js";
import { getAdapter } from "./adapters/index.js";
import { spawnProcess, type ManagedProcess } from "./process-manager.js";
import { getAgentRunLogPath, nextAgentRunSequence, ensureWorkspaceLogDir } from "./log-storage.js";
import { appendHistoryEvent, updateHistoryEvent } from "./workspace-history.js";
import { registerProcess } from "./active-processes.js";
import { dispatchForWorkspace, makeEvent } from "./notifications/index.js";
import { getTemplate } from "./templates.js";

/**
 * Count markdown files in the workspace's docs/ directory.
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

// Templates resolved via templates.ts (embedded + overrides).

// --- Document State ---

export interface DocumentState {
  workspaceId: string;
  workspaceName: string;
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

export function getDocumentState(workspaceId: string): DocumentState | undefined {
  return documentStore.get(workspaceId);
}

/**
 * Stop a running documenter for a workspace. Kills the process and updates state.
 * Only works for user-invoked document runs (not the in-loop documenter).
 */
export async function stopDocument(workspaceId: string): Promise<DocumentState | null> {
  const state = documentStore.get(workspaceId);
  if (!state) return null;
  if (!["preparing", "executing"].includes(state.status)) {
    return state;
  }

  const proc = documentProcessStore.get(workspaceId);
  if (proc) {
    proc.kill();
    documentProcessStore.delete(workspaceId);
  }

  state.status = "failed";
  state.error = "Stopped by user";
  state.completedAt = new Date().toISOString();

  await updateHistoryEvent(workspaceId, state.historyEventId, {
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
  workspace: WorkspaceConfig,
): Promise<void> {
  let template = await getTemplate("cfcf-documenter-instructions.md", { repoPath });
  template = template.replace(/\{\{WORKSPACE_NAME\}\}/g, workspace.name);

  const cfcfDocsDir = join(repoPath, "cfcf-docs");
  await mkdir(cfcfDocsDir, { recursive: true });

  await writeFile(
    join(cfcfDocsDir, "cfcf-documenter-instructions.md"),
    template,
    "utf-8",
  );
}

/**
 * Start a documenter run for a workspace.
 * Runs asynchronously -- returns the initial state immediately.
 */
export async function startDocument(
  workspace: WorkspaceConfig,
): Promise<DocumentState> {
  await ensureWorkspaceLogDir(workspace.id);
  const sequence = await nextAgentRunSequence(workspace.id, "documenter");
  const logFile = getAgentRunLogPath(workspace.id, "documenter", sequence);
  const logFileName = `documenter-${String(sequence).padStart(3, "0")}.log`;

  const historyEventId = randomBytes(8).toString("hex");
  const startedAt = new Date().toISOString();

  // Record the history event immediately
  await appendHistoryEvent(workspace.id, {
    id: historyEventId,
    type: "document",
    status: "running",
    startedAt,
    logFile: logFileName,
    agent: workspace.documenterAgent.adapter,
    model: workspace.documenterAgent.model,
  });

  const state: DocumentState = {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    status: "preparing",
    startedAt,
    logFile,
    logFileName,
    sequence,
    historyEventId,
  };

  documentStore.set(workspace.id, state);

  // Run in background. Error handler is itself wrapped in try/catch so that
  // a failure to record the error (disk write, etc.) doesn't silently swallow it.
  runDocument(workspace, state).catch(async (err) => {
    try {
      state.status = "failed";
      state.error = err instanceof Error ? err.message : String(err);
      state.completedAt = new Date().toISOString();
      await updateHistoryEvent(workspace.id, historyEventId, {
        status: "failed",
        error: state.error,
        completedAt: state.completedAt,
      });
      dispatchForWorkspace(
        makeEvent({
          type: "agent.failed",
          title: "Documenter failed",
          message: `${workspace.name}: ${state.error}`,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          details: { role: "documenter", error: state.error },
        }),
        workspace.notifications,
      );
    } catch (handlerErr) {
      console.error(`[documenter-runner] Failed to record error for ${workspace.id}:`, handlerErr);
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
  workspace: WorkspaceConfig,
): Promise<{ exitCode: number; logFile: string; logFileName: string; sequence: number; historyEventId: string }> {
  await ensureWorkspaceLogDir(workspace.id);
  const sequence = await nextAgentRunSequence(workspace.id, "documenter");
  const logFile = getAgentRunLogPath(workspace.id, "documenter", sequence);
  const logFileName = `documenter-${String(sequence).padStart(3, "0")}.log`;

  const adapter = getAdapter(workspace.documenterAgent.adapter);
  if (!adapter) {
    throw new Error(`Unknown documenter agent adapter: ${workspace.documenterAgent.adapter}`);
  }

  // Record history event
  const historyEventId = randomBytes(8).toString("hex");
  const startedAt = new Date().toISOString();
  await appendHistoryEvent(workspace.id, {
    id: historyEventId,
    type: "document",
    status: "running",
    startedAt,
    logFile: logFileName,
    agent: workspace.documenterAgent.adapter,
    model: workspace.documenterAgent.model,
  });

  await writeDocumenterInstructions(workspace.repoPath, workspace);

  const prompt = `Read cfcf-docs/cfcf-documenter-instructions.md and follow the instructions exactly. Produce comprehensive workspace documentation in the docs/ directory before exiting.`;
  const cmd = adapter.buildCommand(workspace.repoPath, prompt, workspace.documenterAgent.model);

  const managed = await spawnProcess({
    command: cmd.command,
    args: cmd.args,
    cwd: workspace.repoPath,
    logFile,
  });
  const unregister = registerProcess({
    workspaceId: workspace.id,
    role: "documenter",
    process: managed,
    startedAt,
    historyEventId,
    logFileName,
  });

  try {
    const result = await managed.result;
    const docsFileCount = await countDocsFiles(workspace.repoPath);

    // Finalize history event. `committed` is updated separately by iteration-loop
    // after it commits (if there were changes).
    await updateHistoryEvent(workspace.id, historyEventId, {
      status: result.exitCode === 0 ? "completed" : "failed",
      completedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      docsFileCount,
    } as Partial<import("./workspace-history.js").DocumentHistoryEvent>);

    return { exitCode: result.exitCode, logFile, logFileName, sequence, historyEventId };
  } finally {
    unregister();
  }
}

/**
 * Execute the documenter (async version for CLI / web).
 */
async function runDocument(
  workspace: WorkspaceConfig,
  state: DocumentState,
): Promise<void> {
  state.status = "executing";

  const adapter = getAdapter(workspace.documenterAgent.adapter);
  if (!adapter) {
    throw new Error(`Unknown documenter agent adapter: ${workspace.documenterAgent.adapter}`);
  }

  await writeDocumenterInstructions(workspace.repoPath, workspace);

  const prompt = `Read cfcf-docs/cfcf-documenter-instructions.md and follow the instructions exactly. Produce comprehensive workspace documentation in the docs/ directory before exiting.`;
  const cmd = adapter.buildCommand(workspace.repoPath, prompt, workspace.documenterAgent.model);

  const managed = await spawnProcess({
    command: cmd.command,
    args: cmd.args,
    cwd: workspace.repoPath,
    logFile: state.logFile,
  });
  documentProcessStore.set(workspace.id, managed);
  const unregister = registerProcess({
    workspaceId: workspace.id,
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

    const docsFileCount = await countDocsFiles(workspace.repoPath);

    await updateHistoryEvent(workspace.id, state.historyEventId, {
      status: result.exitCode === 0 ? "completed" : "failed",
      completedAt: state.completedAt,
      exitCode: result.exitCode,
      docsFileCount,
      committed: false, // standalone document runs don't auto-commit
    } as Partial<import("./workspace-history.js").DocumentHistoryEvent>);
  } finally {
    documentProcessStore.delete(workspace.id);
    unregister();
  }
}
