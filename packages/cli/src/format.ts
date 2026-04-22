/**
 * Shared formatting helpers for CLI output.
 */

import type { AgentConfig } from "@cfcf/core";

/**
 * Format an agent config for display: "adapter:model" or "adapter:default".
 * Examples: "codex:o3", "claude-code:opus", "codex:default"
 * Handles missing/undefined agents gracefully (workspaces created before a role was added).
 */
export function formatAgent(agent: AgentConfig | undefined): string {
  if (!agent?.adapter) return "(not configured)";
  return `${agent.adapter}:${agent.model || "default"}`;
}

/**
 * Format elapsed seconds as a human-readable string.
 * Examples: "5s", "2m 15s"
 */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}
