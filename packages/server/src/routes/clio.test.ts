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

  // ── 6.18 round-2: PATCH + DELETE /api/clio/projects/:idOrName ──

  it("PATCH /api/clio/projects/:idOrName renames a project", async () => {
    const app = createApp();
    await app.request("/api/clio/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "old-name", description: "x" }),
    });
    const res = await app.request("/api/clio/projects/old-name", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "new-name", description: "y" }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.name).toBe("new-name");
    expect(updated.description).toBe("y");
  });

  it("PATCH returns 404 for unknown project", async () => {
    const app = createApp();
    const res = await app.request("/api/clio/projects/no-such", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("PATCH returns 409 when renaming to a colliding name", async () => {
    const app = createApp();
    await app.request("/api/clio/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "alpha" }),
    });
    await app.request("/api/clio/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "beta" }),
    });
    const res = await app.request("/api/clio/projects/alpha", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "beta" }),
    });
    expect(res.status).toBe(409);
  });

  it("DELETE /api/clio/projects/:idOrName deletes an empty project", async () => {
    const app = createApp();
    await app.request("/api/clio/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "to-delete" }),
    });
    const res = await app.request("/api/clio/projects/to-delete", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
  });

  it("DELETE returns 409 when documents still belong to the project", async () => {
    const app = createApp();
    await app.request("/api/clio/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "occupied" }),
    });
    await app.request("/api/clio/ingest", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "occupied", title: "x", content: "# H\n\nbody" }),
    });
    const res = await app.request("/api/clio/projects/occupied", { method: "DELETE" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/document/i);
  });

  it("DELETE returns 404 for unknown project", async () => {
    const app = createApp();
    const res = await app.request("/api/clio/projects/no-such", { method: "DELETE" });
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

  it("GET /api/clio/search defaults to doc-level (Cerefox parity, 5.12)", async () => {
    const app = createApp();
    // Two docs both containing 'auth'; chunk-level would surface
    // multiple hits per doc. Default doc-level dedup returns one row
    // per doc.
    await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "p1", title: "Auth long-form",
        content: "# auth\n\nauth here\n\n## section\n\nauth there too\n\n## section\n\nauth everywhere",
      }),
    });
    await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "p1", title: "Auth notes",
        content: "# notes\n\nshort auth note",
      }),
    });

    const res = await app.request("/api/clio/search?q=auth");
    expect(res.status).toBe(200);
    const body = await res.json();
    // Doc-level shape: hits has documentId + bestScore + matchingChunks + versionCount.
    expect(body.hits.length).toBe(2);
    expect(body.totalDocuments).toBe(2);
    expect(body.hits[0]).toHaveProperty("matchingChunks");
    expect(body.hits[0]).toHaveProperty("versionCount");
    expect(body.hits[0]).toHaveProperty("bestScore");

    // ?by=chunk falls back to chunk-level (legacy).
    const byChunk = await app.request("/api/clio/search?q=auth&by=chunk");
    expect(byChunk.status).toBe(200);
    const chunkBody = await byChunk.json();
    expect(chunkBody.hits[0]).toHaveProperty("chunkId");
    expect(chunkBody.hits[0]).toHaveProperty("score");
    expect(chunkBody.hits[0]).not.toHaveProperty("bestScore");
    // chunk-level should have ≥ doc-level hits since the long-form doc has multiple matches.
    expect(chunkBody.hits.length).toBeGreaterThanOrEqual(body.hits.length);
  });

  it("GET /api/clio/search Cerefox-parity knobs (alpha + small_doc_threshold + context_window)", async () => {
    const app = createApp();
    await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "p1", title: "doc", content: "auth content" }),
    });
    // Valid values pass.
    expect((await app.request("/api/clio/search?q=auth&alpha=0.7")).status).toBe(200);
    expect((await app.request("/api/clio/search?q=auth&small_doc_threshold=0")).status).toBe(200);
    expect((await app.request("/api/clio/search?q=auth&context_window=2")).status).toBe(200);
    // Invalid → 400 with a specific error.
    expect((await app.request("/api/clio/search?q=auth&alpha=2")).status).toBe(400);
    expect((await app.request("/api/clio/search?q=auth&alpha=-0.1")).status).toBe(400);
    expect((await app.request("/api/clio/search?q=auth&small_doc_threshold=-1")).status).toBe(400);
    expect((await app.request("/api/clio/search?q=auth&context_window=-1")).status).toBe(400);
  });

  it("GET /api/clio/search?by=invalid → 400", async () => {
    const app = createApp();
    const res = await app.request("/api/clio/search?q=auth&by=oops");
    expect(res.status).toBe(400);
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

  it("POST /api/clio/ingest with documentId omits title → server preserves existing (5.11 follow-up)", async () => {
    const app = createApp();
    const created = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "p1", title: "Original Title", content: "v0",
        author: "claude-code",
      }),
    });
    const { id } = await created.json();

    // No title in the body -- this used to be rejected at the route level
    // with "project, title, and content are required". Now the route
    // allows it for documentId updates and the backend preserves the
    // existing title.
    const updated = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "p1", content: "v1 body", documentId: id,
      }),
    });
    expect(updated.status).toBe(200);
    const body = await updated.json();
    expect(body.action).toBe("updated");
    expect(body.document.title).toBe("Original Title"); // preserved
    expect(body.document.author).toBe("claude-code");   // preserved
  });

  it("POST /api/clio/ingest WITHOUT documentId AND without title → 400", async () => {
    const app = createApp();
    const res = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "p1", content: "body" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/title is required/);
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

  // ── 5.11 follow-up: soft-delete + restore ──────────────────────────
  it("GET /api/clio/documents?deleted_only=true returns only tombstones", async () => {
    const app = createApp();
    const live = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "p1", title: "live", content: "live body" }),
    });
    const dead = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "p1", title: "dead", content: "dead body" }),
    });
    const { id: deadId } = await dead.json();
    await live.json();
    await app.request(`/api/clio/documents/${deadId}`, { method: "DELETE" });

    // Default: live only.
    const def = await app.request("/api/clio/documents");
    expect((await def.json()).documents.map((d: { title: string }) => d.title)).toEqual(["live"]);

    // Include: both.
    const inc = await app.request("/api/clio/documents?include_deleted=true");
    expect((await inc.json()).documents.map((d: { title: string }) => d.title).sort()).toEqual(["dead", "live"]);

    // Only: just tombstones.
    const only = await app.request("/api/clio/documents?deleted_only=true");
    expect((await only.json()).documents.map((d: { title: string }) => d.title)).toEqual(["dead"]);
  });

  it("DELETE /api/clio/documents/:id soft-deletes + GET /content excludes it", async () => {
    const app = createApp();
    const r = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "p1", title: "ToDelete", content: "body" }),
    });
    const { id } = await r.json();

    const del = await app.request(`/api/clio/documents/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const delBody = await del.json();
    expect(delBody.deleted).toBe(true);

    // Search excludes it.
    const search = await app.request("/api/clio/search?q=body");
    const searchBody = await search.json();
    expect(searchBody.hits.length).toBe(0);

    // Default list excludes it.
    const list = await app.request("/api/clio/documents");
    const listBody = await list.json();
    expect(listBody.documents.length).toBe(0);

    // Explicit include surfaces it.
    const listAll = await app.request("/api/clio/documents?include_deleted=true");
    const listAllBody = await listAll.json();
    expect(listAllBody.documents.length).toBe(1);
  });

  it("DELETE /api/clio/documents/:id is idempotent + 404s for unknown", async () => {
    const app = createApp();
    const r = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "p1", title: "X", content: "body" }),
    });
    const { id } = await r.json();

    const first = await app.request(`/api/clio/documents/${id}`, { method: "DELETE" });
    expect(first.status).toBe(200);
    const second = await app.request(`/api/clio/documents/${id}`, { method: "DELETE" });
    expect(second.status).toBe(200);

    const bogus = await app.request(`/api/clio/documents/00000000-0000-4000-8000-000000000000`, { method: "DELETE" });
    expect(bogus.status).toBe(404);
  });

  // ── 6.18 round-4: purge endpoint + include_deleted on search ────────
  it("POST /api/clio/documents/:id/purge refuses on a live doc; succeeds after soft-delete; cascade + audit row survives", async () => {
    const app = createApp();
    const r = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "p1", title: "ToPurge", content: "body" }),
    });
    const { id } = await r.json();

    // Refuses on live.
    const live = await app.request(`/api/clio/documents/${id}/purge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor: "user|cli|test" }),
    });
    expect(live.status).toBe(400);
    expect((await live.json()).error).toMatch(/not soft-deleted/i);

    // Soft-delete first, then purge.
    await app.request(`/api/clio/documents/${id}`, { method: "DELETE" });
    const purge = await app.request(`/api/clio/documents/${id}/purge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor: "user|cli|test" }),
    });
    expect(purge.status).toBe(200);
    expect((await purge.json()).purged).toBe(true);

    // Doc gone for good.
    const gone = await app.request(`/api/clio/documents/${id}`);
    expect(gone.status).toBe(404);

    // Even with include_deleted/deleted_only, the doc is gone.
    const trash = await app.request(`/api/clio/documents?deleted_only=true`);
    expect((await trash.json()).documents.length).toBe(0);

    // Audit row for the purge survives.
    const audit = await app.request(`/api/clio/audit-log?document_id=${id}`);
    const auditBody = await audit.json();
    const purgeRow = (auditBody.entries as { eventType: string }[]).find(
      (e) => e.eventType === "purge",
    );
    expect(purgeRow).toBeDefined();
  });

  it("POST /api/clio/documents/:id/purge returns 404 when doc doesn't exist (with user actor)", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/clio/documents/00000000-0000-4000-8000-000000000000/purge`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor: "user|cli|test" }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("POST /api/clio/documents/:id/purge refuses a non-user actor (agent / default body)", async () => {
    const app = createApp();
    const ing = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "p1", title: "Hold on", content: "body" }),
    });
    const { id } = await ing.json();
    await app.request(`/api/clio/documents/${id}`, { method: "DELETE" });

    // Empty body → backend defaults to "agent" → blocked.
    const noActor = await app.request(`/api/clio/documents/${id}/purge`, { method: "POST" });
    expect(noActor.status).toBe(400);
    expect((await noActor.json()).error).toMatch(/not a user actor/i);

    // Agent role stamp → also blocked.
    const agentActor = await app.request(`/api/clio/documents/${id}/purge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor: "dev|claude-code|sonnet" }),
    });
    expect(agentActor.status).toBe(400);
    expect((await agentActor.json()).error).toMatch(/not a user actor/i);

    // Doc remains in the trash, not purged.
    const trash = await app.request(`/api/clio/documents?deleted_only=true`);
    expect((await trash.json()).documents.length).toBe(1);
  });

  it("GET /api/clio/search?include_deleted=true surfaces deleted hits with deletedAt set", async () => {
    const app = createApp();
    const ing = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "p1", title: "Findme", content: "# x\nsearchable phrase" }),
    });
    const { id } = await ing.json();
    await app.request(`/api/clio/documents/${id}`, { method: "DELETE" });

    // Default search excludes.
    const live = await app.request("/api/clio/search?q=searchable");
    expect((await live.json()).hits.length).toBe(0);

    // include_deleted=true surfaces it.
    const all = await app.request("/api/clio/search?q=searchable&include_deleted=true");
    const body = await all.json();
    expect(body.hits.length).toBeGreaterThan(0);
    const hit = body.hits[0];
    expect(hit.documentId).toBe(id);
    expect(typeof hit.deletedAt).toBe("string");
  });

  // ── 5.12: metadata-search + metadata-keys + author surfaced ────────
  it("POST /api/clio/metadata-search filters by metadata + updatedSince", async () => {
    const app = createApp();
    for (const [title, role] of [["a", "reflection"], ["b", "dev"], ["c", "reflection"]] as const) {
      await app.request("/api/clio/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: "p1", title, content: `body ${title}`, metadata: { role },
        }),
      });
    }
    const res = await app.request("/api/clio/metadata-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ metadataFilter: { role: "reflection" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.documents.length).toBe(2);
    expect(body.metadataFilter).toEqual({ role: "reflection" });
  });

  it("POST /api/clio/metadata-search rejects missing metadataFilter", async () => {
    const app = createApp();
    const res = await app.request("/api/clio/metadata-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/clio/metadata-keys aggregates keys + samples", async () => {
    const app = createApp();
    await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "p1", title: "x", content: "body",
        metadata: { role: "reflection", tier: "semantic" },
      }),
    });
    await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "p1", title: "y", content: "body 2",
        metadata: { role: "dev" },
      }),
    });
    const res = await app.request("/api/clio/metadata-keys");
    expect(res.status).toBe(200);
    const { keys } = await res.json();
    const keyNames = keys.map((k: { key: string }) => k.key).sort();
    expect(keyNames).toContain("role");
    expect(keyNames).toContain("tier");
  });

  it("GET /api/clio/search hits include docAuthor", async () => {
    const app = createApp();
    await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "p1", title: "Author surfaces", content: "findable",
        author: "claude-code",
      }),
    });
    const res = await app.request("/api/clio/search?q=findable");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hits[0].docAuthor).toBe("claude-code");
  });

  // ── 5.13: audit log ────────────────────────────────────────────────
  it("GET /api/clio/audit-log returns mutation events newest-first", async () => {
    const app = createApp();
    const r = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "p1", title: "audited", content: "v0", author: "test",
      }),
    });
    const { id } = await r.json();
    await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "p1", title: "audited", content: "v1", documentId: id, author: "test",
      }),
    });

    const log = await app.request("/api/clio/audit-log");
    expect(log.status).toBe(200);
    const { entries } = await log.json();
    expect(entries.map((e: { eventType: string }) => e.eventType)).toEqual([
      "update-content", "create",
    ]);
  });

  it("GET /api/clio/audit-log filters by event_type + actor + document_id", async () => {
    const app = createApp();
    const ingest = (title: string, author: string) =>
      app.request("/api/clio/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: "p1", title, content: title + " body", author }),
      });
    await ingest("a", "alice");
    await ingest("b", "bob");

    const aliceOnly = await app.request("/api/clio/audit-log?actor=alice");
    const aliceBody = await aliceOnly.json();
    expect(aliceBody.entries.length).toBe(1);
    expect(aliceBody.entries[0].actor).toBe("alice");

    const createsOnly = await app.request("/api/clio/audit-log?event_type=create");
    const createsBody = await createsOnly.json();
    expect(createsBody.entries.length).toBe(2);

    const bogus = await app.request("/api/clio/audit-log?event_type=invalid");
    expect(bogus.status).toBe(400);
  });

  it("POST /api/clio/documents/:id/restore restores; idempotent on already-live", async () => {
    const app = createApp();
    const r = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "p1", title: "Restorable", content: "body" }),
    });
    const { id } = await r.json();

    await app.request(`/api/clio/documents/${id}`, { method: "DELETE" });
    const restore = await app.request(`/api/clio/documents/${id}/restore`, { method: "POST" });
    expect(restore.status).toBe(200);
    const body = await restore.json();
    expect(body.restored).toBe(true);

    // Now live again.
    const list = await app.request("/api/clio/documents");
    const listBody = await list.json();
    expect(listBody.documents.length).toBe(1);

    // Idempotent: restoring an already-live doc returns restored=false.
    const noop = await app.request(`/api/clio/documents/${id}/restore`, { method: "POST" });
    expect(noop.status).toBe(200);
    const noopBody = await noop.json();
    expect(noopBody.restored).toBe(false);

    // 404 for unknown doc.
    const bogus = await app.request(`/api/clio/documents/00000000-0000-4000-8000-000000000000/restore`, { method: "POST" });
    expect(bogus.status).toBe(404);
  });

  // ── 5.13 follow-up: PATCH /api/clio/documents/:id (metadata-only edit) ──
  it("PATCH /api/clio/documents/:id edits title + metadata; updated=true", async () => {
    const app = createApp();
    const r = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "p1", title: "Old", content: "body",
        metadata: { role: "spec", draft: true },
      }),
    });
    const { id } = await r.json();

    const edit = await app.request(`/api/clio/documents/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title:        "New",
        metadataSet:  { reviewed_by: "fotis" },
        metadataUnset: ["draft"],
        actor:        "claude-code",
      }),
    });
    expect(edit.status).toBe(200);
    const body = await edit.json();
    expect(body.updated).toBe(true);
    expect(body.document.title).toBe("New");
    expect(body.document.metadata).toEqual({ role: "spec", reviewed_by: "fotis" });
  });

  it("PATCH /api/clio/documents/:id moves doc between projects via projectName", async () => {
    const app = createApp();
    await app.request("/api/clio/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "dst" }),
    });
    const r = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "p1", title: "Travelling", content: "body" }),
    });
    const { id } = await r.json();

    const edit = await app.request(`/api/clio/documents/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectName: "dst" }),
    });
    expect(edit.status).toBe(200);
    const body = await edit.json();
    expect(body.updated).toBe(true);

    // Now in 'dst', not 'p1'.
    const dstList = await app.request("/api/clio/documents?project=dst");
    expect((await dstList.json()).documents.map((d: { id: string }) => d.id)).toContain(id);
  });

  it("PATCH /api/clio/documents/:id 404s for unknown doc", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/clio/documents/00000000-0000-4000-8000-000000000000`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Whatever" }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("PATCH /api/clio/documents/:id 400s on unknown projectName", async () => {
    const app = createApp();
    const r = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "p1", title: "X", content: "body" }),
    });
    const { id } = await r.json();
    const res = await app.request(`/api/clio/documents/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectName: "no-such-project" }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH /api/clio/documents/:id no-op returns updated=false (no audit row)", async () => {
    const app = createApp();
    const r = await app.request("/api/clio/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "p1", title: "Steady", content: "body", author: "fotis" }),
    });
    const { id } = await r.json();
    const edit = await app.request(`/api/clio/documents/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Steady", author: "fotis" }),
    });
    expect(edit.status).toBe(200);
    const body = await edit.json();
    expect(body.updated).toBe(false);

    const audit = await app.request(`/api/clio/audit-log?event_type=edit-metadata&document_id=${id}`);
    expect((await audit.json()).entries.length).toBe(0);
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
