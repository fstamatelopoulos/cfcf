import { describe, expect, test } from "bun:test";
import { resolveAllModels, resolveModelsForAdapter } from "./agent-models.js";
import { SEED_MODELS } from "./adapters/seed-models.js";
import type { CfcfGlobalConfig } from "./types.js";

function configWith(agentModels: CfcfGlobalConfig["agentModels"]): CfcfGlobalConfig {
  // Minimal valid-shaped config; the resolver only reads agentModels.
  return {
    version: 1,
    devAgent: { adapter: "claude-code" },
    judgeAgent: { adapter: "claude-code" },
    architectAgent: { adapter: "claude-code" },
    documenterAgent: { adapter: "claude-code" },
    maxIterations: 1,
    pauseEvery: 0,
    availableAgents: ["claude-code"],
    permissionsAcknowledged: true,
    agentModels,
  };
}

describe("resolveModelsForAdapter", () => {
  test("returns the seed list when no override is set", () => {
    expect(resolveModelsForAdapter("claude-code", null)).toEqual(SEED_MODELS["claude-code"]);
    expect(resolveModelsForAdapter("codex", null)).toEqual(SEED_MODELS["codex"]);
  });

  test("returns [] for an adapter with no seed and no override", () => {
    expect(resolveModelsForAdapter("unknown-adapter", null)).toEqual([]);
  });

  test("user override supersedes the seed when present + non-empty", () => {
    const cfg = configWith({ "claude-code": ["sonnet", "haiku", "claude-opus-4-7"] });
    expect(resolveModelsForAdapter("claude-code", cfg)).toEqual([
      "sonnet", "haiku", "claude-opus-4-7",
    ]);
  });

  test("an empty-array override falls back to the seed (don't strand the user with no options)", () => {
    const cfg = configWith({ "claude-code": [] });
    expect(resolveModelsForAdapter("claude-code", cfg)).toEqual(SEED_MODELS["claude-code"]);
  });

  test("non-string + blank entries in an override are filtered out", () => {
    const cfg = configWith({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "claude-code": ["sonnet", "", "  ", null as any, 42 as any, "opus"],
    });
    expect(resolveModelsForAdapter("claude-code", cfg)).toEqual(["sonnet", "opus"]);
  });

  test("override for one adapter doesn't affect another", () => {
    const cfg = configWith({ "claude-code": ["custom-only"] });
    expect(resolveModelsForAdapter("claude-code", cfg)).toEqual(["custom-only"]);
    expect(resolveModelsForAdapter("codex", cfg)).toEqual(SEED_MODELS["codex"]);
  });
});

describe("resolveAllModels", () => {
  test("returns every seeded adapter with its resolved list", () => {
    const result = resolveAllModels(null);
    expect(Object.keys(result).sort()).toEqual(Object.keys(SEED_MODELS).sort());
    expect(result["claude-code"]).toEqual(SEED_MODELS["claude-code"]);
    expect(result["codex"]).toEqual(SEED_MODELS["codex"]);
  });

  test("includes user-only adapters that have no seed entry", () => {
    const cfg = configWith({ "in-house-agent": ["model-a", "model-b"] });
    const result = resolveAllModels(cfg);
    expect(result["in-house-agent"]).toEqual(["model-a", "model-b"]);
    expect(result["claude-code"]).toEqual(SEED_MODELS["claude-code"]); // seed survives
  });
});
