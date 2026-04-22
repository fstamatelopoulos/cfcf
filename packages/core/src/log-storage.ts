/**
 * Log storage for cfcf.
 *
 * Agent stdout/stderr logs are stored outside the repo (too large) under:
 *   ~/.cfcf/logs/<workspace-id>/
 *
 * Naming conventions:
 *   - Dev/judge logs:      iteration-NNN-dev.log, iteration-NNN-judge.log
 *   - Architect runs:      architect-NNN.log     (sequence-numbered per workspace)
 *   - Documenter runs:     documenter-NNN.log    (sequence-numbered per workspace)
 *
 * Each architect/documenter invocation gets a new sequence number so history
 * is preserved across re-runs.
 */

import { join } from "path";
import { mkdir, readFile, readdir } from "fs/promises";
import { getLogsDir } from "./constants.js";

export type AgentRole = "dev" | "judge" | "architect" | "documenter" | "reflection";

/**
 * Get the log directory for a workspace.
 */
export function getWorkspaceLogDir(workspaceId: string): string {
  return join(getLogsDir(), workspaceId);
}

/**
 * Get the log file path for a dev or judge invocation within an iteration.
 */
export function getIterationLogPath(
  workspaceId: string,
  iteration: number,
  role: "dev" | "judge",
): string {
  const iterStr = String(iteration).padStart(3, "0");
  return join(getWorkspaceLogDir(workspaceId), `iteration-${iterStr}-${role}.log`);
}

/**
 * Get the log file path for an architect or documenter invocation.
 * Each invocation gets its own sequence number.
 */
export function getAgentRunLogPath(
  workspaceId: string,
  role: "architect" | "documenter" | "reflection",
  sequence: number,
): string {
  const seqStr = String(sequence).padStart(3, "0");
  return join(getWorkspaceLogDir(workspaceId), `${role}-${seqStr}.log`);
}

/**
 * Find the next available sequence number for architect or documenter logs.
 * Scans the workspace log directory and returns max existing + 1 (or 1 if none exist).
 */
export async function nextAgentRunSequence(
  workspaceId: string,
  role: "architect" | "documenter" | "reflection",
): Promise<number> {
  try {
    const dir = getWorkspaceLogDir(workspaceId);
    const entries = await readdir(dir);
    const prefix = `${role}-`;
    let max = 0;
    for (const entry of entries) {
      if (!entry.startsWith(prefix) || !entry.endsWith(".log")) continue;
      const numStr = entry.slice(prefix.length, -".log".length);
      const n = parseInt(numStr, 10);
      if (!isNaN(n) && n > max) max = n;
    }
    return max + 1;
  } catch {
    return 1;
  }
}

/**
 * Ensure the log directory exists for a workspace.
 */
export async function ensureWorkspaceLogDir(workspaceId: string): Promise<string> {
  const dir = getWorkspaceLogDir(workspaceId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Read a log file by its filename (not absolute path).
 * Returns null if not found or if the filename is unsafe.
 */
export async function readLogByFilename(
  workspaceId: string,
  filename: string,
): Promise<string | null> {
  // Safety: disallow path traversal
  if (filename.includes("/") || filename.includes("..") || !filename.endsWith(".log")) {
    return null;
  }
  try {
    const path = join(getWorkspaceLogDir(workspaceId), filename);
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Get the absolute path for a log filename (with safety check).
 * Returns null if the filename is unsafe.
 */
export function getLogPathByFilename(
  workspaceId: string,
  filename: string,
): string | null {
  if (filename.includes("/") || filename.includes("..") || !filename.endsWith(".log")) {
    return null;
  }
  return join(getWorkspaceLogDir(workspaceId), filename);
}

/**
 * List all log files for a workspace.
 */
export async function listWorkspaceLogs(
  workspaceId: string,
): Promise<string[]> {
  try {
    const dir = getWorkspaceLogDir(workspaceId);
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith(".log")).sort();
  } catch {
    return [];
  }
}
