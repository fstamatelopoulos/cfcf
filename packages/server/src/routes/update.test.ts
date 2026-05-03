/**
 * `/api/update-status` HTTP tests (item 6.20).
 *
 * The route reads `~/.cfcf/update-available.json` (or the path pointed at
 * by `CFCF_UPDATE_FILE`). We override that env var per test to avoid
 * touching the real user state.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "@cfcf/core";
import { createApp } from "../app.js";

let tmpDir: string;
let originalEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cfcf-upd-route-"));
  originalEnv = process.env.CFCF_UPDATE_FILE;
  process.env.CFCF_UPDATE_FILE = join(tmpDir, "update-available.json");
});

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.CFCF_UPDATE_FILE;
  } else {
    process.env.CFCF_UPDATE_FILE = originalEnv;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("/api/update-status", () => {
  it("returns 204 when the flag file is absent", async () => {
    const app = createApp();
    const res = await app.request("/api/update-status");
    expect(res.status).toBe(204);
  });

  it("returns 200 + the flag body when latestVersion > running VERSION", async () => {
    // Build a synthetic latest by bumping the major version of whatever
    // the test runtime resolved as VERSION (always strictly newer).
    const [maj] = VERSION.replace(/^v/, "").split("-")[0].split(".");
    const latest = `${parseInt(maj, 10) + 1}.0.0`;
    writeFileSync(process.env.CFCF_UPDATE_FILE!, JSON.stringify({
      currentVersion: VERSION,
      latestVersion: latest,
      checkedAt: new Date().toISOString(),
    }));
    const app = createApp();
    const res = await app.request("/api/update-status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.latestVersion).toBe(latest);
    // Security: the flag file response intentionally omits any clickable
    // URL. See update-check.ts:UpdateAvailableFile for the rationale.
    expect(body.releaseNotesUrl).toBeUndefined();
  });

  it("returns 204 when the flag file is stale (latestVersion <= running)", async () => {
    // Pick a version we know is older than anything we could be running.
    writeFileSync(process.env.CFCF_UPDATE_FILE!, JSON.stringify({
      currentVersion: "0.0.1",
      latestVersion: "0.0.2",
      checkedAt: new Date().toISOString(),
    }));
    const app = createApp();
    const res = await app.request("/api/update-status");
    expect(res.status).toBe(204);
  });

  it("returns 204 on malformed flag-file body (missing required fields)", async () => {
    writeFileSync(process.env.CFCF_UPDATE_FILE!, JSON.stringify({ foo: "bar" }));
    const app = createApp();
    const res = await app.request("/api/update-status");
    expect(res.status).toBe(204);
  });
});
