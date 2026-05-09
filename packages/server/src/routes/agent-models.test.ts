/**
 * `/api/agents/models` HTTP tests (item 6.26).
 *
 * The route reads cfcf global config; we point CFCF_CONFIG_DIR at a
 * tmp dir per test so the user's real config isn't touched.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.js";

let tmpDir: string;
let originalEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cfcf-agent-models-"));
  originalEnv = process.env.CFCF_CONFIG_DIR;
  process.env.CFCF_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.CFCF_CONFIG_DIR;
  else process.env.CFCF_CONFIG_DIR = originalEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(body: Record<string, unknown>) {
  writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
    version: 1,
    devAgent: { adapter: "claude-code" },
    judgeAgent: { adapter: "claude-code" },
    architectAgent: { adapter: "claude-code" },
    documenterAgent: { adapter: "claude-code" },
    maxIterations: 1,
    pauseEvery: 0,
    availableAgents: ["claude-code", "codex"],
    permissionsAcknowledged: true,
    ...body,
  }));
}

describe("/api/agents/models", () => {
  it("returns the seed lists when no override is configured", async () => {
    writeConfig({});
    const app = createApp();
    const res = await app.request("/api/agents/models");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.adapters["claude-code"])).toBe(true);
    expect(body.adapters["claude-code"]).toContain("sonnet");
    expect(body.adapters["claude-code"]).toContain("opus");
    expect(body.adapters["codex"]).toContain("gpt-5-codex");
  });

  it("returns the user override when set + non-empty", async () => {
    writeConfig({
      agentModels: {
        "claude-code": ["sonnet", "haiku", "claude-opus-4-7"],
      },
    });
    const app = createApp();
    const res = await app.request("/api/agents/models");
    const body = await res.json();
    expect(body.adapters["claude-code"]).toEqual(["sonnet", "haiku", "claude-opus-4-7"]);
    // Other adapters fall through to the seed.
    expect(body.adapters["codex"]).toContain("gpt-5-codex");
  });

  it("includes the bundled seed alongside so the editor can show defaults", async () => {
    writeConfig({});
    const app = createApp();
    const res = await app.request("/api/agents/models");
    const body = await res.json();
    expect(body.seed["claude-code"]).toContain("sonnet");
    expect(body.seed["codex"]).toContain("gpt-5-codex");
  });

  it("returns the seed even when no config file exists yet (pre-init)", async () => {
    // No writeConfig() call -- config dir is empty.
    const app = createApp();
    const res = await app.request("/api/agents/models");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.adapters["claude-code"]).toContain("sonnet");
  });
});

describe("/api/agents/refresh-ollama-models (item 6.33)", () => {
  it("returns a 200 with shape { models, updated, error? }", async () => {
    // Don't assume ollama is or isn't installed on the test runner —
    // CI doesn't have it, dev machines often do. Either way, the
    // endpoint must return a 200 with the documented shape.
    writeConfig({});
    const app = createApp();
    const res = await app.request("/api/agents/refresh-ollama-models", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("models");
    expect(body).toHaveProperty("updated");
    expect(Array.isArray(body.models)).toBe(true);
    expect(typeof body.updated).toBe("boolean");
    // `error` is optional; only present when ollama is missing. If
    // present, must be a string.
    if (body.error !== undefined) {
      expect(typeof body.error).toBe("string");
    }
  });

  it("does NOT throw a 500 when ollama isn't installed", async () => {
    // Defence-in-depth: even if Bun.which() resolves an ollama binary
    // that subsequently fails, the endpoint must still return 200.
    // The pre-init case (no config file) is the trickier path; cover it.
    const app = createApp();
    const res = await app.request("/api/agents/refresh-ollama-models", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.models)).toBe(true);
    expect(typeof body.updated).toBe("boolean");
  });
});
