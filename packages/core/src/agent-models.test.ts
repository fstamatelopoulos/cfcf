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

  // item 6.28 — modelSource routing for the new adapters.

  test("opencode (modelSource=custom) returns []", () => {
    // The picker still surfaces (adapter default) + custom-name sentinel,
    // so an empty list is the right answer here.
    expect(resolveModelsForAdapter("opencode", null)).toEqual([]);
    const cfg = configWith({});
    expect(resolveModelsForAdapter("opencode", cfg)).toEqual([]);
  });

  test("opencode ignores any agentModels override (modelSource=custom)", () => {
    // Even if a user adds models under `opencode` in agentModels, the
    // picker shouldn't show them — opencode's models come from its own
    // provider auth config which cfcf doesn't see. Allowing the override
    // to leak through would mislead the user.
    const cfg = configWith({ opencode: ["anthropic/claude-3-5-sonnet"] });
    expect(resolveModelsForAdapter("opencode", cfg)).toEqual([]);
  });

  test("claude-code-ollama (modelSource=ollama) sources from availableOllamaModels", () => {
    const cfg: CfcfGlobalConfig = {
      ...configWith({}),
      availableOllamaModels: ["gemma4:31b", "qwen2.5-coder:32b"],
    };
    expect(resolveModelsForAdapter("claude-code-ollama", cfg)).toEqual([
      "gemma4:31b",
      "qwen2.5-coder:32b",
    ]);
  });

  test("opencode-ollama (modelSource=ollama) sources from availableOllamaModels", () => {
    const cfg: CfcfGlobalConfig = {
      ...configWith({}),
      availableOllamaModels: ["gemma4:31b"],
    };
    expect(resolveModelsForAdapter("opencode-ollama", cfg)).toEqual(["gemma4:31b"]);
  });

  test("ollama adapters return [] when availableOllamaModels is missing", () => {
    expect(resolveModelsForAdapter("claude-code-ollama", null)).toEqual([]);
    expect(resolveModelsForAdapter("opencode-ollama", null)).toEqual([]);
    const cfg = configWith({});
    expect(resolveModelsForAdapter("claude-code-ollama", cfg)).toEqual([]);
    expect(resolveModelsForAdapter("opencode-ollama", cfg)).toEqual([]);
  });

  test("ollama adapters ignore agentModels override (source comes from availableOllamaModels)", () => {
    // A user override on agentModels for an ollama adapter would be
    // misleading — the actual source is `ollama list`. The override is
    // silently ignored.
    const cfg: CfcfGlobalConfig = {
      ...configWith({ "claude-code-ollama": ["sonnet", "opus"] }),
      availableOllamaModels: ["gemma4:31b"],
    };
    expect(resolveModelsForAdapter("claude-code-ollama", cfg)).toEqual(["gemma4:31b"]);
  });

  test("filters out blank/non-string entries in availableOllamaModels", () => {
    const cfg: CfcfGlobalConfig = {
      ...configWith({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      availableOllamaModels: ["gemma4:31b", "", "  ", null as any, "qwen2.5-coder:32b"],
    };
    expect(resolveModelsForAdapter("claude-code-ollama", cfg)).toEqual([
      "gemma4:31b",
      "qwen2.5-coder:32b",
    ]);
  });
});

describe("resolveAllModels", () => {
  test("returns every registered adapter, with seeded ones resolved + new ones empty", () => {
    const result = resolveAllModels(null);
    // 6.26 seeded adapters carry their seed lists.
    expect(result["claude-code"]).toEqual(SEED_MODELS["claude-code"]);
    expect(result["codex"]).toEqual(SEED_MODELS["codex"]);
    // 6.28 new adapters appear in the map even with no seed entry.
    expect(result).toHaveProperty("opencode");
    expect(result).toHaveProperty("claude-code-ollama");
    expect(result).toHaveProperty("opencode-ollama");
    // ...with empty lists when no override / ollama models are present.
    expect(result["opencode"]).toEqual([]);
    expect(result["claude-code-ollama"]).toEqual([]);
    expect(result["opencode-ollama"]).toEqual([]);
  });

  test("includes user-only adapters that have no seed entry and no registry entry", () => {
    const cfg = configWith({ "in-house-agent": ["model-a", "model-b"] });
    const result = resolveAllModels(cfg);
    expect(result["in-house-agent"]).toEqual(["model-a", "model-b"]);
    expect(result["claude-code"]).toEqual(SEED_MODELS["claude-code"]); // seed survives
  });

  test("ollama adapters surface availableOllamaModels in the result", () => {
    const cfg: CfcfGlobalConfig = {
      ...configWith({}),
      availableOllamaModels: ["gemma4:31b", "qwen2.5-coder:32b"],
    };
    const result = resolveAllModels(cfg);
    expect(result["claude-code-ollama"]).toEqual(["gemma4:31b", "qwen2.5-coder:32b"]);
    expect(result["opencode-ollama"]).toEqual(["gemma4:31b", "qwen2.5-coder:32b"]);
    // Direct opencode (modelSource=custom) stays empty regardless.
    expect(result["opencode"]).toEqual([]);
  });
});
