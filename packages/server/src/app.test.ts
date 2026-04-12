import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { createApp } from "./app.js";
import { writeConfig, createDefaultConfig } from "@cfcf/core";

describe("server API", () => {
  const app = createApp();
  let tempDir: string;
  const originalEnv = process.env.CFCF_CONFIG_DIR;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cfcf-server-test-"));
    process.env.CFCF_CONFIG_DIR = tempDir;
  });

  afterEach(async () => {
    process.env.CFCF_CONFIG_DIR = originalEnv;
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("GET /api/health", () => {
    it("returns ok status", async () => {
      const res = await app.request("/api/health");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.version).toBe("0.0.0");
      expect(typeof body.uptime).toBe("number");
    });
  });

  describe("GET /api/status", () => {
    it("returns running status with configured=false when no config", async () => {
      const res = await app.request("/api/status");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("running");
      expect(body.configured).toBe(false);
      expect(body.availableAgents).toEqual([]);
    });

    it("returns configured=true when config exists", async () => {
      const config = createDefaultConfig(["claude-code", "codex"]);
      await writeConfig(config);

      const res = await app.request("/api/status");
      const body = await res.json();
      expect(body.configured).toBe(true);
      expect(body.availableAgents).toEqual(["claude-code", "codex"]);
    });
  });

  describe("GET /api/config", () => {
    it("returns 404 when not configured", async () => {
      const res = await app.request("/api/config");
      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.error).toContain("Not configured");
    });

    it("returns config when configured", async () => {
      const config = createDefaultConfig(["claude-code"]);
      await writeConfig(config);

      const res = await app.request("/api/config");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.devAgent.adapter).toBe("claude-code");
      expect(body.version).toBe(1);
    });
  });
});
