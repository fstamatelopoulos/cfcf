/**
 * Lazy singleton for the active Clio MemoryBackend.
 *
 * One backend instance per cf² server process, shared by the HTTP layer,
 * the CLI surface, and the iteration loop's auto-ingest hooks. Tests
 * inject an isolated backend via `setClioBackend()`.
 */

import { LocalClio } from "./backend/local-clio.js";
import type { MemoryBackend } from "./backend/types.js";

let backend: MemoryBackend | null = null;

/**
 * Get (and lazily construct) the active Clio backend for this process.
 *
 * PR1: always a `LocalClio`. PR2+ will branch on a future
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
 * from the server's graceful-shutdown path.
 */
export async function closeClioBackend(): Promise<void> {
  if (backend) {
    try { await backend.close(); } catch { /* best-effort */ }
    backend = null;
  }
}
