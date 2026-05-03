/**
 * `GET /api/agents/models` -- per-adapter model registry surface
 * (item 6.26).
 *
 * Returns `Record<adapterName, string[]>` for every adapter cfcf knows
 * about. Each list is the resolved registry: user override on
 * `CfcfGlobalConfig.agentModels[adapter]` if present + non-empty,
 * otherwise the bundled seed in
 * `packages/core/src/adapters/seed-models.ts`.
 *
 * Web pickers (Settings agent-roles, workspace Config agent-roles)
 * fetch this when the model picker opens; the seed list is small so
 * the response is tiny and the cost of re-fetching on every picker
 * open is fine.
 */

import type { Hono } from "hono";
import { readConfig, resolveAllModels, SEED_MODELS } from "@cfcf/core";

export function registerAgentModelsRoutes(app: Hono): void {
  app.get("/api/agents/models", async (c) => {
    const config = await readConfig();
    return c.json({
      adapters: resolveAllModels(config),
      // Surface the seed alongside so the Settings → Model registry
      // editor can show users what they'd revert to if they cleared
      // their override (without the editor having to know the seed
      // values out-of-band).
      seed: SEED_MODELS,
    });
  });
}
