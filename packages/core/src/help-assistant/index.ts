/**
 * Help Assistant — public surface.
 *
 * Plan item 5.8 PR4. Design: `docs/research/help-assistant.md`.
 */

export {
  assembleHelpAssistantPrompt,
  type AssembleOptions,
} from "./prompt-assembler.js";
export { loadMemoryInventory } from "./memory.js";
// HA_MEMORY_PROJECT + GLOBAL_MEMORY_PROJECT are exported from
// clio/system-projects (the canonical location). Import via
// `import { HA_MEMORY_PROJECT } from "@cfcf/core"` -- still works the
// same way, just sourced from one place now.
export {
  buildLaunchArgs,
  launchHelpAssistant,
  type LaunchOptions,
  type LaunchResult,
} from "./launcher.js";
