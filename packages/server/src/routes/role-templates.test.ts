/**
 * `/api/role-templates/*` HTTP tests (item 6.8).
 *
 * The route delegates to `@cfcf/core/role-templates`, which is
 * exhaustively unit-tested at `packages/core/src/role-templates.test.ts`.
 * These tests focus on the HTTP shape: status codes, body validation,
 * error envelopes, and round-trip behaviour from the network surface.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.js";

let tmpDir: string;
let originalEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cfcf-role-tpl-api-"));
  originalEnv = process.env.CFCF_CONFIG_DIR;
  process.env.CFCF_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.CFCF_CONFIG_DIR;
  else process.env.CFCF_CONFIG_DIR = originalEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

const JUDGE = "cfcf-judge-instructions.md";
const JUDGE_ENC = encodeURIComponent(JUDGE);

describe("GET /api/role-templates", () => {
  it("returns one summary per managed template, all on default", async () => {
    const app = createApp();
    const res = await app.request("/api/role-templates");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.templates)).toBe(true);
    expect(body.templates.length).toBeGreaterThanOrEqual(5);
    for (const t of body.templates) {
      expect(t.currentVersionId).toBe("default");
      expect(t.versionCount).toBe(0);
    }
  });
});

describe("GET /api/role-templates/:name", () => {
  it("returns the full state with bundled default content", async () => {
    const app = createApp();
    const res = await app.request(`/api/role-templates/${JUDGE_ENC}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe(JUDGE);
    expect(body.displayName).toBe("Judge");
    expect(body.currentVersionId).toBe("default");
    expect(body.defaultContent.length).toBeGreaterThan(0);
    expect(body.currentContent).toBe(body.defaultContent);
    expect(body.versions).toEqual([]);
  });

  it("returns 404 for unknown template names", async () => {
    const app = createApp();
    const res = await app.request("/api/role-templates/nonexistent.md");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });
});

describe("POST /api/role-templates/:name/versions", () => {
  it("creates a new version and returns 201", async () => {
    const app = createApp();
    const res = await app.request(`/api/role-templates/${JUDGE_ENC}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "stricter judge", content: "## Custom\nBody" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(/^v_/);
    expect(body.label).toBe("stricter judge");
    expect(body.contentHash.length).toBe(12);
  });

  it("rejects non-JSON body with 400", async () => {
    const app = createApp();
    const res = await app.request(`/api/role-templates/${JUDGE_ENC}/versions`, {
      method: "POST",
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing label or content with 400", async () => {
    const app = createApp();
    const res = await app.request(`/api/role-templates/${JUDGE_ENC}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "no body" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty label with 400", async () => {
    const app = createApp();
    const res = await app.request(`/api/role-templates/${JUDGE_ENC}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "  ", content: "x" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/role-templates/:name/versions/:versionId", () => {
  it("returns the bundled default for versionId='default'", async () => {
    const app = createApp();
    const res = await app.request(`/api/role-templates/${JUDGE_ENC}/versions/default`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.content).toBe("string");
    expect(body.content.length).toBeGreaterThan(0);
  });

  it("returns 404 for unknown version id", async () => {
    const app = createApp();
    const res = await app.request(`/api/role-templates/${JUDGE_ENC}/versions/v_nope`);
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/role-templates/:name/versions/:versionId", () => {
  it("updates the label", async () => {
    const app = createApp();
    const create = await app.request(`/api/role-templates/${JUDGE_ENC}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "old", content: "body" }),
    });
    const v = await create.json();
    const update = await app.request(`/api/role-templates/${JUDGE_ENC}/versions/${v.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "new label" }),
    });
    expect(update.status).toBe(200);
    const body = await update.json();
    expect(body.label).toBe("new label");
  });

  it("rejects updating the bundled default with 400", async () => {
    const app = createApp();
    const res = await app.request(`/api/role-templates/${JUDGE_ENC}/versions/default`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "x" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/role-templates/:name/promote", () => {
  it("promotes a version, writes the override file, returns refreshed state", async () => {
    const app = createApp();
    const create = await app.request(`/api/role-templates/${JUDGE_ENC}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "custom", content: "MY OVERRIDE" }),
    });
    const v = await create.json();
    const promote = await app.request(`/api/role-templates/${JUDGE_ENC}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ versionId: v.id }),
    });
    expect(promote.status).toBe(200);
    const body = await promote.json();
    expect(body.currentVersionId).toBe(v.id);
    expect(body.currentContent).toBe("MY OVERRIDE");

    // Override file written.
    expect(existsSync(join(tmpDir, "templates", JUDGE))).toBe(true);
    expect(readFileSync(join(tmpDir, "templates", JUDGE), "utf-8")).toBe("MY OVERRIDE");
  });

  it("promoting 'default' deletes the override file", async () => {
    const app = createApp();
    // First create + promote a version.
    const create = await app.request(`/api/role-templates/${JUDGE_ENC}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "x", content: "OVERRIDE" }),
    });
    const v = await create.json();
    await app.request(`/api/role-templates/${JUDGE_ENC}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ versionId: v.id }),
    });
    expect(existsSync(join(tmpDir, "templates", JUDGE))).toBe(true);

    // Now revert to default.
    const revert = await app.request(`/api/role-templates/${JUDGE_ENC}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ versionId: "default" }),
    });
    expect(revert.status).toBe(200);
    const body = await revert.json();
    expect(body.currentVersionId).toBe("default");
    // Override file gone.
    expect(existsSync(join(tmpDir, "templates", JUDGE))).toBe(false);
  });
});

describe("DELETE /api/role-templates/:name/versions/:versionId", () => {
  it("deletes a version and returns refreshed template state", async () => {
    const app = createApp();
    const create = await app.request(`/api/role-templates/${JUDGE_ENC}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "x", content: "body" }),
    });
    const v = await create.json();
    const del = await app.request(`/api/role-templates/${JUDGE_ENC}/versions/${v.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    const body = await del.json();
    expect(body.deleted).toBe(true);
    expect(body.template.versions).toHaveLength(0);
  });

  it("rejects deleting the bundled default with 400", async () => {
    const app = createApp();
    const res = await app.request(`/api/role-templates/${JUDGE_ENC}/versions/default`, {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
  });
});
