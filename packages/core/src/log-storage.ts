/**
 * Log storage for cfcf.
 *
 * Agent stdout/stderr logs are stored outside the repo (too large) under:
 *   ~/.cfcf/logs/<project-id>/<run-id>/iteration-NNN-<role>.log
 */

import { join } from "path";
import { mkdir, readFile, readdir } from "fs/promises";
import { getLogsDir } from "./constants.js";

/**
 * Get the log directory for a specific run.
 */
export function getRunLogDir(projectId: string, runId: string): string {
  return join(getLogsDir(), projectId, runId);
}

/**
 * Get the log file path for a specific iteration + role.
 */
export function getIterationLogPath(
  projectId: string,
  runId: string,
  iteration: number,
  role: "dev" | "judge",
): string {
  const iterStr = String(iteration).padStart(3, "0");
  return join(getRunLogDir(projectId, runId), `iteration-${iterStr}-${role}.log`);
}

/**
 * Ensure the log directory exists for a run.
 */
export async function ensureRunLogDir(projectId: string, runId: string): Promise<string> {
  const dir = getRunLogDir(projectId, runId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Read a log file. Returns null if not found.
 */
export async function readLog(
  projectId: string,
  runId: string,
  iteration: number,
  role: "dev" | "judge",
): Promise<string | null> {
  try {
    const path = getIterationLogPath(projectId, runId, iteration, role);
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * List all log files for a run.
 */
export async function listRunLogs(
  projectId: string,
  runId: string,
): Promise<string[]> {
  try {
    const dir = getRunLogDir(projectId, runId);
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith(".log")).sort();
  } catch {
    return [];
  }
}
