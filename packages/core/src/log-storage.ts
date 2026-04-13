/**
 * Log storage for cfcf.
 *
 * Agent stdout/stderr logs are stored outside the repo (too large) under:
 *   ~/.cfcf/logs/<project-id>/iteration-NNN-<role>.log
 */

import { join } from "path";
import { mkdir, readFile, readdir } from "fs/promises";
import { getLogsDir } from "./constants.js";

/**
 * Get the log directory for a project.
 */
export function getProjectLogDir(projectId: string): string {
  return join(getLogsDir(), projectId);
}

/**
 * Get the log file path for a specific iteration + role.
 */
export function getIterationLogPath(
  projectId: string,
  iteration: number,
  role: "dev" | "judge" | "architect",
): string {
  const iterStr = String(iteration).padStart(3, "0");
  return join(getProjectLogDir(projectId), `iteration-${iterStr}-${role}.log`);
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
 * Read a log file. Returns null if not found.
 */
export async function readLog(
  projectId: string,
  iteration: number,
  role: "dev" | "judge" | "architect",
): Promise<string | null> {
  try {
    const path = getIterationLogPath(projectId, iteration, role);
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
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
