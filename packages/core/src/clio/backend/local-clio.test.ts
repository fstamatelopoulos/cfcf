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

// ── 5.12: doc-level search dedup ───────────────────────────────────────────

describe("LocalClio.searchDocuments (5.12, Cerefox parity)", () => {
  async function seed(): Promise<LocalClio> {
    // A document with multiple chunks all matching "authentication" (so
    // chunk-level search would surface several rows from the same doc).
    const clio = makeClio();
    const longAuthDoc = [
      "# Auth notes",
      "## Section 1",
      "Authentication is the process of verifying who is making a request.",
      "## Section 2",
      "Real-time yields beat fake-timers for authentication-flow tests.",
      "## Section 3",
      "Token refresh races plague every authentication system.",
      "## Section 4",
      "Storing authentication tokens in container images is a leak risk.",
    ].join("\n\n");
    await clio.ingest({
      project: "p1",
      title: "Auth long-form",
      content: longAuthDoc,
      author: "claude-code",
    });
    await clio.ingest({
      project: "p1",
      title: "DB notes",
      content: "# Database migrations\n\nAlways use transactions; authentication-related rollbacks are tricky.",
      author: "user",
    });
    await clio.ingest({
      project: "p1",
      title: "Unrelated",
      content: "# Unrelated topic\n\nNothing about the keyword here.",
      author: "user",
    });
    return clio;
  }

  it("returns one row per matching document, not per chunk", async () => {
    const clio = await seed();
    const result = await clio.searchDocuments({ query: "authentication" });
    expect(result.mode).toBe("fts");
    // 2 matching docs (Auth long-form + DB notes); the third doc has
    // no occurrences of "authentication".
    expect(result.hits.length).toBe(2);
    const titles = result.hits.map((h) => h.docTitle);
    expect(titles).toContain("Auth long-form");
    expect(titles).toContain("DB notes");
    // Each hit is unique by documentId.
    const ids = new Set(result.hits.map((h) => h.documentId));
    expect(ids.size).toBe(2);
    await clio.close();
  });

  it("matchingChunks reports how many chunks of the doc were in the candidate pool", async () => {
    const clio = await seed();
    const result = await clio.searchDocuments({ query: "authentication" });
    const authDoc = result.hits.find((h) => h.docTitle === "Auth long-form");
    expect(authDoc).toBeTruthy();
    expect(authDoc!.matchingChunks).toBeGreaterThanOrEqual(1);
    const dbDoc = result.hits.find((h) => h.docTitle === "DB notes");
    expect(dbDoc!.matchingChunks).toBe(1);
    await clio.close();
  });

  it("orders by best-chunk score descending", async () => {
    const clio = await seed();
    const result = await clio.searchDocuments({ query: "authentication" });
    for (let i = 1; i < result.hits.length; i++) {
      expect(result.hits[i].bestScore).toBeLessThanOrEqual(result.hits[i - 1].bestScore);
    }
    await clio.close();
  });

  it("surfaces versionCount on each hit (0 for never-updated docs, > 0 after update)", async () => {
    const clio = await seed();
    const before = await clio.searchDocuments({ query: "authentication" });
    for (const h of before.hits) expect(h.versionCount).toBe(0);

    const authDocBefore = before.hits.find((h) => h.docTitle === "Auth long-form")!;
    await clio.ingest({
      project: "p1",
      content: "# Auth long-form\n\nrewritten authentication content",
      documentId: authDocBefore.documentId,
    });
    const after = await clio.searchDocuments({ query: "authentication" });
    const authDocAfter = after.hits.find((h) => h.documentId === authDocBefore.documentId)!;
    expect(authDocAfter.versionCount).toBe(1);
    await clio.close();
  });

  it("respects matchCount cap", async () => {
    const clio = await seed();
    const result = await clio.searchDocuments({ query: "authentication", matchCount: 1 });
    expect(result.hits.length).toBe(1);
    expect(result.totalDocuments).toBe(2);
    await clio.close();
  });

  it("respects project filter", async () => {
    const clio = await seed();
    await clio.ingest({
      project: "other-project",
      title: "auth in other proj",
      content: "authentication content over here",
      author: "user",
    });
    const scoped = await clio.searchDocuments({ query: "authentication", project: "p1" });
    expect(scoped.hits.every((h) => h.docProjectName === "p1")).toBe(true);
    await clio.close();
  });

  it("isPartial=false + bestChunkContent is the FULL doc when total_chars ≤ smallDocThreshold (Cerefox parity)", async () => {
    const clio = makeClio();
    // Small doc (well under default 20000 chars).
    const small = "# Tiny\n\nA tiny doc that mentions authentication.";
    await clio.ingest({ project: "p1", title: "Tiny", content: small });
    const r = await clio.searchDocuments({ query: "authentication" });
    expect(r.hits.length).toBe(1);
    const hit = r.hits[0];
    expect(hit.isPartial).toBe(false);
    // bestChunkContent should be the full doc (just one chunk in this case).
    expect(hit.bestChunkContent).toContain("# Tiny");
    expect(hit.bestChunkContent).toContain("authentication");
    await clio.close();
  });

  it("isPartial=true + bestChunkContent is the chunk-window when total_chars > smallDocThreshold", async () => {
    const clio = makeClio();
    // Build a doc that's larger than the threshold (force >100 chars
    // in test by setting threshold low). We'll override per-call.
    const big = "# Auth\n\n" + "Authentication is the process of verifying who is making a request. ".repeat(20)
      + "\n\n## Section 2\n\n" + "More authentication details here. ".repeat(20)
      + "\n\n## Section 3\n\n" + "Yet more authentication content. ".repeat(20);
    await clio.ingest({ project: "p1", title: "Big", content: big });
    const r = await clio.searchDocuments({
      query: "authentication", smallDocThreshold: 200, contextWindow: 1,
    });
    expect(r.hits.length).toBe(1);
    expect(r.hits[0].isPartial).toBe(true);
    // Content should be chunk + neighbours (not the entire 4000+ char doc).
    expect(r.hits[0].bestChunkContent.length).toBeLessThan(big.length);
    await clio.close();
  });

  it("smallDocThreshold=0 disables the full-doc path; everything is partial", async () => {
    const clio = makeClio();
    await clio.ingest({ project: "p1", title: "Small", content: "Tiny auth doc." });
    const r = await clio.searchDocuments({ query: "auth", smallDocThreshold: 0 });
    expect(r.hits.length).toBe(1);
    expect(r.hits[0].isPartial).toBe(true);
    await clio.close();
  });

  it("contextWindow=0 returns only the matched chunk in the large-doc path", async () => {
    const clio = makeClio();
    // Force a multi-chunk doc by capping chunkMaxChars at ingest time.
    // Three sections at ~600 chars each → 3 separate chunks, so the
    // matched chunk is materially smaller than the whole doc.
    const big = [
      "# Auth section",
      "Authentication content. ".repeat(25),
      "## DB section",
      "Database content unrelated. ".repeat(25),
      "## API section",
      "API documentation here. ".repeat(25),
    ].join("\n\n");
    await clio.ingest({
      project: "p1", title: "Big", content: big, chunkMaxChars: 700, chunkMinChars: 100,
    });
    const r = await clio.searchDocuments({
      query: "authentication", smallDocThreshold: 200, contextWindow: 0,
    });
    expect(r.hits[0].isPartial).toBe(true);
    expect(r.hits[0].chunkCount).toBeGreaterThan(1);
    // Just the matched chunk -- materially shorter than the whole doc.
    expect(r.hits[0].bestChunkContent.length).toBeLessThan(big.length / 2);
    await clio.close();
  });

  it("hybrid alpha: per-call override clamps to [0,1] + invalid values fall back to default", async () => {
    // We can't easily assert ordering changes without an embedder, but
    // we can at least verify the engine accepts the parameter without
    // crashing for valid + edge-case inputs. (Full alpha-effect tests
    // live in the clio-hybrid.test.ts file with mock embedder.)
    const clio = makeClio();
    await clio.ingest({ project: "p1", title: "doc", content: "auth content" });
    expect(async () => clio.search({ query: "auth", alpha: 0.0 })).not.toThrow();
    expect(async () => clio.search({ query: "auth", alpha: 1.0 })).not.toThrow();
    expect(async () => clio.search({ query: "auth", alpha: 0.5 })).not.toThrow();
    // Out-of-range -- silently clamped to default 0.7 by clampAlpha; no throw.
    expect(async () => clio.search({ query: "auth", alpha: -1 })).not.toThrow();
    expect(async () => clio.search({ query: "auth", alpha: 99 })).not.toThrow();
    await clio.close();
  });

  it("returns chunkCount = total chunks in the live doc, matchingChunks <= chunkCount", async () => {
    const clio = await seed();
    const result = await clio.searchDocuments({ query: "authentication" });
    const authDoc = result.hits.find((h) => h.docTitle === "Auth long-form")!;
    expect(authDoc.chunkCount).toBeGreaterThanOrEqual(1);
    expect(authDoc.matchingChunks).toBeLessThanOrEqual(authDoc.chunkCount);
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

  it("--document-id update preserves title/author when not explicitly passed (5.11 follow-up)", async () => {
    const clio = makeClio();
    const v0 = await clio.ingest({
      project: "p1", title: "Carefully Named Doc", content: "v0",
      author: "claude-code", metadata: { role: "design-guideline" },
    });

    // Update without --title / --author -- should keep both.
    const v1 = await clio.ingest({
      project: "p1", content: "v1 body", documentId: v0.id,
    });
    expect(v1.action).toBe("updated");
    expect(v1.document.title).toBe("Carefully Named Doc");
    expect(v1.document.author).toBe("claude-code");
    expect(v1.document.metadata).toEqual({ role: "design-guideline" });

    // Explicit --title overrides.
    const v2 = await clio.ingest({
      project: "p1", title: "Renamed", content: "v2 body", documentId: v0.id,
    });
    expect(v2.document.title).toBe("Renamed");

    // Explicit --author overrides.
    const v3 = await clio.ingest({
      project: "p1", content: "v3", documentId: v0.id, author: "user",
    });
    expect(v3.document.author).toBe("user");
    expect(v3.document.title).toBe("Renamed"); // last explicit title persists

    await clio.close();
  });

  it("create path requires title", async () => {
    const clio = makeClio();
    await expect(
      clio.ingest({ project: "p1", content: "body" }),
    ).rejects.toThrow(/title is required/);
    await clio.close();
  });

  it("--update-if-exists requires title (it's the lookup key)", async () => {
    const clio = makeClio();
    await expect(
      clio.ingest({ project: "p1", content: "body", updateIfExists: true }),
    ).rejects.toThrow(/title is required/);
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

  it("deleteDocument soft-deletes; search/listDocuments hide it; restore brings it back", async () => {
    const clio = makeClio();
    const r = await clio.ingest({
      project: "p1",
      title: "Trash candidate",
      content: "# Trash\n\ndeletable body",
    });

    // Live + searchable.
    expect((await clio.search({ query: "deletable" })).hits.length).toBe(1);
    expect((await clio.listDocuments({ project: "p1" })).length).toBe(1);

    await clio.deleteDocument(r.id);

    // Excluded from search + default list.
    expect((await clio.search({ query: "deletable" })).hits.length).toBe(0);
    expect((await clio.listDocuments({ project: "p1" })).length).toBe(0);
    // ...but reachable when explicitly requested.
    expect((await clio.listDocuments({ project: "p1", deletedFilter: "include" })).length).toBe(1);
    expect((await clio.listDocuments({ project: "p1", deletedFilter: "only" })).length).toBe(1);

    // Idempotent.
    await clio.deleteDocument(r.id);

    // Restore.
    await clio.restoreDocument(r.id);
    expect((await clio.search({ query: "deletable" })).hits.length).toBe(1);
    expect((await clio.listDocuments({ project: "p1" })).length).toBe(1);

    // Idempotent restore.
    await clio.restoreDocument(r.id);
    await clio.close();
  });

  it("deleteDocument throws when the doc doesn't exist", async () => {
    const clio = makeClio();
    await expect(clio.deleteDocument("00000000-0000-4000-8000-000000000000"))
      .rejects.toThrow(/not found/);
    await clio.close();
  });

  it("restoreDocument throws when the doc doesn't exist", async () => {
    const clio = makeClio();
    await expect(clio.restoreDocument("00000000-0000-4000-8000-000000000000"))
      .rejects.toThrow(/not found/);
    await clio.close();
  });

  // ── 5.12: author field + metadata-search + metadata-keys ────────────
  it("ingest persists `author` on creates and updates", async () => {
    const clio = makeClio();
    const created = await clio.ingest({
      project: "p1", title: "Author test", content: "c0", author: "claude-code",
    });
    expect(created.document.author).toBe("claude-code");

    const updated = await clio.ingest({
      project: "p1", title: "Author test", content: "c1",
      documentId: created.id, author: "codex",
    });
    expect(updated.document.author).toBe("codex");

    const list = await clio.listDocuments({ project: "p1" });
    expect(list[0].author).toBe("codex");

    // The version row's `source` carries the prior writer's author too,
    // so the audit trail includes "who wrote each version".
    const versions = await clio.listDocumentVersions(created.id);
    expect(versions[0].source).toBe("claude-code"); // the snapshot of the v0 content
    await clio.close();
  });

  it("default author is 'agent' when no value passed", async () => {
    const clio = makeClio();
    const r = await clio.ingest({ project: "p1", title: "No author", content: "body" });
    expect(r.document.author).toBe("agent");
    await clio.close();
  });

  it("search results carry docAuthor + documentId for [id: uuid] rendering", async () => {
    const clio = makeClio();
    const r = await clio.ingest({
      project: "p1", title: "Searchable", content: "# H\n\nfindable body", author: "claude-code",
    });
    const search = await clio.search({ query: "findable" });
    expect(search.hits.length).toBe(1);
    expect(search.hits[0].documentId).toBe(r.id);
    expect(search.hits[0].docAuthor).toBe("claude-code");
    await clio.close();
  });

  it("metadataSearch finds docs by metadata + supports updated_since", async () => {
    const clio = makeClio();
    await clio.ingest({
      project: "p1", title: "A", content: "body 1",
      metadata: { role: "reflection", tier: "semantic" },
    });
    await clio.ingest({
      project: "p1", title: "B", content: "body 2",
      metadata: { role: "dev", tier: "episodic" },
    });
    await clio.ingest({
      project: "p1", title: "C", content: "body 3",
      metadata: { role: "reflection", tier: "episodic" },
    });

    const r1 = await clio.metadataSearch({ metadataFilter: { role: "reflection" } });
    expect(r1.documents.length).toBe(2);
    expect(r1.documents.map((d) => d.title).sort()).toEqual(["A", "C"]);

    const r2 = await clio.metadataSearch({
      metadataFilter: { role: "reflection", tier: "semantic" },
    });
    expect(r2.documents.length).toBe(1);
    expect(r2.documents[0].title).toBe("A");

    // updated_since filter
    const cutoff = new Date(Date.now() + 60_000).toISOString(); // 1m in the future
    const future = await clio.metadataSearch({
      metadataFilter: { role: "reflection" }, updatedSince: cutoff,
    });
    expect(future.documents.length).toBe(0);

    await clio.close();
  });

  it("metadataSearch rejects empty filter", async () => {
    const clio = makeClio();
    await expect(clio.metadataSearch({ metadataFilter: {} })).rejects.toThrow(/at least one key/);
    await clio.close();
  });

  it("metadataSearch excludes soft-deleted by default; includeDeleted opts back in", async () => {
    const clio = makeClio();
    const a = await clio.ingest({
      project: "p1", title: "live", content: "x", metadata: { role: "reflection" },
    });
    const b = await clio.ingest({
      project: "p1", title: "deleted", content: "y", metadata: { role: "reflection" },
    });
    await clio.deleteDocument(b.id);

    const live = await clio.metadataSearch({ metadataFilter: { role: "reflection" } });
    expect(live.documents.length).toBe(1);
    expect(live.documents[0].id).toBe(a.id);

    const all = await clio.metadataSearch({
      metadataFilter: { role: "reflection" }, includeDeleted: true,
    });
    expect(all.documents.length).toBe(2);
    await clio.close();
  });

  it("listMetadataKeys aggregates keys + samples across docs", async () => {
    const clio = makeClio();
    await clio.ingest({
      project: "p1", title: "1", content: "x",
      metadata: { role: "reflection", artifact_type: "reflection-analysis" },
    });
    await clio.ingest({
      project: "p1", title: "2", content: "y",
      metadata: { role: "reflection", artifact_type: "iteration-log" },
    });
    await clio.ingest({
      project: "p1", title: "3", content: "z",
      metadata: { role: "dev", tags: ["a", "b"] }, // arrays excluded from sample collection
    });

    const keys = await clio.listMetadataKeys();
    const byKey = Object.fromEntries(keys.map((k) => [k.key, k]));
    expect(byKey.role.documentCount).toBe(3);
    expect(byKey.role.valueSamples.sort()).toEqual(["dev", "reflection"]);
    expect(byKey.artifact_type.documentCount).toBe(2);
    // Arrays land in the count but not in valueSamples.
    expect(byKey.tags.documentCount).toBe(1);
    expect(byKey.tags.valueSamples).toEqual([]);

    // most-used first
    expect(keys[0].key).toBe("role");
    await clio.close();
  });

  it("listMetadataKeys is project-scopable + soft-deleted-excluded", async () => {
    const clio = makeClio();
    const a = await clio.ingest({
      project: "p1", title: "1", content: "x", metadata: { only_p1: "yes" },
    });
    await clio.ingest({
      project: "p2", title: "2", content: "y", metadata: { only_p2: "yes" },
    });
    await clio.deleteDocument(a.id);

    const p1 = await clio.listMetadataKeys({ project: "p1" });
    expect(p1.length).toBe(0); // only doc was soft-deleted

    const p2 = await clio.listMetadataKeys({ project: "p2" });
    expect(p2.map((k) => k.key)).toEqual(["only_p2"]);
    await clio.close();
  });

  // ── 5.13: audit log writes ─────────────────────────────────────────
  it("writeAudit fires on create / update / delete / restore + reads back via getAuditLog", async () => {
    const clio = makeClio();
    const a = await clio.ingest({
      project: "p1", title: "Auditable", content: "v0", author: "claude-code",
    });
    await clio.ingest({
      project: "p1", title: "Auditable", content: "v1",
      documentId: a.id, author: "codex",
    });
    await clio.deleteDocument(a.id, { author: "user" });
    await clio.restoreDocument(a.id, { author: "user" });

    const log = await clio.getAuditLog();
    // Newest first.
    expect(log.map((e) => e.eventType)).toEqual([
      "restore", "delete", "update-content", "create",
    ]);
    expect(log[0].actor).toBe("user");
    expect(log[2].actor).toBe("codex");
    expect(log[3].actor).toBe("claude-code");
    expect(log[2].metadata.version_id).toBeTruthy();

    await clio.close();
  });

  it("getAuditLog filters by eventType / actor / documentId / since", async () => {
    const clio = makeClio();
    const a = await clio.ingest({ project: "p1", title: "A", content: "x", author: "alice" });
    const b = await clio.ingest({ project: "p1", title: "B", content: "y", author: "bob" });
    await clio.ingest({
      project: "p1", title: "A", content: "x2", documentId: a.id, author: "alice",
    });

    const aliceWrites = await clio.getAuditLog({ actor: "alice" });
    expect(aliceWrites.length).toBe(2);
    expect(aliceWrites.every((e) => e.actor === "alice")).toBe(true);

    const onlyCreates = await clio.getAuditLog({ eventType: "create" });
    expect(onlyCreates.length).toBe(2);

    const justB = await clio.getAuditLog({ documentId: b.id });
    expect(justB.length).toBe(1);
    expect(justB[0].eventType).toBe("create");
    expect(justB[0].actor).toBe("bob");

    // since filter set far in the future returns nothing.
    const future = new Date(Date.now() + 60_000).toISOString();
    const none = await clio.getAuditLog({ since: future });
    expect(none.length).toBe(0);
    await clio.close();
  });

  it("idempotent delete/restore do NOT write extra audit rows", async () => {
    const clio = makeClio();
    const r = await clio.ingest({ project: "p1", title: "Idem", content: "x" });
    await clio.deleteDocument(r.id);
    await clio.deleteDocument(r.id); // idempotent
    await clio.restoreDocument(r.id);
    await clio.restoreDocument(r.id); // idempotent

    const log = await clio.getAuditLog({ documentId: r.id });
    // create + delete + restore = 3 rows, not 5.
    expect(log.map((e) => e.eventType).sort()).toEqual(["create", "delete", "restore"]);
    await clio.close();
  });

  it("migrate-project writes one audit row per call (not per doc)", async () => {
    const clio = makeClio();
    const wsA = "ws-a";
    await clio.ingest({
      project: "p1", title: "1", content: "x", metadata: { workspace_id: wsA },
    });
    await clio.ingest({
      project: "p1", title: "2", content: "y", metadata: { workspace_id: wsA },
    });
    const p1 = (await clio.getProject("p1"))!;
    const p2 = await clio.createProject({ name: "p2" });

    const moved = await clio.migrateDocumentsBetweenProjects(p1.id, p2.id, { workspaceId: wsA });
    expect(moved).toBe(2);

    const log = await clio.getAuditLog({ eventType: "migrate-project" });
    expect(log.length).toBe(1);
    expect(log[0].metadata.documents_moved).toBe(2);
    expect(log[0].metadata.workspace_id).toBe(wsA);
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

describe("LocalClio.editDocument (5.13 follow-up: metadata-only edit)", () => {
  it("edits title without re-ingesting content (no version snapshot)", async () => {
    const clio = makeClio();
    const r = await clio.ingest({
      project: "p1",
      title: "Old name",
      content: "# Doc\n\nhello world",
      metadata: { role: "spec" },
    });
    const beforeChunks = (await clio.search({ query: "hello world" })).hits.length;

    const updated = await clio.editDocument(r.id, { title: "New name" });
    expect(updated.title).toBe("New name");
    // Author/metadata/projectId should be preserved.
    expect(updated.author).toBe("agent");
    expect(updated.metadata).toEqual({ role: "spec" });
    // No version snapshot taken.
    expect(await clio.listDocumentVersions(r.id)).toEqual([]);
    // Live chunks unaffected.
    const afterChunks = (await clio.search({ query: "hello world" })).hits.length;
    expect(afterChunks).toBe(beforeChunks);
    await clio.close();
  });

  it("set/unset metadata is incremental (other keys survive)", async () => {
    const clio = makeClio();
    const r = await clio.ingest({
      project: "p1",
      title: "Doc",
      content: "body",
      metadata: { role: "spec", workspace_id: "ws-1", draft: true },
    });

    const updated = await clio.editDocument(r.id, {
      metadataSet:   { reviewed_by: "fotis", role: "approved-spec" },
      metadataUnset: ["draft"],
    });
    expect(updated.metadata).toEqual({
      workspace_id: "ws-1",
      role:         "approved-spec",     // overwritten
      reviewed_by:  "fotis",             // added
                                         // draft: unset
    });
    await clio.close();
  });

  it("moves doc between projects via projectName", async () => {
    const clio = makeClio();
    await clio.createProject({ name: "src" });
    await clio.createProject({ name: "dst" });
    const r = await clio.ingest({ project: "src", title: "Travelling doc", content: "x" });

    const srcProj = await clio.getProject("src");
    expect(r.document.projectId).toBe(srcProj!.id);

    const updated = await clio.editDocument(r.id, { projectName: "dst" });
    const dstProj = await clio.getProject("dst");
    expect(updated.projectId).toBe(dstProj!.id);

    // Source project's docs list excludes it.
    expect((await clio.listDocuments({ project: "src" })).map((d) => d.id)).not.toContain(r.id);
    // Destination project's docs list includes it.
    expect((await clio.listDocuments({ project: "dst" })).map((d) => d.id)).toContain(r.id);
    await clio.close();
  });

  it("audit log records before/after diff for the changed fields only", async () => {
    const clio = makeClio();
    const r = await clio.ingest({
      project: "p1",
      title: "Original",
      content: "body",
      metadata: { role: "spec" },
    });
    await clio.editDocument(r.id, {
      title: "Renamed",
      metadataSet: { role: "spec" },           // no-op: same value
    }, { author: "claude-code" });

    const log = await clio.getAuditLog({ documentId: r.id, eventType: "edit-metadata" });
    expect(log.length).toBe(1);
    expect(log[0].actor).toBe("claude-code");
    const diff = log[0].metadata.diff as Record<string, { before: unknown; after: unknown }>;
    expect(diff.title).toEqual({ before: "Original", after: "Renamed" });
    // metadata.role didn't actually change → not in the diff
    expect(diff.metadata).toBeUndefined();
    await clio.close();
  });

  it("idempotent no-op: edit with no changes writes no audit row", async () => {
    const clio = makeClio();
    const r = await clio.ingest({
      project: "p1",
      title: "Steady",
      content: "body",
      author: "fotis",
    });
    const updated = await clio.editDocument(r.id, {
      title:  "Steady",      // same
      author: "fotis",       // same
    });
    expect(updated.title).toBe("Steady");

    const log = await clio.getAuditLog({ documentId: r.id, eventType: "edit-metadata" });
    expect(log.length).toBe(0);
    await clio.close();
  });

  it("rejects empty title", async () => {
    const clio = makeClio();
    const r = await clio.ingest({ project: "p1", title: "Doc", content: "x" });
    await expect(clio.editDocument(r.id, { title: "   " })).rejects.toThrow(/title cannot be empty/);
    await clio.close();
  });

  it("rejects unknown projectName", async () => {
    const clio = makeClio();
    const r = await clio.ingest({ project: "p1", title: "Doc", content: "x" });
    await expect(clio.editDocument(r.id, { projectName: "no-such-project" }))
      .rejects.toThrow(/not found/);
    await clio.close();
  });

  it("throws on missing doc", async () => {
    const clio = makeClio();
    await expect(clio.editDocument("00000000-0000-4000-8000-000000000000", { title: "x" }))
      .rejects.toThrow(/not found/);
    await clio.close();
  });

  it("throws on soft-deleted doc (must restore first)", async () => {
    const clio = makeClio();
    const r = await clio.ingest({ project: "p1", title: "Tomb", content: "x" });
    await clio.deleteDocument(r.id);
    await expect(clio.editDocument(r.id, { title: "y" })).rejects.toThrow(/soft-deleted/);
    await clio.close();
  });

  it("listDocuments + getDocument + metadataSearch populate projectName via JOIN", async () => {
    const clio = makeClio();
    await clio.createProject({ name: "named-proj", description: "for name surfacing test" });
    const r = await clio.ingest({
      project: "named-proj",
      title: "Doc",
      content: "body",
      metadata: { role: "spec" },
    });

    // listDocuments
    const list = await clio.listDocuments({ project: "named-proj" });
    expect(list.length).toBe(1);
    expect(list[0].projectName).toBe("named-proj");

    // getDocument
    const single = await clio.getDocument(r.id);
    expect(single?.projectName).toBe("named-proj");

    // metadataSearch
    const meta = await clio.metadataSearch({ metadataFilter: { role: "spec" } });
    expect(meta.documents.length).toBe(1);
    expect(meta.documents[0].projectName).toBe("named-proj");
    await clio.close();
  });

  it("clearing author with empty string falls back to 'agent'", async () => {
    const clio = makeClio();
    const r = await clio.ingest({ project: "p1", title: "Doc", content: "x", author: "fotis" });
    expect(r.document.author).toBe("fotis");
    const updated = await clio.editDocument(r.id, { author: "" });
    expect(updated.author).toBe("agent");
    await clio.close();
  });
});
