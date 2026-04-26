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
  it("allInProject=true re-keys every doc in the old Project", async () => {
    const clio = makeClio();
    const a = await clio.createProject({ name: "src-project" });
    const b = await clio.createProject({ name: "dst-project" });

    // Use unique content strings to avoid dedup collapse across docs.
    await clio.ingest({ project: "src-project", title: "A", content: "# A\n\nalpha content alpha" });
    await clio.ingest({ project: "src-project", title: "B", content: "# B\n\nbeta content beta" });
    await clio.ingest({ project: "src-project", title: "C", content: "# C\n\ngamma content gamma" });

    const moved = await clio.migrateDocumentsBetweenProjects(a.id, b.id, { allInProject: true });
    expect(moved).toBe(3);

    const srcList = await clio.listProjects();
    const srcCount = srcList.find((p) => p.id === a.id)?.documentCount ?? -1;
    const dstCount = srcList.find((p) => p.id === b.id)?.documentCount ?? -1;
    expect(srcCount).toBe(0);
    expect(dstCount).toBe(3);
    await clio.close();
  });

  it("workspaceId filter moves only that workspace's docs, leaving siblings alone", async () => {
    const clio = makeClio();
    const src = await clio.createProject({ name: "src-p" });
    const dst = await clio.createProject({ name: "dst-p" });

    // Three docs tagged to workspace ws-A, two to ws-B. All in src-p.
    await clio.ingest({
      project: "src-p", title: "A1",
      content: "# A1\n\nalpha content",
      metadata: { workspace_id: "ws-A" },
    });
    await clio.ingest({
      project: "src-p", title: "A2",
      content: "# A2\n\nalpha 2 content",
      metadata: { workspace_id: "ws-A" },
    });
    await clio.ingest({
      project: "src-p", title: "A3",
      content: "# A3\n\nalpha 3 content",
      metadata: { workspace_id: "ws-A" },
    });
    await clio.ingest({
      project: "src-p", title: "B1",
      content: "# B1\n\nbeta content",
      metadata: { workspace_id: "ws-B" },
    });
    await clio.ingest({
      project: "src-p", title: "B2",
      content: "# B2\n\nbeta 2 content",
      metadata: { workspace_id: "ws-B" },
    });

    const moved = await clio.migrateDocumentsBetweenProjects(src.id, dst.id, { workspaceId: "ws-A" });
    expect(moved).toBe(3);

    const after = await clio.listProjects();
    const srcCount = after.find((p) => p.id === src.id)?.documentCount ?? -1;
    const dstCount = after.find((p) => p.id === dst.id)?.documentCount ?? -1;
    // ws-B docs still in src (2), ws-A docs in dst (3).
    expect(srcCount).toBe(2);
    expect(dstCount).toBe(3);
    await clio.close();
  });

  it("refuses to run when neither workspaceId nor allInProject is set", async () => {
    const clio = makeClio();
    const src = await clio.createProject({ name: "s" });
    const dst = await clio.createProject({ name: "d" });
    // Pass an empty opts object explicitly (the TS signature allows it
    // but the runtime guard refuses to proceed without at least one
    // scoping flag).
    await expect(clio.migrateDocumentsBetweenProjects(src.id, dst.id, {})).rejects.toThrow(/workspaceId or allInProject/);
    await clio.close();
  });

  it("is a noop when from === to", async () => {
    const clio = makeClio();
    const p = await clio.createProject({ name: "p1" });
    const moved = await clio.migrateDocumentsBetweenProjects(p.id, p.id, { allInProject: true });
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

// ── Item 5.11: update-doc API + versioning ─────────────────────────────────

describe("LocalClio.ingest -- update by document_id (5.11)", () => {
  it("snapshots the prior content, replaces chunks, returns action='updated'", async () => {
    const clio = makeClio();
    const v0 = await clio.ingest({ project: "p1", title: "Doc A", content: "original body v0" });
    expect(v0.action).toBe("created");

    const v1 = await clio.ingest({
      project: "p1",
      title: "Doc A (renamed)",
      content: "rewritten body v1",
      documentId: v0.id,
      author: "claude-code",
    });

    expect(v1.action).toBe("updated");
    expect(v1.id).toBe(v0.id);                         // same doc, same UUID
    expect(v1.versionId).toBeTruthy();                 // a snapshot row exists
    expect(v1.versionNumber).toBe(1);
    expect(v1.document.title).toBe("Doc A (renamed)"); // title gets re-written too
    expect(v1.document.contentHash).not.toBe(v0.document.contentHash);

    // Live content reads back as the new version.
    const live = await clio.getDocumentContent(v0.id);
    expect(live).toBeTruthy();
    expect(live!.content).toContain("rewritten body v1");
    expect(live!.versionId).toBeNull();

    // Archived content reads back via the version_id.
    const archived = await clio.getDocumentContent(v0.id, { versionId: v1.versionId! });
    expect(archived).toBeTruthy();
    expect(archived!.content).toContain("original body v0");
    expect(archived!.versionId).toBe(v1.versionId!);

    await clio.close();
  });

  it("errors when document_id does not exist", async () => {
    const clio = makeClio();
    await expect(
      clio.ingest({
        project: "p1",
        title: "x",
        content: "body",
        documentId: "00000000-0000-4000-8000-000000000000",
      }),
    ).rejects.toThrow(/not found/);
    await clio.close();
  });

  it("errors when document_id points at a soft-deleted doc", async () => {
    // Schema-level deletion (no public soft-delete API yet; 5.11 only
    // exposes the read-side filter). We simulate by writing deleted_at
    // directly, exercising the same code path 5.13's DELETE endpoint
    // will hit.
    const clio = makeClio();
    const r = await clio.ingest({ project: "p1", title: "Doomed", content: "rip" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (clio as any).db.run(
      `UPDATE clio_documents SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      [r.id],
    );
    await expect(
      clio.ingest({ project: "p1", title: "x", content: "body", documentId: r.id }),
    ).rejects.toThrow(/not found/);
    await clio.close();
  });

  it("documentId wins over updateIfExists; surfaces a note", async () => {
    const clio = makeClio();
    const v0 = await clio.ingest({ project: "p1", title: "Both flags", content: "v0" });
    const v1 = await clio.ingest({
      project: "p1",
      title: "Both flags",
      content: "v1",
      documentId: v0.id,
      updateIfExists: true,
    });
    expect(v1.action).toBe("updated");
    expect(v1.note).toMatch(/documentId provided/);
    await clio.close();
  });

  it("chained updates increment version_number sequentially", async () => {
    const clio = makeClio();
    const v0 = await clio.ingest({ project: "p1", title: "Chain", content: "v0" });

    const v1 = await clio.ingest({
      project: "p1", title: "Chain", content: "v1", documentId: v0.id,
    });
    const v2 = await clio.ingest({
      project: "p1", title: "Chain", content: "v2", documentId: v0.id,
    });
    const v3 = await clio.ingest({
      project: "p1", title: "Chain", content: "v3", documentId: v0.id,
    });

    expect(v1.versionNumber).toBe(1);
    expect(v2.versionNumber).toBe(2);
    expect(v3.versionNumber).toBe(3);

    const versions = await clio.listDocumentVersions(v0.id);
    expect(versions.map((v) => v.versionNumber)).toEqual([3, 2, 1]); // newest first

    // Each archived version recovers its own content.
    const c1 = await clio.getDocumentContent(v0.id, { versionId: v1.versionId! });
    const c2 = await clio.getDocumentContent(v0.id, { versionId: v2.versionId! });
    const c3 = await clio.getDocumentContent(v0.id, { versionId: v3.versionId! });
    expect(c1!.content).toContain("v0");
    expect(c2!.content).toContain("v1");
    expect(c3!.content).toContain("v2");

    // Live = v3.
    const live = await clio.getDocumentContent(v0.id);
    expect(live!.content).toContain("v3");
    await clio.close();
  });
});

describe("LocalClio.ingest -- update by title (updateIfExists, 5.11)", () => {
  it("matches by title within the same Project + updates in place", async () => {
    const clio = makeClio();
    const v0 = await clio.ingest({ project: "p1", title: "By title", content: "v0" });

    const v1 = await clio.ingest({
      project: "p1",
      title: "By title",          // same title in same Project
      content: "v1",
      updateIfExists: true,
    });

    expect(v1.action).toBe("updated");
    expect(v1.id).toBe(v0.id);
    expect(v1.versionNumber).toBe(1);

    // No second doc was created.
    const docs = await clio.listDocuments({ project: "p1" });
    expect(docs.length).toBe(1);
    await clio.close();
  });

  it("does NOT match across Projects (each Project's namespace is independent)", async () => {
    const clio = makeClio();
    const inP1 = await clio.ingest({ project: "p1", title: "Cross", content: "p1-body" });
    const inP2 = await clio.ingest({
      project: "p2",
      title: "Cross",                // same title, different Project
      content: "p2-body",
      updateIfExists: true,
    });
    expect(inP2.action).toBe("created");
    expect(inP2.id).not.toBe(inP1.id);
    await clio.close();
  });

  it("falls through to create when no title match exists", async () => {
    const clio = makeClio();
    const r = await clio.ingest({
      project: "p1",
      title: "Brand new",
      content: "body",
      updateIfExists: true,
    });
    expect(r.action).toBe("created");
    await clio.close();
  });

  it("excludes soft-deleted matches; falls through to create", async () => {
    const clio = makeClio();
    const v0 = await clio.ingest({ project: "p1", title: "Deleted match", content: "v0" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (clio as any).db.run(
      `UPDATE clio_documents SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      [v0.id],
    );
    const v1 = await clio.ingest({
      project: "p1",
      title: "Deleted match",
      content: "v1",
      updateIfExists: true,
    });
    expect(v1.action).toBe("created");
    expect(v1.id).not.toBe(v0.id);
    await clio.close();
  });
});

describe("LocalClio.ingest -- create-path dedup unchanged (5.11)", () => {
  it("returns action='skipped' for byte-identical content (PR1 behaviour preserved)", async () => {
    const clio = makeClio();
    const a = await clio.ingest({ project: "p1", title: "Same", content: "identical body" });
    const b = await clio.ingest({ project: "p1", title: "Same", content: "identical body" });
    expect(b.action).toBe("skipped");
    expect(b.created).toBe(false);          // legacy flag still works
    expect(b.id).toBe(a.id);
    await clio.close();
  });

  it("after migration 0003: two docs with the same hash can coexist (no UNIQUE violation)", async () => {
    // Reachable when an update reassigns doc A's hash to match doc B's
    // current hash. Schema must not block.
    const clio = makeClio();
    const a = await clio.ingest({ project: "p1", title: "A", content: "shared body" });
    const b = await clio.ingest({ project: "p1", title: "B", content: "different body" });
    // Update b to have a's content. Without 0003 this would fire UNIQUE.
    const updated = await clio.ingest({
      project: "p1", title: "B", content: "shared body", documentId: b.id,
    });
    expect(updated.action).toBe("updated");
    // Both a and b now have identical hashes; both are still readable.
    const aDoc = await clio.getDocument(a.id);
    const bDoc = await clio.getDocument(b.id);
    expect(aDoc!.contentHash).toBe(bDoc!.contentHash);
    await clio.close();
  });
});

describe("LocalClio.findDocumentByTitle / listDocumentVersions / getDocumentContent (5.11)", () => {
  it("findDocumentByTitle returns null for unknown title", async () => {
    const clio = makeClio();
    const proj = await clio.createProject({ name: "p1" });
    expect(await clio.findDocumentByTitle(proj.id, "nope")).toBeNull();
    await clio.close();
  });

  it("listDocumentVersions returns [] for never-updated docs", async () => {
    const clio = makeClio();
    const r = await clio.ingest({ project: "p1", title: "Fresh", content: "body" });
    expect(await clio.listDocumentVersions(r.id)).toEqual([]);
    await clio.close();
  });

  it("getDocumentContent returns null for unknown document", async () => {
    const clio = makeClio();
    expect(await clio.getDocumentContent("00000000-0000-4000-8000-000000000000")).toBeNull();
    await clio.close();
  });

  it("getDocumentContent({ versionId }) returns null when version doesn't belong to that doc", async () => {
    const clio = makeClio();
    const r = await clio.ingest({ project: "p1", title: "T", content: "body" });
    expect(
      await clio.getDocumentContent(r.id, { versionId: "00000000-0000-4000-8000-000000000000" }),
    ).toBeNull();
    await clio.close();
  });

  it("ensures FTS index drops archived chunks (search returns only live content)", async () => {
    const clio = makeClio();
    const v0 = await clio.ingest({
      project: "p1",
      title: "Versioned search",
      content: "# Original\n\nstrawberry shortcake recipe",
    });
    await clio.ingest({
      project: "p1",
      title: "Versioned search",
      content: "# Updated\n\nblueberry pancake recipe",
      documentId: v0.id,
    });

    const strawberry = await clio.search({ query: "strawberry" });
    expect(strawberry.hits.length).toBe(0);   // archived; not in FTS
    const blueberry = await clio.search({ query: "blueberry" });
    expect(blueberry.hits.length).toBeGreaterThan(0); // live; in FTS
    await clio.close();
  });
});
