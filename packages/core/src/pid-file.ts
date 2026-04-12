/**
 * PID file management for the cfcf server.
 *
 * Stores the server PID so `cfcf server stop` can reliably find and kill it.
 * PID file lives next to the config: ~/.config/cfcf/server.pid (or platform equivalent).
 */

import { join } from "path";
import { readFile, writeFile, rm } from "fs/promises";
import { getConfigDir } from "./constants.js";

const PID_FILENAME = "server.pid";

function getPidPath(): string {
  return join(getConfigDir(), PID_FILENAME);
}

/**
 * Write the current server PID to the PID file.
 */
export async function writePidFile(pid: number, port: number): Promise<void> {
  const data = JSON.stringify({ pid, port, startedAt: new Date().toISOString() });
  await writeFile(getPidPath(), data, "utf-8");
}

/**
 * Read the PID file. Returns null if not found or invalid.
 */
export async function readPidFile(): Promise<{ pid: number; port: number; startedAt: string } | null> {
  try {
    const raw = await readFile(getPidPath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Remove the PID file.
 */
export async function removePidFile(): Promise<void> {
  try {
    await rm(getPidPath(), { force: true });
  } catch {
    // Ignore errors
  }
}

/**
 * Check if the PID in the file is still a running process.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    // Sending signal 0 checks if the process exists without killing it
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
