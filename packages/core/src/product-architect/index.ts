/**
 * Product Architect — public surface.
 *
 * Renames symbols that collide with Help Assistant's surface so the
 * shared `@cfcf/core` package wildcard re-export stays unambiguous.
 *
 * Plan item 5.14. Design: `docs/research/product-architect.md`.
 */
export {
  assembleProductArchitectPrompt,
  type AssembleOptions as PaAssembleOptions,
} from "./prompt-assembler.js";
export {
  loadMemoryInventory as loadPaMemoryInventory,
  PA_MEMORY_PROJECT,
} from "./memory.js";
export {
  readProblemPackState,
  formatProblemPackState,
  type ProblemPackState,
} from "./workspace-state.js";
export {
  buildBriefingBody,
  writeBriefingFiles,
  PA_BRIEFING_FILENAMES,
  type BriefingPayload,
} from "./briefing-files.js";
export {
  buildLaunchArgs as buildPaLaunchArgs,
  launchProductArchitect,
  type LaunchOptions as PaLaunchOptions,
  type LaunchResult as PaLaunchResult,
  type LaunchArgs as PaLaunchArgs,
} from "./launcher.js";
