/**
 * System-managed Clio Project names (item 6.18 round-2).
 *
 * Single source of truth for the small set of Clio Projects that cfcf
 * code owns: any module that writes to one of these imports the
 * constant from here rather than hardcoding the string. The same set
 * is checked by `LocalClio.editProject` + `deleteProject` to refuse
 * mutations from any surface (web UI, CLI, direct API).
 *
 * **Naming convention**: `cf-system-*`. Three projects today + room
 * for the per-role memory projects to be added as their roles wire
 * up (HA + reflection / architect / dev / documenter / judge follow
 * once their role-side memory paths land).
 *
 * **Why these are special**: agent prompts hardcode them by name. If
 * a user renames or deletes one, the next agent run would silently
 * auto-create a replacement under the original name and orphan the
 * user's edits. Locking edit + delete avoids the surprise.
 *
 * **What IS allowed inside a system project**: any user or agent can
 * still ingest, edit, delete, or restore individual documents. Only
 * the project itself (rename / delete / re-describe) is locked. This
 * keeps Clio's "shared memory across all agents and the user" model
 * intact while protecting the canonical project names.
 *
 * **Pre-existing data** under the old `cfcf-memory-*` and `default`
 * names from before the rename is reachable via the web UI's Projects
 * tab. Users can migrate manually via per-doc project reassignment
 * or per-workspace Clio Project pickers.
 */

/** Default Project for workspaces with no `clioProject` set. */
export const DEFAULT_PROJECT = "cf-system-default";

/** Cross-role global memory + user preferences. */
export const GLOBAL_MEMORY_PROJECT = "cf-system-memory-global";

/** Product Architect per-workspace memory (`pa-workspace-memory` + `pa-session-<id>`). */
export const PA_MEMORY_PROJECT = "cf-system-pa-memory";

/**
 * Help Assistant cross-workspace memory.
 *
 * Kept as a separate project (rather than folded into
 * `cf-system-memory-global`) so HA can persist its own Q&A history
 * across sessions and search it on the next user query for
 * conversation continuity. HA-specific role preferences (e.g. "skip
 * the welcome message") also live here. Cross-role facts ("user
 * prefers TypeScript", "Pacific time zone") still belong in
 * `cf-system-memory-global`.
 */
export const HA_MEMORY_PROJECT = "cf-system-ha-memory";

/**
 * The complete set of cfcf-owned Clio Projects. Used by the
 * `editProject` + `deleteProject` guards.
 *
 * Adding a new role-managed project: add the constant above, append
 * to this set, and import the constant at the role's call sites
 * instead of hardcoding the name.
 */
export const SYSTEM_PROJECTS: ReadonlySet<string> = new Set([
  DEFAULT_PROJECT,
  GLOBAL_MEMORY_PROJECT,
  PA_MEMORY_PROJECT,
  HA_MEMORY_PROJECT,
]);

/** True if `name` is one of the system-managed Clio Projects (case-sensitive). */
export function isSystemProject(name: string): boolean {
  return SYSTEM_PROJECTS.has(name);
}

/** Per-project descriptions populated when the boot pre-create runs. */
const SYSTEM_PROJECT_DESCRIPTIONS: Record<string, string> = {
  [DEFAULT_PROJECT]: "cf² default Clio Project. Auto-route fallback for workspaces with no explicit clioProject set.",
  [GLOBAL_MEMORY_PROJECT]: "cf² cross-role global memory + user preferences shared across all agent roles.",
  [PA_MEMORY_PROJECT]: "Product Architect (cfcf spec) per-workspace + per-session memory.",
  [HA_MEMORY_PROJECT]: "Help Assistant (cfcf help assistant) cross-workspace conversation history + role preferences.",
};

/**
 * Pre-create every system-managed Clio Project so they're visible in
 * the web UI + CLI listings even before any agent has written to one
 * (item 6.18 round-3). Safe to call repeatedly -- `getProject` checks
 * existence first so the second + subsequent calls are no-ops.
 *
 * Takes the minimum surface needed to dodge a circular type import
 * from this module to MemoryBackend; callers pass the live backend.
 */
export interface SystemProjectsBootBackend {
  getProject(idOrName: string): Promise<{ id: string; name: string } | null>;
  createProject(opts: { name: string; description?: string }): Promise<unknown>;
}

export async function ensureSystemProjects(backend: SystemProjectsBootBackend): Promise<void> {
  for (const name of SYSTEM_PROJECTS) {
    try {
      const existing = await backend.getProject(name);
      if (existing) continue;
      await backend.createProject({ name, description: SYSTEM_PROJECT_DESCRIPTIONS[name] });
    } catch {
      // Best-effort: a system-project pre-create failure shouldn't crash
      // server boot. The auto-create-on-first-use path still covers it.
    }
  }
}
