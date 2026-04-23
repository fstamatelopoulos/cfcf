/**
 * Lazy singleton for the active Clio MemoryBackend.
 *
 * One backend instance per cf² server process, shared by the HTTP layer,
 * the CLI surface, and the iteration loop's auto-ingest hooks. Tests
 * inject an isolated backend via `setClioBackend()`.
 */

import { existsSync } from "fs";
import { LocalClio } from "./backend/local-clio.js";
import type { MemoryBackend } from "./backend/types.js";

let backend: MemoryBackend | null = null;

/**
 * Get (and lazily construct) the active Clio backend for this process.
 *
 * PR1: always a `LocalClio`. PR2+ will branch on a future
 * `CfcfGlobalConfig.memoryBackend` to swap in a `CerefoxRemote` adapter.
 *
 * **Self-heal on missing DB file:** if the currently-cached backend's
 * underlying SQLite file has been deleted out from under us (common in
 * testing flows -- user nukes `~/.cfcf/clio.db` between runs), the
 * stale handle is closed and a fresh `LocalClio` is constructed so the
 * next operation opens a new DB + re-runs migrations. Without this,
 * queries against the deleted file throw opaque errors inside the
 * route handlers and the CLI sees non-JSON responses.
 */
export function getClioBackend(): MemoryBackend {
  if (backend instanceof LocalClio) {
    const path = backend.getDbPath();
    // Only reset when we're sure the file is gone. "(memory)" means an
    // ephemeral DB (test fixture); nothing to check. A real path that
    // no longer exists triggers a reset.
    if (path && path !== "(memory)" && !existsSync(path)) {
      try { backend.closeSync(); } catch { /* ignore */ }
      backend = null;
    }
  }
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
