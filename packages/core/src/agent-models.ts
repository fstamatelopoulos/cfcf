/**
 * Agent-models resolution (item 6.26).
 *
 * Single source of truth for "what models should we offer in pickers
 * for this adapter?" Two layers:
 *
 *   1. **Seed** -- shipped in the cfcf binary at
 *      `packages/core/src/adapters/seed-models.ts`. The floor.
 *   2. **User override** -- on `CfcfGlobalConfig.agentModels[<adapter>]`,
 *      managed via the web Settings → Model registry editor. The ceiling.
 *      When present and non-empty, supersedes the seed.
 *
 * Pickers (web Settings, web workspace Config, CLI init / config edit)
 * call `resolveModelsForAdapter()` which returns the resolved list. They
 * always also show a "(adapter default)" first option (empty value =
 * use whatever the agent CLI defaults to) and a "(custom model name…)"
 * sentinel last option that swaps to a free-text input -- so the user
 * can pin an unreleased model without waiting for cfcf or their own
 * Settings list to catch up.
 */

import { SEED_MODELS, getSeedModels } from "./adapters/seed-models.js";
import { getAdapter } from "./adapters/index.js";
import type { CfcfGlobalConfig } from "./types.js";

/**
 * Resolve the model list to surface in pickers for the given adapter.
 *
 * Routing depends on the adapter's `modelSource` (item 6.28):
 *   - "ollama":  pull from `config.availableOllamaModels` — the user's
 *                locally-pulled ollama models snapshot. Used by
 *                `claude-code-ollama` and `opencode-ollama`.
 *   - "custom":  return [] — no list. The picker still surfaces the
 *                "(adapter default)" + custom-model-name sentinel
 *                options so the user can always type a value. Used by
 *                `opencode` (direct), where the model is whatever the
 *                user authed via `opencode auth login`.
 *   - "seed" / unset:  the historical 6.26 path — user override on
 *                `agentModels[adapter]` if non-empty, else the seed
 *                from `seed-models.ts`. Used by `claude-code` + `codex`.
 *
 * An empty array is a valid result; the picker still renders "(adapter
 * default)" + "(custom model name…)" so the user can always proceed.
 */
export function resolveModelsForAdapter(
  adapterName: string,
  config: CfcfGlobalConfig | null,
): string[] {
  const adapter = getAdapter(adapterName);
  const source = adapter?.modelSource ?? "seed";

  if (source === "ollama") {
    const models = config?.availableOllamaModels;
    if (Array.isArray(models) && models.length > 0) {
      return models.filter((m) => typeof m === "string" && m.trim().length > 0);
    }
    return [];
  }

  if (source === "custom") {
    return [];
  }

  // "seed" — preserve the 6.26 user-override-then-seed precedence.
  const override = config?.agentModels?.[adapterName];
  if (Array.isArray(override) && override.length > 0) {
    return override.filter((m) => typeof m === "string" && m.trim().length > 0);
  }
  return getSeedModels(adapterName);
}

/**
 * Returns the full per-adapter map (resolved per `resolveModelsForAdapter`).
 * Used by `GET /api/agents/models` to populate every web picker in one
 * round-trip and by `cfcf doctor` for diagnostics.
 *
 * Iteration order: every adapter that has a seed entry, plus any
 * adapter the user has added an override for (so a user-only adapter
 * with no seed still shows up).
 */
export function resolveAllModels(
  config: CfcfGlobalConfig | null,
): Record<string, string[]> {
  const adapters = new Set([
    ...Object.keys(SEED_MODELS),
    ...Object.keys(config?.agentModels ?? {}),
  ]);
  const out: Record<string, string[]> = {};
  for (const adapter of adapters) {
    out[adapter] = resolveModelsForAdapter(adapter, config);
  }
  return out;
}
