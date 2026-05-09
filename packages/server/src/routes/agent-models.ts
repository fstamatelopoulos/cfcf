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
 *
 * `POST /api/agents/refresh-ollama-models` -- on-demand refresh of
 * the persisted `availableOllamaModels` field (item 6.33). Triggered
 * from the "Refresh ollama models" button in web Settings + workspace
 * Config agent-roles sections. Calls `ollama list` live, persists if
 * different, returns the new list. The boot-time refresh in
 * `start.ts` covers the "after server restart" path; this endpoint
 * covers the "between restarts" path so users don't need to bounce
 * the server every time they pull a new model.
 */

import type { Hono } from "hono";
import {
  readConfig,
  resolveAllModels,
  SEED_MODELS,
  refreshOllamaModelsInConfig,
} from "@cfcf/core";

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

  app.post("/api/agents/refresh-ollama-models", async (c) => {
    const result = await refreshOllamaModelsInConfig();
    // Always 200 — `error` is surfaced as a hint, not an HTTP failure
    // (the most common "error" is "ollama not installed", which isn't
    // an exceptional condition for this endpoint; the user just gets
    // an empty list back and the UI can render an info note).
    return c.json(result);
  });
}
