/**
 * Clio actor identification (item 6.18 round-3).
 *
 * cfcf agents identify themselves in Clio writes (and in any future
 * read-audit log) using a structured three-part stamp:
 *
 *     <role>|<agent>|<model>
 *
 *   - role:  "product-architect" / "help-assistant" / "dev" / "judge" /
 *            "architect" / "reflection" / "documenter" / "user"
 *   - agent: the AgentAdapter name ("claude-code" / "codex")
 *   - model: the resolved model alias ("opus" / "sonnet" / "gpt-5-codex"
 *            / etc.) or "default" when no explicit override was set
 *
 * Mirrors Cerefox's actor-stamp convention so a future swap-in to a
 * Cerefox-backed Clio doesn't break audit-log filters or analytics.
 *
 * **Where this gets used**:
 *   - `cfcf clio docs ingest --author "<actor>"` — sets both the doc's
 *     `author` field AND the audit row's `actor` field.
 *   - `cfcf clio docs delete/restore/edit --actor "<actor>"` — sets
 *     just the audit row's actor (preserves the doc's existing author
 *     unless explicitly changed via `--author`).
 *   - Auto-ingest paths in `loop-ingest.ts` pass `author: <actor>` to
 *     `backend.ingest({...})` directly.
 *   - PA + HA + iteration-role prompt assemblers inject the literal
 *     actor string into the agent's system prompt so the agent uses
 *     the correct stamp on any Clio write it makes.
 *
 * **Read auditing**: not implemented yet -- cfcf's audit log only
 * records mutations today. Cerefox has a separate `cerefox_usage_log`
 * for reads (powers the Analytics dashboard); cfcf parity for that
 * lives under plan item 6.9 (Rationalise Clio usage across agent
 * roles). When read-auditing lands, the same actor format applies.
 */

/**
 * Build the canonical actor string. `model` defaults to "default" when
 * the role's AgentConfig didn't pin a specific model -- that way the
 * stamp is unambiguous even when agents fall back to their adapter's
 * default model.
 */
export function formatClioActor(role: string, agent: string, model?: string | null): string {
  const m = model && model.trim() ? model.trim() : "default";
  return `${role}|${agent}|${m}`;
}

/**
 * Convenience constants for the two roles whose names need to match
 * across cfcf code surfaces (audit filters, agent prompts, tests).
 * Add to this list when new roles wire up their own actor stamps.
 */
export const ROLE_PRODUCT_ARCHITECT = "product-architect";
export const ROLE_HELP_ASSISTANT = "help-assistant";
export const ROLE_DEV = "dev";
export const ROLE_JUDGE = "judge";
export const ROLE_ARCHITECT = "architect";
export const ROLE_REFLECTION = "reflection";
export const ROLE_DOCUMENTER = "documenter";
export const ROLE_USER = "user";
