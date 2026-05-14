/**
 * Workspace management for cfcf.
 *
 * Workspaces are stored under ~/.cfcf/workspaces/<workspace-id>/config.json.
 * Each workspace links to a local git repo and has its own agent/iteration config.
 */

import { join } from "path";
import { mkdir, readFile, writeFile, readdir, access, rm } from "fs/promises";
import { getConfigDir, DEFAULT_MAX_ITERATIONS, DEFAULT_PAUSE_EVERY } from "./constants.js";
import { readConfig } from "./config.js";
import type { WorkspaceConfig } from "./types.js";
import { randomBytes } from "crypto";

/**
 * Get the workspaces root directory.
 */
export function getWorkspacesDir(): string {
  return join(getConfigDir(), "workspaces");
}

/**
 * Get the directory for a specific workspace.
 */
export function getWorkspaceDir(workspaceId: string): string {
  return join(getWorkspacesDir(), workspaceId);
}

/**
 * Generate a short unique workspace ID from the name.
 */
function generateWorkspaceId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  const suffix = randomBytes(3).toString("hex");
  return `${slug}-${suffix}`;
}

/**
 * Create a new workspace.
 */
export async function createWorkspace(opts: {
  name: string;
  repoPath: string;
  devAgent?: { adapter: string; model?: string };
  judgeAgent?: { adapter: string; model?: string };
  architectAgent?: { adapter: string; model?: string };
  documenterAgent?: { adapter: string; model?: string };
  maxIterations?: number;
  pauseEvery?: number;
  /**
   * Clio Project assignment (item 5.7). When set, stored on the workspace
   * config and used to route cf²-auto ingests + scope search queries.
   * Undefined → auto-route to the "default" Clio Project on first ingest.
   */
  clioProject?: string;
}): Promise<WorkspaceConfig> {
  // Load global config for defaults
  const globalConfig = await readConfig();

  const id = generateWorkspaceId(opts.name);
  // Per-workspace Clio Project (item 6.9): if the user didn't pass an
  // explicit `clioProject`, default to `cf-workspace-<id>` so each
  // workspace gets its own per-workspace memory bucket. Old default
  // (undefined → fallback to `cf-system-default`) is gone for new
  // workspaces; existing ones with `clioProject` unset stay on the
  // shared default bucket until the user changes it manually.
  const resolvedClioProject = opts.clioProject ?? `cf-workspace-${id}`;
  const config: WorkspaceConfig = {
    id,
    name: opts.name,
    repoPath: opts.repoPath,
    devAgent: opts.devAgent ?? globalConfig?.devAgent ?? { adapter: "claude-code" },
    judgeAgent: opts.judgeAgent ?? globalConfig?.judgeAgent ?? { adapter: "codex" },
    architectAgent: opts.architectAgent ?? globalConfig?.architectAgent ?? { adapter: "claude-code" },
    documenterAgent: opts.documenterAgent ?? globalConfig?.documenterAgent ?? { adapter: "claude-code" },
    reflectionAgent: globalConfig?.reflectionAgent ?? globalConfig?.architectAgent ?? { adapter: "claude-code" },
    reflectSafeguardAfter: globalConfig?.reflectSafeguardAfter ?? 3,
    autoReviewSpecs: globalConfig?.autoReviewSpecs ?? false,
    autoDocumenter: globalConfig?.autoDocumenter ?? true,
    readinessGate: globalConfig?.readinessGate ?? "blocked",
    maxIterations: opts.maxIterations ?? globalConfig?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    pauseEvery: opts.pauseEvery ?? globalConfig?.pauseEvery ?? DEFAULT_PAUSE_EVERY,
    onStalled: "alert",
    mergeStrategy: "auto",
    cleanupMergedBranches: globalConfig?.cleanupMergedBranches ?? false,
    processTemplate: "default",
    currentIteration: 0,
    status: "idle",
    clioProject: resolvedClioProject,
    // item 5.7: Clio ingest policy. Inherit from global; do NOT default here
    // so the workspace config reads as "inherit from global" when unset.
    clio: globalConfig?.clio?.ingestPolicy
      ? { ingestPolicy: globalConfig.clio.ingestPolicy }
      : undefined,
  };

  const dir = getWorkspaceDir(id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf-8");

  return config;
}

/**
 * Get a workspace by ID.
 */
export async function getWorkspace(workspaceId: string): Promise<WorkspaceConfig | null> {
  try {
    const raw = await readFile(join(getWorkspaceDir(workspaceId), "config.json"), "utf-8");
    const parsed = JSON.parse(raw) as WorkspaceConfig;
    // Backfill fields introduced after the workspace was created. (item 5.6
    // adds reflectionAgent / reflectSafeguardAfter; older workspace configs
    // don't have them.) Kept in-memory only -- do not rewrite the file here.
    if (!parsed.reflectionAgent?.adapter) {
      parsed.reflectionAgent = {
        adapter:
          parsed.architectAgent?.adapter ??
          parsed.devAgent?.adapter ??
          "claude-code",
      };
    }
    if (typeof parsed.reflectSafeguardAfter !== "number" || parsed.reflectSafeguardAfter < 1) {
      parsed.reflectSafeguardAfter = 3;
    }
    // item 5.1 backfills.
    if (typeof parsed.autoReviewSpecs !== "boolean") {
      parsed.autoReviewSpecs = false;
    }
    if (typeof parsed.autoDocumenter !== "boolean") {
      parsed.autoDocumenter = true;
    }
    if (parsed.readinessGate !== "never" &&
        parsed.readinessGate !== "blocked" &&
        parsed.readinessGate !== "needs_refinement_or_blocked") {
      parsed.readinessGate = "blocked";
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Find a workspace by name (partial match, case-insensitive).
 * Returns the first match.
 */
export async function findWorkspaceByName(name: string): Promise<WorkspaceConfig | null> {
  const workspaces = await listWorkspaces();
  const lower = name.toLowerCase();
  return workspaces.find((w) => w.name.toLowerCase() === lower) ??
    workspaces.find((w) => w.id.toLowerCase().startsWith(lower)) ??
    null;
}

/**
 * List all workspaces.
 */
export async function listWorkspaces(): Promise<WorkspaceConfig[]> {
  const dir = getWorkspacesDir();
  try {
    const entries = await readdir(dir);
    const workspaces: WorkspaceConfig[] = [];
    for (const entry of entries) {
      const config = await getWorkspace(entry);
      if (config) workspaces.push(config);
    }
    return workspaces.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Update a workspace config.
 *
 * Status transitions are logged with a stack trace (item 6.35 follow-up
 * #2). The user reported workspace status getting stuck at "failed" even
 * though individual iteration history events later completed. The only
 * code paths writing `status: "failed"` are: (a) `cleanupStaleActiveLoops`
 * at boot, (b) `runLoop().catch()` in `startLoop`/`resumeLoop`. If the
 * workspace lands on "failed" outside those paths — or if it lands there
 * and then iterations succeed — the trace tells us where the write came
 * from.
 */
export async function updateWorkspace(
  workspaceId: string,
  updates: Partial<Omit<WorkspaceConfig, "id">>,
): Promise<WorkspaceConfig | null> {
  const existing = await getWorkspace(workspaceId);
  if (!existing) return null;

  // Trace status transitions — particularly into "failed" — so we can
  // see in the server log who/where set it.
  if (
    typeof updates.status === "string" &&
    updates.status !== existing.status
  ) {
    const stackHint = new Error("workspace-status-trace").stack
      ?.split("\n")
      .slice(2, 6)
      .join("\n    ")
      ?? "(no stack)";
    console.log(
      `[workspace-status] ${existing.name} (${workspaceId.slice(0, 8)}): ${existing.status} → ${updates.status}\n    ${stackHint}`,
    );
  }

  const updated = { ...existing, ...updates };
  await writeFile(
    join(getWorkspaceDir(workspaceId), "config.json"),
    JSON.stringify(updated, null, 2) + "\n",
    "utf-8",
  );
  return updated;
}

/**
 * Delete a workspace.
 */
export async function deleteWorkspace(workspaceId: string): Promise<boolean> {
  try {
    await rm(getWorkspaceDir(workspaceId), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Increment the workspace's iteration counter and return the new iteration number.
 * This is atomic: read current, increment, write back.
 */
export async function nextIteration(workspaceId: string): Promise<number | null> {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) return null;

  const next = (workspace.currentIteration || 0) + 1;
  await updateWorkspace(workspaceId, { currentIteration: next });
  return next;
}

/**
 * Roll the iteration counter back by one. Used by `retry_iteration`
 * (the resume action that re-spawns dev on the same iteration after a
 * `missing_signals` pause): the failed attempt was already counted via
 * `nextIteration()`, so we roll back to let the loop body's next
 * `nextIteration()` call return the same number. Idempotent at the
 * floor — if the counter is already 0 (no iterations yet), this is a
 * no-op.
 */
export async function decrementIteration(workspaceId: string): Promise<number | null> {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) return null;
  const current = workspace.currentIteration || 0;
  if (current <= 0) return 0;
  const prev = current - 1;
  await updateWorkspace(workspaceId, { currentIteration: prev });
  return prev;
}

/**
 * Verify a workspace's repo path exists and is a git repo.
 */
export async function validateWorkspaceRepo(repoPath: string): Promise<{ valid: boolean; error?: string }> {
  try {
    await access(repoPath);
  } catch {
    return { valid: false, error: `Directory not found: ${repoPath}` };
  }

  try {
    await access(join(repoPath, ".git"));
    return { valid: true };
  } catch {
    return { valid: false, error: `Not a git repository: ${repoPath}` };
  }
}
