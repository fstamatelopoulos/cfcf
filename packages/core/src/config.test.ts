import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import {
  readConfig,
  writeConfig,
  configExists,
  createDefaultConfig,
  getConfigPath,
} from "./config.js";
import type { CfcfGlobalConfig } from "./types.js";

describe("config", () => {
  let tempDir: string;
  const originalEnv = process.env.CFCF_CONFIG_DIR;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cfcf-test-"));
    process.env.CFCF_CONFIG_DIR = tempDir;
  });

  afterEach(async () => {
    process.env.CFCF_CONFIG_DIR = originalEnv;
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("configExists", () => {
    it("returns false when no config file exists", async () => {
      expect(await configExists()).toBe(false);
    });

    it("returns true after config is written", async () => {
      const config = createDefaultConfig(["claude-code"]);
      await writeConfig(config);
      expect(await configExists()).toBe(true);
    });
  });

  describe("readConfig", () => {
    it("returns null when no config file exists", async () => {
      expect(await readConfig()).toBeNull();
    });

    it("reads a previously written config", async () => {
      const config = createDefaultConfig(["claude-code", "codex"]);
      await writeConfig(config);

      const read = await readConfig();
      expect(read).not.toBeNull();
      // dev defaults to codex now (item 6.28 — Anthropic harness policy);
      // judge falls back to same as dev when no other compliant adapter.
      expect(read!.devAgent.adapter).toBe("codex");
      expect(read!.judgeAgent.adapter).toBe("codex");
      expect(read!.availableAgents).toEqual(["claude-code", "codex"]);
    });

    it("throws on malformed JSON", async () => {
      const path = getConfigPath();
      const { mkdir, writeFile } = await import("fs/promises");
      await mkdir(tempDir, { recursive: true });
      await writeFile(path, "not json", "utf-8");

      expect(readConfig()).rejects.toThrow();
    });

    it("throws on missing required fields", async () => {
      const path = getConfigPath();
      const { mkdir, writeFile } = await import("fs/promises");
      await mkdir(tempDir, { recursive: true });
      await writeFile(path, JSON.stringify({ version: 1 }), "utf-8");

      expect(readConfig()).rejects.toThrow("devAgent.adapter");
    });
  });

  describe("createDefaultConfig", () => {
    // item 6.28: defaults flipped so unattended roles prefer codex over
    // claude-code (Anthropic's third-party-harness policy makes claude-code
    // non-compliant for the unattended dev/judge/reflection/documenter
    // pattern). Interactive roles (architect / PA / HA) keep claude-code
    // preference because they're within Anthropic's allowed-interactive scope.

    it("prefers codex as dev when both codex + claude-code available (policy-aligned)", () => {
      const config = createDefaultConfig(["claude-code", "codex"]);
      expect(config.devAgent.adapter).toBe("codex");
      // Judge: only one compliant adapter (codex) is available — same-as-dev
      // beats firing the policy warning by defaulting to claude-code.
      expect(config.judgeAgent.adapter).toBe("codex");
      // Documenter + reflection: same compliance reasoning as dev.
      expect(config.documenterAgent.adapter).toBe("codex");
      expect(config.reflectionAgent?.adapter).toBe("codex");
      // Architect / PA / HA: interactive roles, claude-code preferred.
      expect(config.architectAgent.adapter).toBe("claude-code");
      expect(config.productArchitectAgent?.adapter).toBe("claude-code");
      expect(config.helpAssistantAgent?.adapter).toBe("claude-code");
    });

    it("falls back to claude-code as dev when codex isn't available", () => {
      const config = createDefaultConfig(["claude-code"]);
      expect(config.devAgent.adapter).toBe("claude-code");
      expect(config.judgeAgent.adapter).toBe("claude-code");
    });

    it("when ollama-routed adapters are available, prefers a different compliant adapter for judge", () => {
      // dev → codex (top of preference). Judge prefers different compliant
      // adapter — claude-code-ollama wins over claude-code (which would
      // trigger the warning).
      const config = createDefaultConfig(["claude-code", "codex", "claude-code-ollama"]);
      expect(config.devAgent.adapter).toBe("codex");
      expect(config.judgeAgent.adapter).toBe("claude-code-ollama");
    });

    it("uses the only available agent for both roles if only one detected", () => {
      const config = createDefaultConfig(["codex"]);
      expect(config.devAgent.adapter).toBe("codex");
      expect(config.judgeAgent.adapter).toBe("codex");
    });

    it("sets sensible defaults for iteration params", () => {
      const config = createDefaultConfig(["claude-code"]);
      expect(config.maxIterations).toBe(10);
      expect(config.pauseEvery).toBe(0);
      expect(config.permissionsAcknowledged).toBe(false);
    });

    it("records available agents", () => {
      const config = createDefaultConfig(["claude-code", "codex"]);
      expect(config.availableAgents).toEqual(["claude-code", "codex"]);
    });

    // item 6.28 — ollama models snapshot.
    it("records availableOllamaModels when passed a non-empty list", () => {
      const config = createDefaultConfig(
        ["claude-code", "claude-code-ollama"],
        ["gemma4:31b", "qwen2.5-coder:32b"],
      );
      expect(config.availableOllamaModels).toEqual(["gemma4:31b", "qwen2.5-coder:32b"]);
    });

    it("leaves availableOllamaModels undefined when no ollama models are passed", () => {
      const config = createDefaultConfig(["claude-code"]);
      expect(config.availableOllamaModels).toBeUndefined();
    });

    it("normalises an empty ollama models list to undefined", () => {
      const config = createDefaultConfig(["claude-code"], []);
      expect(config.availableOllamaModels).toBeUndefined();
    });
  });

  describe("writeConfig", () => {
    it("creates the directory if it does not exist", async () => {
      const nested = join(tempDir, "deep", "nested");
      process.env.CFCF_CONFIG_DIR = nested;

      const config = createDefaultConfig(["claude-code"]);
      await writeConfig(config);
      expect(await configExists()).toBe(true);
    });
  });
});
