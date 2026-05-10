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
import { persistAgentState, loadAgentState } from "./agent-state-store.js";
import { registerProcess } from "./active-processes.js";
import { dispatchForWorkspace, makeEvent } from "./notifications/index.js";
import { getTemplate } from "./templates.js";
import { effectiveClioProject } from "./clio/system-projects.js";
import { formatClioActor } from "./clio/actor.js";

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

/**
 * Disk-backed store filename + active-status set (item F.23, v0.24).
 * Same shape as `architect-runner`'s persistence layer; see
 * agent-state-store.ts for the broader rationale.
 */
const DOCUMENT_STATE_FILE = "document-state.json";
const DOCUMENT_ACTIVE_STATUSES = new Set(["preparing", "executing"]);

async function setDocumentState(state: DocumentState): Promise<void> {
  documentStore.set(state.workspaceId, state);
  try {
    await persistAgentState(DOCUMENT_STATE_FILE, state);
  } catch (err) {
    console.warn(
      `[documenter-runner] persistAgentState failed for ${state.workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function getDocumentState(workspaceId: string): DocumentState | undefined {
  return documentStore.get(workspaceId);
}

/**
 * Server-boot hook (item F.23): hydrate the in-memory cache from disk
 * and clean up any state still claiming to be active. Returns the
 * count cleaned.
 */
export async function hydrateDocumentStateStore(
  staleReason: string = "Server restarted while document run was active",
): Promise<number> {
  const { listWorkspaces } = await import("./workspaces.js");
  const workspaces = await listWorkspaces();
  let cleaned = 0;
  for (const w of workspaces) {
    const state = await loadAgentState<DocumentState>(DOCUMENT_STATE_FILE, w.id);
    if (!state) continue;
    if (DOCUMENT_ACTIVE_STATUSES.has(state.status)) {
      state.status = "failed";
      state.error = staleReason;
      state.completedAt = new Date().toISOString();
      await persistAgentState(DOCUMENT_STATE_FILE, state).catch(() => {});
      cleaned++;
    }
    documentStore.set(w.id, state);
  }
  return cleaned;
}

/**
 * Stop a running documenter for a workspace. Kills the process and updates state.
 * Only works for user-invoked document runs (not the in-loop documenter).
 */
export async function stopDocument(workspaceId: string): Promise<DocumentState | null> {
  const state = documentStore.get(workspaceId);
  if (!state) return null;
  if (!DOCUMENT_ACTIVE_STATUSES.has(state.status)) {
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
  await setDocumentState(state);

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
  // Item 6.9: real effective Clio Project in the agent's CLI examples.
  template = template.replace(
    /\{\{WORKSPACE_CLIO_PROJECT\}\}/g,
    effectiveClioProject(workspace),
  );

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

  await setDocumentState(state);

  // Run in background. Error handler is itself wrapped in try/catch so that
  // a failure to record the error (disk write, etc.) doesn't silently swallow it.
  runDocument(workspace, state).catch(async (err) => {
    try {
      state.status = "failed";
      state.error = err instanceof Error ? err.message : String(err);
      state.completedAt = new Date().toISOString();
      await setDocumentState(state);
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
 *
 * `opts.userFeedback` (item 6.25): when the loop is finished via the
 * `finish_loop` resume action, the user's free-text framing is appended
 * to the documenter's prompt so the agent can emphasise the right things
 * in the final docs. Optional; absent during routine post-SUCCESS runs.
 */
export async function runDocumentSync(
  workspace: WorkspaceConfig,
  opts?: { userFeedback?: string },
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

  const basePrompt = `Read cfcf-docs/cfcf-documenter-instructions.md and follow the instructions exactly. Produce comprehensive workspace documentation in the docs/ directory before exiting.`;
  const userFeedbackBlock = opts?.userFeedback?.trim()
    ? `\n\nAdditional user direction (provided when finishing the loop): ${opts.userFeedback.trim()}\n\nUse this guidance to inform what to emphasise in the documentation.`
    : "";
  const prompt = basePrompt + userFeedbackBlock;
  const cmd = adapter.buildCommand(workspace.repoPath, prompt, workspace.documenterAgent.model);

  const managed = await spawnProcess({
    command: cmd.command,
    args: cmd.args,
    cwd: workspace.repoPath,
    logFile,
    env: {
      CFCF_ACCESS_PATH: "agent-cli",
      CFCF_ACTOR: formatClioActor("documenter", workspace.documenterAgent.adapter, workspace.documenterAgent.model),
    },
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
  await setDocumentState(state);

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
    env: {
      CFCF_ACCESS_PATH: "agent-cli",
      CFCF_ACTOR: formatClioActor("documenter", workspace.documenterAgent.adapter, workspace.documenterAgent.model),
    },
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
    await setDocumentState(state);

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
