/**
 * Agent adapter registry.
 *
 * All supported agent adapters are registered here.
 * To add a new agent, create an adapter file and add it to this registry.
 */

import type { AgentAdapter, AgentAvailability } from "../types.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { opencodeAdapter } from "./opencode.js";
import { claudeCodeOllamaAdapter } from "./claude-code-ollama.js";
import { opencodeOllamaAdapter } from "./opencode-ollama.js";

/** Registry of all supported agent adapters */
const adapterRegistry: Map<string, AgentAdapter> = new Map([
  [claudeCodeAdapter.name, claudeCodeAdapter],
  [codexAdapter.name, codexAdapter],
  [opencodeAdapter.name, opencodeAdapter],
  [claudeCodeOllamaAdapter.name, claudeCodeOllamaAdapter],
  [opencodeOllamaAdapter.name, opencodeOllamaAdapter],
]);

/**
 * Get an adapter by name.
 */
export function getAdapter(name: string): AgentAdapter | undefined {
  return adapterRegistry.get(name);
}

/**
 * Get all registered adapter names.
 */
export function getAdapterNames(): string[] {
  return Array.from(adapterRegistry.keys());
}

/**
 * Detect which agents are available on this system.
 * Returns a list of adapter names that are installed and responding.
 */
export async function detectAvailableAgents(): Promise<
  { name: string; displayName: string; availability: AgentAvailability }[]
> {
  const results = await Promise.all(
    Array.from(adapterRegistry.values()).map(async (adapter) => ({
      name: adapter.name,
      displayName: adapter.displayName,
      availability: await adapter.checkAvailability(),
    })),
  );
  return results;
}

/**
 * Adapters whose `claude-code` binary is the primary unattended-execution
 * surface. Used by warning UIs (CLI + web) to flag the Anthropic
 * third-party-harness policy concern when a user picks Claude Code for
 * an iteration role. (item 6.28)
 */
const CLAUDE_CODE_HARNESS_ADAPTER = "claude-code";

/**
 * Roles that run unattended inside the iteration loop. Picking
 * `claude-code` for any of these triggers the policy warning. PA / HA /
 * manually-invoked SA do NOT — they take over the user's TUI directly,
 * which Anthropic's policy permits.
 *
 * "architect" is included because `autoReviewSpecs=true` makes the role
 * unattended (architect runs at the start of `cfcf run` without the user
 * driving its TUI). The warning also fires when the user has architect
 * on Claude Code AND `autoReviewSpecs` is true — the second condition
 * is enforced at the call site.
 */
export const UNATTENDED_ROLE_NAMES = [
  "dev",
  "judge",
  "reflection",
  "documenter",
  // architect — only when autoReviewSpecs=true (caller-enforced)
] as const;

export type UnattendedRoleName = (typeof UNATTENDED_ROLE_NAMES)[number];

/**
 * Returns true when the picked adapter for an unattended role is the
 * direct `claude-code` adapter (which uses subscription OAuth and is
 * the third-party-harness violation pattern). The `*-ollama` adapters
 * route through ollama and don't trigger the warning.
 */
export function isClaudeCodeHarnessRisk(adapterName: string): boolean {
  return adapterName === CLAUDE_CODE_HARNESS_ADAPTER;
}

/**
 * Centralised warning text used by both CLI (init / config edit) and
 * web (Settings, workspace Config) so the wording stays in lockstep.
 * (item 6.28)
 */
export const CLAUDE_CODE_HARNESS_WARNING =
  "Anthropic's third-party-harness policy prohibits using Claude Code subscriptions in unattended/headless contexts (the cfcf iteration loop is exactly that pattern). For limited testing only — do not use for production. See docs/guides/anthropic-policy.md.";

export {
  claudeCodeAdapter,
  codexAdapter,
  opencodeAdapter,
  claudeCodeOllamaAdapter,
  opencodeOllamaAdapter,
};
