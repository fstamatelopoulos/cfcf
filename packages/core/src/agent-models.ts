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
import type { CfcfGlobalConfig } from "./types.js";

/**
 * Resolve the model list to surface in pickers for the given adapter.
 *
 * Order: user override (if present + non-empty) → seed → empty array.
 * An empty array is a valid result; the picker still renders "(adapter
 * default)" + "(custom model name…)" so the user can always proceed.
 */
export function resolveModelsForAdapter(
  adapterName: string,
  config: CfcfGlobalConfig | null,
): string[] {
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
