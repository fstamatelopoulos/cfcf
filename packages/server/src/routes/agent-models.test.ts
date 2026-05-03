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
