/**
 * Product Architect — public surface (v2).
 *
 * Renames symbols that collide with Help Assistant's surface so the
 * shared `@cfcf/core` package wildcard re-export stays unambiguous.
 *
 * Plan item 5.14. Design: `docs/research/product-architect-design.md`.
 */

// Prompt assembler
export {
  assembleProductArchitectPrompt,
  type AssembleOptions as PaAssembleOptions,
} from "./prompt-assembler.js";

// State assessor (replaces the v1 workspace-state module)
export {
  assessState,
  formatAssessedState,
  generateSessionId,
  type AssessedState,
  type GitState,
  type WorkspaceRegistration,
  type ServerState,
  type IterationHistory,
  type ProblemPackState,
  type ProblemPackFile,
  type PaCacheState,
} from "./state-assessor.js";

// Memory
export {
  readMemoryInventory,
  readWorkspaceMemory,
  readGlobalMemory,
  readOtherRoleMemory,
  formatMemoryInventory,
  loadMemoryInventoryFormatted,
  // Backwards-compat alias for v1 callers.
  loadMemoryInventory as loadPaMemoryInventory,
  PA_PROJECT,
  PA_MEMORY_PROJECT,
  PA_WORKSPACE_MEMORY_TITLE,
  PA_GLOBAL_MEMORY_TITLE,
  READONLY_OTHER_ROLE_PROJECTS,
  type MemoryInventory,
  type WorkspaceMemorySnapshot,
  type GlobalMemorySnapshot,
  type OtherRoleMemoryEntry,
} from "./memory.js";

// Launcher
export {
  buildLaunchArgs as buildPaLaunchArgs,
  launchProductArchitect,
  type LaunchOptions as PaLaunchOptions,
  type LaunchResult as PaLaunchResult,
  type LaunchArgs as PaLaunchArgs,
} from "./launcher.js";
