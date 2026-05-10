/**
 * Disk-backed state store for non-loop runners (Review, Document, Reflect).
 * Item F.23, v0.24.0.
 *
 * Pre-v0.24 the three runners' state lived only in module-level
 * `Map<workspaceId, State>`s. A server restart wiped them: the running
 * agent processes (which are detached) might survive but the harness
 * had no way to know they existed; the web UI's "review running" /
 * "document running" / "reflect running" indicators vanished
 * mid-flight; future calls to `getXxxState` returned undefined even
 * when there was a meaningful prior result on disk to surface.
 *
 * v0.24 adds a sibling `<state>-state.json` file for each runner under
 * `~/.cfcf/workspaces/<id>/`, mirroring the existing `loop-state.json`
 * pattern. The store still uses an in-memory cache for hot reads, with
 * a disk fallback on cache miss + a write-through on every mutation.
 *
 * Boot behaviour: `cleanupStaleAgentStates(filename, activeStatuses,
 * reason)` walks all workspaces' state files at server start and flips
 * any still-active state to `failed`. This is the standalone-agent
 * counterpart to `cleanupStaleActiveLoops` for loops + serves the same
 * purpose: a fresh server boot should never present a stale "running"
 * state to the user. Per-workspace history events are cleaned by the
 * existing `cleanupStaleRunningEvents` pass; the per-runner state
 * files are this pass.
 */

import { join } from "path";
import { readFile, writeFile, mkdir } from "fs/promises";
import { getWorkspaceDir } from "./workspaces.js";

/** Minimum shape every persisted agent state must satisfy. */
export interface PersistableAgentState {
  workspaceId: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

/**
 * Persist an agent state object to its per-workspace state file.
 * Caller is responsible for keeping their in-memory cache in sync —
 * this is intentionally a low-level write, not a state manager.
 *
 * Filename is relative to the workspace dir. Conventional names:
 *   - `review-state.json`   (architect-runner)
 *   - `document-state.json` (documenter-runner)
 *   - `reflect-state.json`  (reflection-runner)
 */
export async function persistAgentState<T extends PersistableAgentState>(
  filename: string,
  state: T,
): Promise<void> {
  const dir = getWorkspaceDir(state.workspaceId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, filename);
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/**
 * Load a persisted agent state from disk. Returns null when no file
 * exists or the file is malformed (the caller continues without
 * crashing — disk is best-effort here).
 */
export async function loadAgentState<T extends PersistableAgentState>(
  filename: string,
  workspaceId: string,
): Promise<T | null> {
  try {
    const path = join(getWorkspaceDir(workspaceId), filename);
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Boot-time pass: for each workspace, load the state file at
 * `filename`. If the persisted `status` is in `activeStatuses` (the
 * agent was running when the prior server died), flip it to `"failed"`
 * with the supplied reason + a `completedAt` timestamp so the UI shows
 * the right thing on the very first refresh after a restart.
 *
 * Returns the count of states cleaned. Mirrors `cleanupStaleActiveLoops`
 * in shape + intent.
 */
export async function cleanupStaleAgentStates(
  filename: string,
  activeStatuses: Set<string>,
  reason: string,
): Promise<number> {
  const { listWorkspaces } = await import("./workspaces.js");
  const workspaces = await listWorkspaces();
  let total = 0;
  for (const w of workspaces) {
    const state = await loadAgentState(filename, w.id);
    if (!state) continue;
    if (activeStatuses.has(state.status)) {
      state.status = "failed";
      state.error = reason;
      state.completedAt = new Date().toISOString();
      await persistAgentState(filename, state);
      total++;
    }
  }
  return total;
}
