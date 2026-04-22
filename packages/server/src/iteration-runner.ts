/**
 * Async iteration runner.
 *
 * Runs iterations in the background. The HTTP endpoint returns immediately
 * with the iteration number, and the CLI polls for status or streams logs via SSE.
 */

import { join } from "path";
import { writeFile } from "fs/promises";
import type { WorkspaceConfig, DevSignals } from "@cfcf/core";
import {
  nextIteration,
  spawnProcess,
  getIterationLogPath,
  ensureWorkspaceLogDir,
  readProblemPack,
  validateProblemPack,
  writeContextToRepo,
  generateInstructionContent,
  parseHandoffDocument,
  parseSignalFile,
  getAdapter,
  type IterationContext,
} from "@cfcf/core";
import * as gitManager from "@cfcf/core";

export interface IterationState {
  iteration: number;
  workspaceId: string;
  workspaceName: string;
  branch: string;
  mode: "manual" | "agent";
  status: "preparing" | "executing" | "collecting" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  durationMs?: number;
  logFile: string;
  committed?: boolean;
  killed?: boolean;
  error?: string;
  handoffReceived?: boolean;
  signalsReceived?: boolean;
  signals?: DevSignals;
  /** Live log lines accumulated during execution */
  logLines: string[];
}

/** In-memory store of active/recent iterations, keyed by "workspaceId:iterationNum" */
const iterationStore = new Map<string, IterationState>();

function storeKey(workspaceId: string, iteration: number): string {
  return `${workspaceId}:${iteration}`;
}

/**
 * Get the state of an iteration.
 */
export function getIterationState(workspaceId: string, iteration: number): IterationState | undefined {
  return iterationStore.get(storeKey(workspaceId, iteration));
}

/**
 * Get the latest iteration state for a workspace.
 */
export function getLatestIterationState(workspaceId: string): IterationState | undefined {
  let latest: IterationState | undefined;
  for (const state of iterationStore.values()) {
    if (state.workspaceId === workspaceId) {
      if (!latest || state.iteration > latest.iteration) {
        latest = state;
      }
    }
  }
  return latest;
}

/**
 * Start an iteration asynchronously.
 * Returns the iteration state immediately (status = "preparing").
 * The actual execution runs in the background.
 */
export async function startIteration(
  workspace: WorkspaceConfig,
  opts: {
    command?: string;
    args?: string[];
    problemPackPath?: string;
  },
): Promise<IterationState> {
  // Get next iteration number
  const iterationNum = await nextIteration(workspace.id);
  if (iterationNum === null) {
    throw new Error("Failed to increment iteration counter");
  }

  // Create feature branch
  const branchName = `cfcf/iteration-${iterationNum}`;
  const branchResult = await gitManager.createBranch(workspace.repoPath, branchName);
  if (!branchResult.success) {
    throw new Error(`Failed to create branch: ${branchResult.error}`);
  }

  // Prepare log path
  const logFile = getIterationLogPath(workspace.id, iterationNum, "dev");
  await ensureWorkspaceLogDir(workspace.id);

  const mode = opts.command ? "manual" : "agent";

  // Create initial state
  const state: IterationState = {
    iteration: iterationNum,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    branch: branchName,
    mode,
    status: "preparing",
    startedAt: new Date().toISOString(),
    logFile,
    logLines: [],
  };

  iterationStore.set(storeKey(workspace.id, iterationNum), state);

  // Run the iteration in the background (don't await)
  runIterationAsync(workspace, state, opts).catch((err) => {
    state.status = "failed";
    state.error = err instanceof Error ? err.message : String(err);
    state.completedAt = new Date().toISOString();
  });

  return state;
}

/**
 * The actual iteration execution -- runs in the background.
 */
async function runIterationAsync(
  workspace: WorkspaceConfig,
  state: IterationState,
  opts: {
    command?: string;
    args?: string[];
    problemPackPath?: string;
  },
): Promise<void> {
  let command: string;
  let args: string[];

  if (opts.command) {
    // Manual mode
    command = opts.command;
    args = opts.args ?? [];
  } else {
    // Agent mode: assemble context
    const adapter = getAdapter(workspace.devAgent.adapter);
    if (!adapter) {
      throw new Error(`Unknown agent adapter: ${workspace.devAgent.adapter}`);
    }

    const packPath = opts.problemPackPath || join(workspace.repoPath, "problem-pack");
    const packValidation = await validateProblemPack(packPath);
    if (!packValidation.valid) {
      throw new Error(
        `Problem Pack invalid: ${packValidation.errors.join(", ")}. Create a problem-pack/ directory with problem.md and success.md.`,
      );
    }

    const problemPack = await readProblemPack(packPath);

    const ctx: IterationContext = {
      iteration: state.iteration,
      problemPack,
      workspace,
    };

    await writeContextToRepo(workspace.repoPath, ctx);

    const instructionContent = generateInstructionContent(ctx);
    await writeFile(
      join(workspace.repoPath, adapter.instructionFilename),
      instructionContent,
      "utf-8",
    );

    const prompt = `Read ${adapter.instructionFilename} and follow the instructions. Execute the iteration plan, then fill in cfcf-docs/iteration-handoff.md and cfcf-docs/cfcf-iteration-signals.json before exiting.`;
    const cmd = adapter.buildCommand(workspace.repoPath, prompt, workspace.devAgent.model);
    command = cmd.command;
    args = cmd.args;
  }

  // Execute
  state.status = "executing";

  const managed = await spawnProcess({
    command,
    args,
    cwd: workspace.repoPath,
    logFile: state.logFile,
  });

  const result = await managed.result;
  state.exitCode = result.exitCode;
  state.durationMs = result.durationMs;
  state.killed = result.killed;

  // Collect results
  state.status = "collecting";

  if (state.mode === "agent") {
    state.handoffReceived = (await parseHandoffDocument(workspace.repoPath)) !== null;
    const signals = await parseSignalFile(workspace.repoPath);
    state.signalsReceived = signals !== null;
    state.signals = signals ?? undefined;
  }

  // Commit
  if (await gitManager.hasChanges(workspace.repoPath)) {
    const commitResult = await gitManager.commitAll(
      workspace.repoPath,
      `cfcf iteration ${state.iteration}${state.mode === "agent" ? ` (${workspace.devAgent.adapter})` : ""}: ${command} ${args.slice(0, 3).join(" ")}`,
    );
    state.committed = commitResult.success;
  } else {
    state.committed = false;
  }

  // Read log lines for SSE consumers
  try {
    const logContent = await Bun.file(state.logFile).text();
    state.logLines = logContent.split("\n").filter((l) => l.length > 0);
  } catch {
    // Log file might be empty
  }

  state.status = "completed";
  state.completedAt = new Date().toISOString();
}
