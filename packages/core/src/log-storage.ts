/**
 * Log storage for cfcf.
 *
 * Agent stdout/stderr logs are stored outside the repo (too large) under:
 *   ~/.cfcf/logs/<project-id>/
 *
 * Naming conventions:
 *   - Dev/judge logs:      iteration-NNN-dev.log, iteration-NNN-judge.log
 *   - Architect runs:      architect-NNN.log     (sequence-numbered per project)
 *   - Documenter runs:     documenter-NNN.log    (sequence-numbered per project)
 *
 * Each architect/documenter invocation gets a new sequence number so history
 * is preserved across re-runs.
 */

import { join } from "path";
import { mkdir, readFile, readdir } from "fs/promises";
import { getLogsDir } from "./constants.js";

export type AgentRole = "dev" | "judge" | "architect" | "documenter";

/**
 * Get the log directory for a project.
 */
export function getProjectLogDir(projectId: string): string {
  return join(getLogsDir(), projectId);
}

/**
 * Get the log file path for a dev or judge invocation within an iteration.
 */
export function getIterationLogPath(
  projectId: string,
  iteration: number,
  role: "dev" | "judge",
): string {
  const iterStr = String(iteration).padStart(3, "0");
  return join(getProjectLogDir(projectId), `iteration-${iterStr}-${role}.log`);
}

/**
 * Get the log file path for an architect or documenter invocation.
 * Each invocation gets its own sequence number.
 */
export function getAgentRunLogPath(
  projectId: string,
  role: "architect" | "documenter",
  sequence: number,
): string {
  const seqStr = String(sequence).padStart(3, "0");
  return join(getProjectLogDir(projectId), `${role}-${seqStr}.log`);
}

/**
 * Find the next available sequence number for architect or documenter logs.
 * Scans the project log directory and returns max existing + 1 (or 1 if none exist).
 */
export async function nextAgentRunSequence(
  projectId: string,
  role: "architect" | "documenter",
): Promise<number> {
  try {
    const dir = getProjectLogDir(projectId);
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
 * Ensure the log directory exists for a project.
 */
export async function ensureProjectLogDir(projectId: string): Promise<string> {
  const dir = getProjectLogDir(projectId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Read a log file by its filename (not absolute path).
 * Returns null if not found or if the filename is unsafe.
 */
export async function readLogByFilename(
  projectId: string,
  filename: string,
): Promise<string | null> {
  // Safety: disallow path traversal
  if (filename.includes("/") || filename.includes("..") || !filename.endsWith(".log")) {
    return null;
  }
  try {
    const path = join(getProjectLogDir(projectId), filename);
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
  projectId: string,
  filename: string,
): string | null {
  if (filename.includes("/") || filename.includes("..") || !filename.endsWith(".log")) {
    return null;
  }
  return join(getProjectLogDir(projectId), filename);
}

/**
 * List all log files for a project.
 */
export async function listProjectLogs(
  projectId: string,
): Promise<string[]> {
  try {
    const dir = getProjectLogDir(projectId);
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith(".log")).sort();
  } catch {
    return [];
  }
}
