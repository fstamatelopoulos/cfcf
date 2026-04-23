/**
 * Tests for LocalClio (FTS5-only search backend).
 *
 * End-to-end from ingest → search → get, against a temp SQLite DB.
 */

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LocalClio } from "./local-clio.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "cfcf-clio-local-test-"));
});

afterEach(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeClio(): LocalClio {
  return new LocalClio({ path: join(tempDir, "clio.db") });
}

describe("LocalClio.projects", () => {
  it("listProjects is empty for a fresh DB", async () => {
    const clio = makeClio();
    expect(await clio.listProjects()).toEqual([]);
    await clio.close();
  });

  it("createProject + getProject (by name + by id)", async () => {
    const clio = makeClio();
    const created = await clio.createProject({ name: "cf-ecosystem", description: "cf², Clio, Cerefox" });
    expect(created.name).toBe("cf-ecosystem");
    expect(created.description).toBe("cf², Clio, Cerefox");
    expect(created.documentCount).toBe(0);

    const byName = await clio.getProject("cf-ecosystem");
    expect(byName?.id).toBe(created.id);

    const byId = await clio.getProject(created.id);
    expect(byId?.name).toBe("cf-ecosystem");
    await clio.close();
  });

  it("createProject is case-insensitive on name uniqueness", async () => {
    const clio = makeClio();
    await clio.createProject({ name: "MyProj" });
    await expect(clio.createProject({ name: "myproj" })).rejects.toThrow();
    await clio.close();
  });

  it("resolveProject auto-creates when missing and createIfMissing is true", async () => {
    const clio = makeClio();
    const p = await clio.resolveProject("default", { createIfMissing: true });
    expect(p.name).toBe("default");
    // Second call returns the same project (no duplicate).
    const again = await clio.resolveProject("default", { createIfMissing: true });
    expect(again.id).toBe(p.id);
    await clio.close();
  });

  it("resolveProject refuses to auto-create from a UUID", async () => {
    const clio = makeClio();
    await expect(
      clio.resolveProject("00000000-0000-4000-8000-000000000000", { createIfMissing: true }),
    ).rejects.toThrow(/refusing to auto-create/);
    await clio.close();
  });

  it("listProjects returns document_count = 0 initially, and updates after ingest", async () => {
    const clio = makeClio();
    await clio.createProject({ name: "cf-ecosystem" });
    let list = await clio.listProjects();
    expect(list[0].documentCount).toBe(0);

    await clio.ingest({
      project: "cf-ecosystem",
      title: "Note",
      content: "# Note\n\nSome interesting content.",
    });
    list = await clio.listProjects();
    expect(list[0].documentCount).toBe(1);
    await clio.close();
  });
});

describe("LocalClio.ingest", () => {
  it("ingests a document + splits into chunks", async () => {
    const clio = makeClio();
    const big = Array.from({ length: 30 }, (_, i) => `## Section ${i}\n\n` + "X".repeat(400)).join("\n\n");
    const result = await clio.ingest({
      project: "cf-ecosystem",
      title: "Big doc",
      content: big,
      source: "test",
      metadata: { role: "dev", artifact_type: "iteration-log" },
    });
    expect(result.created).toBe(true);
    expect(result.chunksInserted).toBeGreaterThan(1);
    expect(result.document.title).toBe("Big doc");
    expect(result.document.metadata.role).toBe("dev");
    await clio.close();
  });

  it("auto-routes to the named project (creates it if missing)", async () => {
    const clio = makeClio();
    const r = await clio.ingest({
      project: "default",
      title: "Auto-routed",
      content: "short content",
    });
    expect(r.created).toBe(true);
    const projects = await clio.listProjects();
    expect(projects.map((p) => p.name)).toContain("default");
    await clio.close();
  });

  it("dedups by content_hash (same content + same title twice)", async () => {
    const clio = makeClio();
    const content = "# Dedup test\n\nSame content body.";
    const first = await clio.ingest({ project: "p1", title: "Dedup test", content });
    const second = await clio.ingest({ project: "p1", title: "Dedup test", content });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(second.chunksInserted).toBe(0);
    await clio.close();
  });

  it("dedups across different Projects (content_hash is global)", async () => {
    const clio = makeClio();
    const content = "# Cross-project dedup\n\nSame body.";
    const first = await clio.ingest({ project: "p1", title: "Cross", content });
    const second = await clio.ingest({ project: "p2", title: "Cross", content });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    // `p2` was auto-created as a project by resolveProject; but the doc is
    // still in p1 (the original). Design choice: dedup wins over reassign.
    expect(second.document.projectId).toBe(first.document.projectId);
    await clio.close();
  });

  it("rejects empty title / empty content", async () => {
    const clio = makeClio();
    await expect(clio.ingest({ project: "p1", title: "", content: "x" })).rejects.toThrow(/title/);
    await expect(clio.ingest({ project: "p1", title: "t", content: "   " })).rejects.toThrow(/content/);
    await clio.close();
  });
});

describe("LocalClio.search (FTS)", () => {
  async function seed(): Promise<LocalClio> {
    const clio = makeClio();
    await clio.ingest({
      project: "cf-ecosystem",
      title: "Auth notes",
      content: "# Authentication\n\nUse real-time yields instead of fake-timers for this race condition in auth flows.",
      metadata: { role: "reflection", artifact_type: "reflection-analysis" },
    });
    await clio.ingest({
      project: "cf-ecosystem",
      title: "Database notes",
      content: "# Database migrations\n\nAlways use transactions for schema changes. Test rollbacks thoroughly.",
      metadata: { role: "dev", artifact_type: "iteration-log" },
    });
    await clio.ingest({
      project: "backend-services",
      title: "API rate limits",
      content: "# Rate limiting\n\nImplement per-user rate limits on authentication endpoints.",
      metadata: { role: "architect", artifact_type: "architect-review" },
    });
    return clio;
  }

  it("keyword search finds documents that contain the term", async () => {
    const clio = await seed();
    const result = await clio.search({ query: "authentication" });
    expect(result.mode).toBe("fts");
    expect(result.hits.length).toBeGreaterThan(0);
    const titles = result.hits.map((h) => h.docTitle);
    expect(titles).toContain("Auth notes");
    await clio.close();
  });

  it("scopes to a Clio Project when --project is set", async () => {
    const clio = await seed();
    const a = await clio.search({ query: "authentication", project: "cf-ecosystem" });
    expect(a.hits.map((h) => h.docTitle)).toContain("Auth notes");
    expect(a.hits.map((h) => h.docTitle)).not.toContain("API rate limits");

    const b = await clio.search({ query: "authentication", project: "backend-services" });
    expect(b.hits.map((h) => h.docTitle)).toContain("API rate limits");
    expect(b.hits.map((h) => h.docTitle)).not.toContain("Auth notes");
    await clio.close();
  });

  it("returns empty when project doesn't exist (no auto-create on search)", async () => {
    const clio = await seed();
    const r = await clio.search({ query: "anything", project: "this-does-not-exist" });
    expect(r.hits).toEqual([]);
    const projects = (await clio.listProjects()).map((p) => p.name);
    expect(projects).not.toContain("this-does-not-exist");
    await clio.close();
  });

  it("filters by metadata (role, artifact_type)", async () => {
    const clio = await seed();
    const r = await clio.search({
      query: "authentication",
      metadata: { role: "reflection" },
    });
    expect(r.hits.map((h) => h.docTitle)).toEqual(["Auth notes"]);
    await clio.close();
  });

  it("combines project + metadata filters", async () => {
    const clio = await seed();
    const r = await clio.search({
      query: "rate",
      project: "backend-services",
      metadata: { role: "architect" },
    });
    expect(r.hits.map((h) => h.docTitle)).toEqual(["API rate limits"]);
    await clio.close();
  });

  it("sanitizes FTS operator characters (user doesn't need to know FTS syntax)", async () => {
    const clio = await seed();
    // The raw query below would break a strict FTS5 MATCH parser.
    const r = await clio.search({ query: 'authentication! (AND) "OR" -ignore' });
    // Should not throw; should still find the auth doc.
    expect(r.hits.map((h) => h.docTitle)).toContain("Auth notes");
    await clio.close();
  });

  it("returns chunk-level hits with heading_path + score", async () => {
    const clio = await seed();
    const r = await clio.search({ query: "authentication" });
    expect(r.hits.length).toBeGreaterThan(0);
    const first = r.hits[0];
    expect(first.chunkId).toBeTruthy();
    expect(first.documentId).toBeTruthy();
    expect(first.chunkIndex).toBeGreaterThanOrEqual(0);
    expect(first.score).toBeGreaterThan(-Infinity);
    expect(Array.isArray(first.headingPath)).toBe(true);
    expect(first.docMetadata).toBeDefined();
    await clio.close();
  });

  it("honors match_count", async () => {
    const clio = makeClio();
    for (let i = 0; i < 20; i++) {
      await clio.ingest({
        project: "p1",
        title: `Doc ${i}`,
        content: `# Doc ${i}\n\nauthentication content item ${i}`,
      });
    }
    const r = await clio.search({ query: "authentication", matchCount: 5 });
    expect(r.hits.length).toBeLessThanOrEqual(5);
    await clio.close();
  });

  it("refuses empty query", async () => {
    const clio = makeClio();
    await expect(clio.search({ query: "" })).rejects.toThrow(/empty/);
    await expect(clio.search({ query: "   " })).rejects.toThrow(/empty/);
    await clio.close();
  });
});

describe("LocalClio.stats", () => {
  it("returns counts + applied migrations", async () => {
    const clio = makeClio();
    await clio.ingest({
      project: "p1",
      title: "Doc",
      content: "# Doc\n\nbody",
    });
    const stats = await clio.stats();
    expect(stats.projectCount).toBe(1);
    expect(stats.documentCount).toBe(1);
    expect(stats.chunkCount).toBeGreaterThanOrEqual(1);
    expect(stats.migrations.length).toBeGreaterThanOrEqual(1);
    expect(stats.migrations[0]).toContain("0001_initial.sql");
    expect(stats.activeEmbedder).toBeNull();
    await clio.close();
  });
});

describe("LocalClio.migrateDocumentsBetweenProjects", () => {
  it("re-keys all docs from one project to another", async () => {
    const clio = makeClio();
    const a = await clio.createProject({ name: "src-project" });
    const b = await clio.createProject({ name: "dst-project" });

    // Use unique content strings to avoid dedup collapse across docs.
    await clio.ingest({ project: "src-project", title: "A", content: "# A\n\nalpha content alpha" });
    await clio.ingest({ project: "src-project", title: "B", content: "# B\n\nbeta content beta" });
    await clio.ingest({ project: "src-project", title: "C", content: "# C\n\ngamma content gamma" });

    const moved = await clio.migrateDocumentsBetweenProjects(a.id, b.id);
    expect(moved).toBe(3);

    const srcList = await clio.listProjects();
    const srcCount = srcList.find((p) => p.id === a.id)?.documentCount ?? -1;
    const dstCount = srcList.find((p) => p.id === b.id)?.documentCount ?? -1;
    expect(srcCount).toBe(0);
    expect(dstCount).toBe(3);
    await clio.close();
  });

  it("is a noop when from === to", async () => {
    const clio = makeClio();
    const p = await clio.createProject({ name: "p1" });
    const moved = await clio.migrateDocumentsBetweenProjects(p.id, p.id);
    expect(moved).toBe(0);
    await clio.close();
  });
});

describe("LocalClio.getDocument", () => {
  it("returns the stored document by id", async () => {
    const clio = makeClio();
    const r = await clio.ingest({
      project: "p1",
      title: "Round trip",
      content: "# Round trip\n\nbody",
      metadata: { x: 1 },
    });
    const doc = await clio.getDocument(r.id);
    expect(doc).toBeTruthy();
    expect(doc!.title).toBe("Round trip");
    expect(doc!.metadata.x).toBe(1);
    await clio.close();
  });

  it("returns null for unknown id", async () => {
    const clio = makeClio();
    expect(await clio.getDocument("no-such-doc")).toBeNull();
    await clio.close();
  });
});
