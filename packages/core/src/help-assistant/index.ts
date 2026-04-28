/**
 * Help Assistant — public surface.
 *
 * Plan item 5.8 PR4. Design: `docs/research/help-assistant.md`.
 */

export {
  assembleHelpAssistantPrompt,
  type AssembleOptions,
} from "./prompt-assembler.js";
export {
  loadMemoryInventory,
  HA_MEMORY_PROJECT,
  GLOBAL_MEMORY_PROJECT,
} from "./memory.js";
export {
  buildLaunchArgs,
  launchHelpAssistant,
  type LaunchOptions,
  type LaunchResult,
} from "./launcher.js";
