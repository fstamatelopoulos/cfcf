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
 * manually-invoked SA via `cfcf review` do NOT — they take over the
 * user's TUI directly, which Anthropic's policy permits.
 *
 * "architect" was previously gated by the call site on
 * `autoReviewSpecs=true`, but that qualifier was too narrow: the
 * iteration loop also invokes the architect unattended on the
 * `refine_plan` resume action (item 6.25) and on a NEEDS_REFINEMENT
 * verdict from the judge (architect re-review pattern). The same
 * adapter setting drives all three loop-invoked paths AND the manual
 * `cfcf review` path. Since the user can't pick a different adapter
 * per invocation context, the warning has to reflect the worst case
 * — and the worst case is "loop will invoke this unattended". Always
 * including architect here is the correct conservative behaviour
 * (item 6.30, 2026-05-08).
 */
export const UNATTENDED_ROLE_NAMES = [
  "dev",
  "judge",
  "reflection",
  "documenter",
  "architect",
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
 * (item 6.28; refined 2026-05-10 to clarify the API-key escape hatch.)
 *
 * Key distinction: the policy targets **subscription OAuth credentials
 * in third-party harnesses**, not the `claude-code` adapter itself.
 * Running claude-code with `ANTHROPIC_API_KEY` set (so the CLI
 * authenticates via the paid Anthropic API rather than your Pro/Max
 * subscription) is policy-compliant — that's the canonical "unattended
 * automation under your own credentials" pattern Anthropic supports.
 *
 * The warning therefore distinguishes the two cases instead of
 * tarring the whole adapter as forbidden.
 */
export const CLAUDE_CODE_HARNESS_WARNING =
  "Anthropic's third-party-harness policy prohibits using a Claude Pro/Max **subscription** OAuth credential in unattended/headless contexts (the cfcf iteration loop is exactly that pattern). The **API-key path is exempt** — set `ANTHROPIC_API_KEY` in your environment and claude-code will authenticate via the paid API instead of your subscription. That's the compliant way to run claude-code on unattended roles. If you're on subscription OAuth: limited testing only — switch to `codex` / `claude-code-ollama` / `opencode-ollama` / `opencode` for production. See docs/guides/anthropic-policy.md.";

/**
 * Returns true when the picked adapter routes through claude-code-ollama,
 * which uses Anthropic's strict Messages API parser on top of ollama's
 * model output. Some non-coder-tuned local models (e.g. gemma4:31b)
 * produce tool-use / tool-result content blocks the parser rejects with
 * `API Error: Content block not found`. The OpenAI-compatible endpoint
 * used by `opencode-ollama` is more tolerant of the same models — that's
 * the recommended fall-back when this combination fails. Surfaced as
 * an informational note (not a blocking warning) since the failure
 * mode is model-specific and may not bite a given workspace's run.
 * (item 6.30, 2026-05-08)
 */
export function isApiParseRisk(adapterName: string): boolean {
  return adapterName === "claude-code-ollama";
}

export {
  claudeCodeAdapter,
  codexAdapter,
  opencodeAdapter,
  claudeCodeOllamaAdapter,
  opencodeOllamaAdapter,
};
