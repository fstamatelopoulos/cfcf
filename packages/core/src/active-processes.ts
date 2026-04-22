/**
 * Central registry of all active agent processes.
 *
 * Every spawned agent (dev, judge, architect, documenter) registers itself
 * here with a key that identifies the workspace and role. On graceful shutdown,
 * the server iterates over the registry and kills everything.
 *
 * This replaces the per-runner process maps (reviewProcessStore,
 * documentProcessStore, and the loop's implicit process references). Runners
 * still register there for convenience, but this global registry is what
 * the shutdown handler and the stop endpoints consult.
 */

import type { ManagedProcess } from "./process-manager.js";
import type { AgentRole } from "./log-storage.js";

export interface ActiveProcessEntry {
  workspaceId: string;
  role: AgentRole;
  process: ManagedProcess;
  /** ISO timestamp when the process was registered */
  startedAt: string;
  /** History event ID to update if the process is killed */
  historyEventId?: string;
  /** Log file name (for debugging) */
  logFileName?: string;
}

/** Key format: `${workspaceId}:${role}` */
function makeKey(workspaceId: string, role: AgentRole): string {
  return `${workspaceId}:${role}`;
}

const registry = new Map<string, ActiveProcessEntry>();

/**
 * Register an active agent process. Returns a cleanup function.
 */
export function registerProcess(entry: ActiveProcessEntry): () => void {
  const key = makeKey(entry.workspaceId, entry.role);
  registry.set(key, entry);
  return () => {
    // Only unregister if the same process is still registered (not replaced)
    if (registry.get(key)?.process === entry.process) {
      registry.delete(key);
    }
  };
}

/**
 * Get an active process entry by workspace + role.
 */
export function getActiveProcess(
  workspaceId: string,
  role: AgentRole,
): ActiveProcessEntry | undefined {
  return registry.get(makeKey(workspaceId, role));
}

/**
 * Get all active processes for a given workspace.
 */
export function getActiveProcessesForWorkspace(workspaceId: string): ActiveProcessEntry[] {
  const out: ActiveProcessEntry[] = [];
  for (const entry of registry.values()) {
    if (entry.workspaceId === workspaceId) out.push(entry);
  }
  return out;
}

/**
 * Get all active processes (across all workspaces).
 */
export function getAllActiveProcesses(): ActiveProcessEntry[] {
  return Array.from(registry.values());
}

/**
 * Kill all active processes for a specific workspace.
 */
export function killWorkspaceProcesses(workspaceId: string): number {
  let killed = 0;
  for (const entry of getActiveProcessesForWorkspace(workspaceId)) {
    try {
      entry.process.kill();
      killed++;
    } catch {
      // Process may already be dead
    }
    registry.delete(makeKey(entry.workspaceId, entry.role));
  }
  return killed;
}

/**
 * Kill all active processes (used on server shutdown).
 */
export function killAllActiveProcesses(): number {
  let killed = 0;
  for (const entry of registry.values()) {
    try {
      entry.process.kill();
      killed++;
    } catch {
      // Process may already be dead
    }
  }
  registry.clear();
  return killed;
}

/**
 * Clear the registry without killing anything. Used when tests need a clean slate.
 */
export function clearRegistry(): void {
  registry.clear();
}
