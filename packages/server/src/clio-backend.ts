/**
 * Lazy singleton holder for the Clio MemoryBackend.
 *
 * One `LocalClio` instance per server process (opens clio.db on first
 * access, stays open for the lifetime of the server). Tests can inject
 * a different backend via `setClioBackend()`.
 */

import { LocalClio, type MemoryBackend } from "@cfcf/core";

let backend: MemoryBackend | null = null;

/**
 * Get (and lazily construct) the active Clio backend for this process.
 *
 * PR1: always a `LocalClio`. PR2+ will branch on
 * `CfcfGlobalConfig.memoryBackend` to swap in a `CerefoxRemote` adapter.
 */
export function getClioBackend(): MemoryBackend {
  if (!backend) {
    backend = new LocalClio();
  }
  return backend;
}

/**
 * Replace the active backend. Used by tests to inject an isolated
 * backend pointing at a temp DB. Callers are responsible for closing
 * the previously-active backend if any.
 */
export function setClioBackend(next: MemoryBackend | null): void {
  backend = next;
}

/**
 * Close the active backend (if any) and clear the singleton. Called
 * from the graceful-shutdown path.
 */
export async function closeClioBackend(): Promise<void> {
  if (backend) {
    try { await backend.close(); } catch { /* best-effort */ }
    backend = null;
  }
}
