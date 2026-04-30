/**
 * Help-route HTTP tests.
 *
 * The routes are read-only — they just expose the embedded help bundle
 * over HTTP. No filesystem / DB / process-state setup needed.
 */

import { describe, it, expect } from "bun:test";
import { createApp } from "../app.js";

describe("Help routes", () => {
  it("GET /api/help/topics lists every embedded topic", async () => {
    const app = createApp();
    const res = await app.request("/api/help/topics");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.topics)).toBe(true);
    const slugs = body.topics.map((t: { slug: string }) => t.slug);
    for (const required of [
      "manual",
      "workflow",
      "cli",
      "clio",
      "installing",
      "troubleshooting",
      "api",
    ]) {
      expect(slugs).toContain(required);
    }
  });

  it("GET /api/help/topics returns slug + title + source + aliases per entry", async () => {
    const app = createApp();
    const res = await app.request("/api/help/topics");
    const body = await res.json();
    const manual = body.topics.find((t: { slug: string }) => t.slug === "manual");
    expect(manual).toBeDefined();
    expect(typeof manual.title).toBe("string");
    expect(manual.title.length).toBeGreaterThan(2);
    expect(typeof manual.source).toBe("string");
    expect(Array.isArray(manual.aliases)).toBe(true);
  });

  it("GET /api/help/topics/:slug returns the full content for canonical slugs", async () => {
    const app = createApp();
    const res = await app.request("/api/help/topics/manual");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slug).toBe("manual");
    expect(typeof body.content).toBe("string");
    expect(body.content).toContain("# cf² User Manual");
  });

  it("GET /api/help/topics/:slug resolves aliases to the canonical entry", async () => {
    const app = createApp();
    const res = await app.request("/api/help/topics/cli-usage");
    expect(res.status).toBe(200);
    const body = await res.json();
    // Aliased lookups still report the canonical slug.
    expect(body.slug).toBe("cli");
  });

  it("GET /api/help/topics/:slug returns 404 for unknown topics", async () => {
    const app = createApp();
    const res = await app.request("/api/help/topics/does-not-exist");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("unknown help topic");
  });
});
