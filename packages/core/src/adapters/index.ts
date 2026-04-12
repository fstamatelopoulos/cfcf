/**
 * Agent adapter registry.
 *
 * All supported agent adapters are registered here.
 * To add a new agent, create an adapter file and add it to this registry.
 */

import type { AgentAdapter, AgentAvailability } from "../types.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";

/** Registry of all supported agent adapters */
const adapterRegistry: Map<string, AgentAdapter> = new Map([
  [claudeCodeAdapter.name, claudeCodeAdapter],
  [codexAdapter.name, codexAdapter],
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

export { claudeCodeAdapter, codexAdapter };
