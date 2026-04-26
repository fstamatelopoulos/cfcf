import { describe, it, expect, afterEach } from "bun:test";
import { getConfigDir, getLogsDir, DEFAULT_PORT, VERSION, SUPPORTED_AGENTS } from "./constants.js";

describe("constants", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env.CFCF_CONFIG_DIR = originalEnv.CFCF_CONFIG_DIR;
    process.env.CFCF_LOGS_DIR = originalEnv.CFCF_LOGS_DIR;
  });

  it("has a default port", () => {
    expect(DEFAULT_PORT).toBe(7233);
  });

  it("has a version string", () => {
    expect(VERSION).toBe("0.10.0");
  });

  it("lists supported agents", () => {
    expect(SUPPORTED_AGENTS).toContain("claude-code");
    expect(SUPPORTED_AGENTS).toContain("codex");
  });

  describe("getConfigDir", () => {
    it("respects CFCF_CONFIG_DIR env var", () => {
      process.env.CFCF_CONFIG_DIR = "/custom/config";
      expect(getConfigDir()).toBe("/custom/config");
    });

    it("returns a platform-specific path when env var is not set", () => {
      delete process.env.CFCF_CONFIG_DIR;
      const dir = getConfigDir();
      expect(dir).toContain("cfcf");
      expect(dir.length).toBeGreaterThan(5);
    });
  });

  describe("getLogsDir", () => {
    it("respects CFCF_LOGS_DIR env var", () => {
      process.env.CFCF_LOGS_DIR = "/custom/logs";
      expect(getLogsDir()).toBe("/custom/logs");
    });

    it("defaults to ~/.cfcf/logs", () => {
      delete process.env.CFCF_LOGS_DIR;
      const dir = getLogsDir();
      expect(dir).toContain(".cfcf");
      expect(dir).toContain("logs");
    });
  });
});
