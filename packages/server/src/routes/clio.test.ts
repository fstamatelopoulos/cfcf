/**
 * Clio HTTP route tests.
 *
 * Uses a temp backend via setClioBackend so the production ~/.cfcf/clio.db
 * is never touched by tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { createApp } from "../app.js";
import { LocalClio, writeConfig, createDefaultConfig } from "@cfcf/core";
import { setClioBackend } from "../clio-backend.js";

let tempDir: string;
let clio: LocalClio;
const originalEnv = process.env.CFCF_CONFIG_DIR;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "cfcf-clio-http-test-"));
  process.env.CFCF_CONFIG_DIR = tempDir;
  await writeConfig(createDefaultConfig(["claude-code"]));
  clio = new LocalClio({ path: join(tempDir, "clio.db") });
  setClioBackend(clio);
});

afterEach(async () => {
  setClioBackend(null);
  await clio.close();
  process.env.CFCF_CONFIG_DIR = originalEnv;
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function seedWorkspace(app: ReturnType<typeof createApp>, name: string, clioProject?: string) {
  const repoDir = join(tempDir, `repo-${name}`);
  await mkdir(repoDir, { recursive: true });
  await Bun.spawn(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;
  await Bun.spawn(["git", "config", "user.email", "t@e.dev"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;
  await Bun.spawn(["git", "config", "user.name", "t"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;
  await writeFile(join(repoDir, "README.md"), "# t\n");
  await Bun.spawn(["git", "add", "-A"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;
  await Bun.spawn(["git", "commit", "-m", "initial"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;

  const res = await app.request("/api/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, repoPath: repoDir, clioProject }),
  });
  expect(res.status).toBe(201);
  return await res.json();
}

describe("Clio HTTP: projects", () => {
  it("GET /api/clio/projects returns empty on fresh DB", async () => {
    const app = createApp();
    const res = await app.request("/api/clio/projects");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects).toEqual([]);
  });

  it("POST /api/clio/projects creates a Project", async () => {
    const app = createApp();
    const res = await app.request("/api/clio/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "cf-ecosystem", description: "cf² + Clio" }),
    });
    expect(res.status).toBe(201);
    const p = await res.json();
    expect(p.name).toBe("cf-ecosystem");
    expect(p.description).toBe("cf² + Clio");
    expect(p.id).toBeTruthy();
  });

  it("POST /api/clio/projects rejects missing name", async () => {
    const app = createApp();
    const res = await app.request("/api/clio/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/clio/projects returns 409 on duplicate name", async () => {
    const app = createApp();
    await app.request("/api/clio/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "dup" }),
    });
    const res = await app.request("/api/clio/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "dup" }),
    });
    expect(res.status).toBe(409);
  });

  it("GET /api/clio/projects/:idOrName returns 404 for unknown", async () => {
    const app = createApp();
    const res = await app.request("/api/clio/projects/no-such-project");
    expect(res.status).toBe(404);
  });
});

describe("Clio HTTP: ingest + search + get + stats", () => {
  it("POST /api/clio/ingest creates + returns the document", async () => {
    const app = createApp();
    const res = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "cf-ecosystem",
        title: "My note",
        content: "# My note\n\nsome content",
        source: "test",
        metadata: { role: "dev" },
      }),
    });
    expect(res.status).toBe(201);
    const r = await res.json();
    expect(r.created).toBe(true);
    expect(r.document.title).toBe("My note");
    expect(r.document.metadata.role).toBe("dev");
  });

  it("POST /api/clio/ingest rejects missing fields", async () => {
    const app = createApp();
    const res = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "p" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/clio/ingest returns 200 (not 201) on dedup", async () => {
    const app = createApp();
    const body = {
      project: "p1",
      title: "Dup",
      content: "# Dup\n\nsame content",
    };
    const first = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);

    const second = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(second.status).toBe(200);
    const r = await second.json();
    expect(r.created).toBe(false);
    expect(r.chunksInserted).toBe(0);
  });

  it("GET /api/clio/search returns FTS hits", async () => {
    const app = createApp();
    await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "p1",
        title: "Auth notes",
        content: "# Auth\n\nreal-time yields solve flaky authentication tests",
        metadata: { role: "reflection" },
      }),
    });

    const res = await app.request("/api/clio/search?q=authentication");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("fts");
    expect(body.hits.length).toBeGreaterThan(0);
    expect(body.hits[0].docTitle).toBe("Auth notes");
  });

  it("GET /api/clio/search honors project + metadata filters", async () => {
    const app = createApp();
    for (const [project, role, title] of [
      ["a", "dev", "a-dev"],
      ["a", "reflection", "a-reflection"],
      ["b", "dev", "b-dev"],
    ] as const) {
      await app.request("/api/clio/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project, title,
          content: `# ${title}\n\nauthentication content for ${title}`,
          metadata: { role },
        }),
      });
    }

    const res = await app.request(
      "/api/clio/search?q=authentication&project=a&metadata=" +
        encodeURIComponent(JSON.stringify({ role: "reflection" })),
    );
    const body = await res.json();
    expect(body.hits.map((h: { docTitle: string }) => h.docTitle)).toEqual(["a-reflection"]);
  });

  it("GET /api/clio/search rejects empty q", async () => {
    const app = createApp();
    const res = await app.request("/api/clio/search?q=");
    expect(res.status).toBe(400);
  });

  it("GET /api/clio/search rejects malformed metadata JSON", async () => {
    const app = createApp();
    const res = await app.request("/api/clio/search?q=foo&metadata=not-json");
    expect(res.status).toBe(400);
  });

  it("GET /api/clio/documents/:id returns the document", async () => {
    const app = createApp();
    const ingestRes = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "p1",
        title: "Round trip",
        content: "# Round trip\n\nbody",
      }),
    });
    const { id } = await ingestRes.json();

    const docRes = await app.request(`/api/clio/documents/${id}`);
    expect(docRes.status).toBe(200);
    const doc = await docRes.json();
    expect(doc.title).toBe("Round trip");
  });

  it("GET /api/clio/documents/:id returns 404 for unknown", async () => {
    const app = createApp();
    const res = await app.request("/api/clio/documents/bogus");
    expect(res.status).toBe(404);
  });

  // ── 5.11: update API + versioned content + versions ────────────────
  it("POST /api/clio/ingest with updateIfExists snapshots + returns action='updated'", async () => {
    const app = createApp();
    const a = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "p1", title: "Same title", content: "body v0" }),
    });
    const created = await a.json();
    expect(created.action).toBe("created");

    const b = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "p1", title: "Same title", content: "body v1",
        updateIfExists: true, author: "test-suite",
      }),
    });
    expect(b.status).toBe(200); // updates return 200, not 201
    const updated = await b.json();
    expect(updated.action).toBe("updated");
    expect(updated.id).toBe(created.id);
    expect(updated.versionId).toBeTruthy();
    expect(updated.versionNumber).toBe(1);
  });

  it("POST /api/clio/ingest with documentId returns 404 when the doc doesn't exist", async () => {
    const app = createApp();
    const res = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "p1", title: "x", content: "body",
        documentId: "00000000-0000-4000-8000-000000000000",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("GET /api/clio/documents/:id/content reconstructs live content + can pull a specific version", async () => {
    const app = createApp();
    const a = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "p1", title: "Versioned", content: "## H\n\nv0 body" }),
    });
    const v0 = await a.json();

    const b = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "p1", title: "Versioned", content: "## H\n\nv1 body",
        documentId: v0.id,
      }),
    });
    const v1 = await b.json();

    // Live = v1.
    const live = await app.request(`/api/clio/documents/${v0.id}/content`);
    expect(live.status).toBe(200);
    const liveBody = await live.json();
    expect(liveBody.content).toContain("v1 body");
    expect(liveBody.versionId).toBeNull();

    // Archived = v0 via version_id.
    const arch = await app.request(`/api/clio/documents/${v0.id}/content?version_id=${v1.versionId}`);
    expect(arch.status).toBe(200);
    const archBody = await arch.json();
    expect(archBody.content).toContain("v0 body");
    expect(archBody.versionId).toBe(v1.versionId);
  });

  it("GET /api/clio/documents/:id/content returns 404 for unknown version_id", async () => {
    const app = createApp();
    const a = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "p1", title: "X", content: "body" }),
    });
    const { id } = await a.json();
    const bogus = await app.request(`/api/clio/documents/${id}/content?version_id=00000000-0000-4000-8000-000000000000`);
    expect(bogus.status).toBe(404);
  });

  it("GET /api/clio/documents/:id/versions lists archived versions newest-first", async () => {
    const app = createApp();
    const a = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "p1", title: "Multi", content: "v0" }),
    });
    const { id } = await a.json();
    for (const body of ["v1", "v2", "v3"]) {
      await app.request("/api/clio/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: "p1", title: "Multi", content: body, documentId: id }),
      });
    }
    const res = await app.request(`/api/clio/documents/${id}/versions`);
    expect(res.status).toBe(200);
    const { versions } = await res.json();
    expect(versions.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([3, 2, 1]);
  });

  it("GET /api/clio/documents/:id/versions returns 404 for unknown doc", async () => {
    const app = createApp();
    const res = await app.request("/api/clio/documents/bogus/versions");
    expect(res.status).toBe(404);
  });

  it("GET /api/clio/stats returns counts + migrations", async () => {
    const app = createApp();
    await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "p1",
        title: "Stat test",
        content: "# Stat test\n\nbody",
      }),
    });

    const res = await app.request("/api/clio/stats");
    expect(res.status).toBe(200);
    const stats = await res.json();
    expect(stats.projectCount).toBe(1);
    expect(stats.documentCount).toBe(1);
    expect(stats.chunkCount).toBeGreaterThanOrEqual(1);
    expect(stats.migrations.length).toBeGreaterThanOrEqual(1);
    expect(stats.activeEmbedder).toBeNull();
  });
});

describe("PUT /api/workspaces/:id/clio-project", () => {
  it("sets the Clio Project without migrating history by default", async () => {
    const app = createApp();
    const w = await seedWorkspace(app, "wsA");

    // Seed some Clio docs under an "original" project
    await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "original", title: "D1", content: "# D1\n\nalpha body" }),
    });
    await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "original", title: "D2", content: "# D2\n\nbeta body" }),
    });
    // Set the workspace's original project (simulating "workspace was already
    // attached to `original`" state).
    const attachRes = await app.request(`/api/workspaces/${w.id}/clio-project`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "original" }),
    });
    expect(attachRes.status).toBe(200);

    // Now switch to a new Project without migrating history.
    const switchRes = await app.request(`/api/workspaces/${w.id}/clio-project`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "new-one" }),
    });
    expect(switchRes.status).toBe(200);
    const body = await switchRes.json();
    expect(body.workspace.clioProject).toBe("new-one");
    expect(body.migrated).toBe(0);

    // `original` still holds 2 docs, `new-one` has 0.
    const listRes = await app.request("/api/clio/projects");
    const listBody = await listRes.json();
    const original = listBody.projects.find((p: { name: string; documentCount?: number }) => p.name === "original");
    const newOne = listBody.projects.find((p: { name: string; documentCount?: number }) => p.name === "new-one");
    expect(original?.documentCount).toBe(2);
    expect(newOne?.documentCount).toBe(0);
  });

  it("migrates historical docs (workspace-scoped by default) when migrateHistory=true", async () => {
    const app = createApp();
    const w = await seedWorkspace(app, "wsB");

    // Two docs tagged to wsB (the workspace being switched). A third
    // doc is in the same src-proj but belongs to a sibling workspace
    // and must NOT move.
    await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "src-proj", title: "X",
        content: "# X\n\nctx alpha",
        metadata: { workspace_id: w.id },
      }),
    });
    await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "src-proj", title: "Y",
        content: "# Y\n\nctx beta",
        metadata: { workspace_id: w.id },
      }),
    });
    await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "src-proj", title: "Z-sibling",
        content: "# Z\n\nsibling workspace's doc",
        metadata: { workspace_id: "sibling-ws" },
      }),
    });
    await app.request(`/api/workspaces/${w.id}/clio-project`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "src-proj" }),
    });

    const switchRes = await app.request(`/api/workspaces/${w.id}/clio-project`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "dst-proj", migrateHistory: true }),
    });
    expect(switchRes.status).toBe(200);
    const body = await switchRes.json();
    expect(body.workspace.clioProject).toBe("dst-proj");
    // Only wsB's two docs moved; sibling's doc stayed in src-proj.
    expect(body.migrated).toBe(2);

    const listRes = await app.request("/api/clio/projects");
    const listBody = await listRes.json();
    const src = listBody.projects.find((p: { name: string; documentCount?: number }) => p.name === "src-proj");
    const dst = listBody.projects.find((p: { name: string; documentCount?: number }) => p.name === "dst-proj");
    expect(src?.documentCount).toBe(1);   // sibling doc still there
    expect(dst?.documentCount).toBe(2);
  });

  it("migrates ALL docs in the old Project when allInProject=true", async () => {
    const app = createApp();
    const w = await seedWorkspace(app, "wsCollapse");
    await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "old-p", title: "Mine",
        content: "# Mine\n\nmy doc",
        metadata: { workspace_id: w.id },
      }),
    });
    await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "old-p", title: "Sib",
        content: "# Sib\n\nsibling doc",
        metadata: { workspace_id: "another-ws" },
      }),
    });
    await app.request(`/api/workspaces/${w.id}/clio-project`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "old-p" }),
    });

    const switchRes = await app.request(`/api/workspaces/${w.id}/clio-project`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "new-p", migrateHistory: true, allInProject: true }),
    });
    const body = await switchRes.json();
    expect(body.migrated).toBe(2);

    const listRes = await app.request("/api/clio/projects");
    const listBody = await listRes.json();
    const old = listBody.projects.find((p: { name: string; documentCount?: number }) => p.name === "old-p");
    const neu = listBody.projects.find((p: { name: string; documentCount?: number }) => p.name === "new-p");
    expect(old?.documentCount).toBe(0);
    expect(neu?.documentCount).toBe(2);
  });

  it("rejects missing project field", async () => {
    const app = createApp();
    const w = await seedWorkspace(app, "wsC");
    const res = await app.request(`/api/workspaces/${w.id}/clio-project`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("404s when the workspace doesn't exist", async () => {
    const app = createApp();
    const res = await app.request("/api/workspaces/no-such-workspace/clio-project", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "anything" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/workspaces accepts clioProject", () => {
  it("stores clioProject on the created workspace", async () => {
    const app = createApp();
    const w = await seedWorkspace(app, "wsD", "my-clio");
    expect(w.clioProject).toBe("my-clio");
  });

  it("is optional (workspace created without it)", async () => {
    const app = createApp();
    const w = await seedWorkspace(app, "wsE");
    expect(w.clioProject).toBeUndefined();
  });
});
