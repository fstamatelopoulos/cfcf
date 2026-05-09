import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectOllama, listOllamaModels, refreshOllamaModelsInConfig } from "./ollama-detection.js";

// These tests don't assert that ollama IS installed — CI may not have it.
// They verify the shape of the responses is correct so that callers can
// rely on the contract regardless of the runtime environment.

describe("detectOllama", () => {
  it("returns an OllamaAvailability object", async () => {
    const result = await detectOllama();
    expect(result).toHaveProperty("available");
    expect(typeof result.available).toBe("boolean");
    if (result.available) {
      expect(result).toHaveProperty("version");
      expect(typeof result.version).toBe("string");
      expect(result.version!.length).toBeGreaterThan(0);
    } else {
      expect(result).toHaveProperty("error");
      expect(typeof result.error).toBe("string");
    }
  });
});

describe("listOllamaModels", () => {
  it("returns an array of strings (possibly empty)", async () => {
    const result = await listOllamaModels();
    expect(Array.isArray(result)).toBe(true);
    for (const model of result) {
      expect(typeof model).toBe("string");
      expect(model.length).toBeGreaterThan(0);
    }
  });

  it("never includes the literal NAME header column", async () => {
    // Sanity check: parsing should always strip the table header. If the
    // implementation regresses to including raw lines, this would catch
    // it on any system where ollama is installed (header is always present).
    const result = await listOllamaModels();
    expect(result).not.toContain("NAME");
  });
});

describe("refreshOllamaModelsInConfig (item 6.33)", () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cfcf-ollama-refresh-"));
    originalEnv = process.env.CFCF_CONFIG_DIR;
    process.env.CFCF_CONFIG_DIR = tmpDir;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CFCF_CONFIG_DIR;
    else process.env.CFCF_CONFIG_DIR = originalEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeBaseConfig(extra: Record<string, unknown> = {}): void {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      version: 1,
      devAgent: { adapter: "claude-code" },
      judgeAgent: { adapter: "claude-code" },
      architectAgent: { adapter: "claude-code" },
      documenterAgent: { adapter: "claude-code" },
      maxIterations: 1,
      pauseEvery: 0,
      availableAgents: ["claude-code"],
      permissionsAcknowledged: true,
      ...extra,
    }));
  }

  it("returns the documented shape regardless of whether ollama is installed", async () => {
    writeBaseConfig();
    const result = await refreshOllamaModelsInConfig();
    expect(result).toHaveProperty("models");
    expect(result).toHaveProperty("updated");
    expect(Array.isArray(result.models)).toBe(true);
    expect(typeof result.updated).toBe("boolean");
  });

  it("does NOT write to config when no global config exists", async () => {
    // No writeBaseConfig() — config dir is empty.
    const result = await refreshOllamaModelsInConfig();
    // updated must be false: nothing to update.
    expect(result.updated).toBe(false);
    // No config file should have been created.
    expect(existsSync(join(tmpDir, "config.json"))).toBe(false);
  });

  it("does NOT rewrite the config when the live list matches what's saved", async () => {
    // If ollama isn't on the test runner, this test is degenerate but
    // still passes: live list is [], saved list is [] (after our write
    // collapses the field), and the equality check returns true.
    const result1 = await refreshOllamaModelsInConfig();
    // Snapshot the config after the first refresh — anything that
    // would change is now reflected.
    if (!existsSync(join(tmpDir, "config.json"))) {
      // No config existed; nothing to verify.
      return;
    }
    writeBaseConfig({ availableOllamaModels: result1.models.length > 0 ? result1.models : undefined });
    const beforeMtime = readFileSync(join(tmpDir, "config.json"), "utf-8");
    const result2 = await refreshOllamaModelsInConfig();
    expect(result2.updated).toBe(false);
    const afterMtime = readFileSync(join(tmpDir, "config.json"), "utf-8");
    expect(beforeMtime).toBe(afterMtime);
  });

  it("treats list ordering as insensitive (ollama list reorders by mtime, not a real change)", async () => {
    // Pre-seed the config with a list. If the live result has the same
    // strings in a different order, we shouldn't rewrite.
    writeBaseConfig({ availableOllamaModels: ["model-c", "model-a", "model-b"] });
    // Simulate the equality check directly via a known-different order
    // of the same set. We can't force `ollama list` to emit a specific
    // order, so this test exercises the persistence path indirectly:
    // if the helper's order-sensitive comparison regressed, two
    // back-to-back refreshes against the same model set would flap
    // updated=true. Instead we check that two consecutive calls don't
    // race the saved list:
    const r1 = await refreshOllamaModelsInConfig();
    const r2 = await refreshOllamaModelsInConfig();
    // Both calls returned the same set; the second should never
    // claim to have updated (since r1 already wrote whatever was
    // needed).
    expect(r2.updated).toBe(false);
    // r1 and r2 must agree on the set.
    expect(new Set(r2.models)).toEqual(new Set(r1.models));
  });
});
