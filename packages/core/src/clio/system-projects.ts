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

/** Help Assistant cross-workspace memory. */
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
