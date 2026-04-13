/**
 * Shared formatting helpers for CLI output.
 */

import type { AgentConfig } from "@cfcf/core";

/**
 * Format an agent config for display: "adapter:model" or "adapter:default".
 * Examples: "codex:o3", "claude-code:opus", "codex:default"
 */
export function formatAgent(agent: AgentConfig): string {
  return `${agent.adapter}:${agent.model || "default"}`;
}
