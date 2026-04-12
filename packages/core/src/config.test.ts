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
      expect(read!.devAgent.adapter).toBe("claude-code");
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
    it("prefers claude-code as dev and codex as judge when both available", () => {
      const config = createDefaultConfig(["claude-code", "codex"]);
      expect(config.devAgent.adapter).toBe("claude-code");
      expect(config.judgeAgent.adapter).toBe("codex");
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
