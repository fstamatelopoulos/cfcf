/**
 * Tests for active-embedder persistence.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openClioDb } from "../db.js";
import { getActiveEmbedder, setActiveEmbedder, clearActiveEmbedder, findEmbedderEntry } from "./index.js";

const tempDirs: string[] = [];
function mkDb(): ReturnType<typeof openClioDb> {
  const dir = mkdtempSync(join(tmpdir(), "cfcf-clio-embed-test-"));
  tempDirs.push(dir);
  return openClioDb({ path: join(dir, "clio.db") });
}
afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("active-embedder store", () => {
  it("getActiveEmbedder is null for a fresh DB", () => {
    const db = mkDb();
    expect(getActiveEmbedder(db)).toBeNull();
    db.close();
  });

  it("setActiveEmbedder persists the catalogue record", () => {
    const db = mkDb();
    const entry = findEmbedderEntry("bge-small-en-v1.5")!;
    const record = setActiveEmbedder(db, entry);
    expect(record.name).toBe("bge-small-en-v1.5");
    expect(record.dim).toBe(384);
    expect(record.recommendedChunkMaxChars).toBe(1800);
    expect(record.installedAt).toBeTruthy();
    db.close();
  });

  it("same-name re-install is idempotent", () => {
    const db = mkDb();
    const entry = findEmbedderEntry("bge-small-en-v1.5")!;
    setActiveEmbedder(db, entry);
    // Second call updates installed_at; should not throw even with embeddings absent.
    const second = setActiveEmbedder(db, entry);
    expect(second.name).toBe("bge-small-en-v1.5");
    db.close();
  });

  it("switching embedders is allowed when no embeddings exist", () => {
    const db = mkDb();
    const a = findEmbedderEntry("bge-small-en-v1.5")!;
    const b = findEmbedderEntry("all-MiniLM-L6-v2")!;
    setActiveEmbedder(db, a);
    const second = setActiveEmbedder(db, b);
    expect(second.name).toBe("all-MiniLM-L6-v2");
    db.close();
  });

  it("refuses to switch embedders when embeddings from the old model exist", () => {
    const db = mkDb();
    const a = findEmbedderEntry("bge-small-en-v1.5")!;
    setActiveEmbedder(db, a);

    // Seed a chunk with an embedding.
    db.run("INSERT INTO clio_projects (id, name) VALUES ('p', 'P')");
    db.run(`INSERT INTO clio_documents (id, project_id, title, source, content_hash)
            VALUES ('d', 'p', 't', 's', 'h')`);
    db.run(`INSERT INTO clio_chunks (id, document_id, chunk_index, content, char_count, embedding, embedder, embedding_dim)
            VALUES ('c', 'd', 0, 'x', 1, x'00', 'bge-small-en-v1.5', 384)`);

    const b = findEmbedderEntry("all-MiniLM-L6-v2")!;
    expect(() => setActiveEmbedder(db, b)).toThrow(/Refusing to switch/);

    // Force=true allows it (tests the override path; in production the
    // CLI only exposes this after a reindex).
    const forced = setActiveEmbedder(db, b, { force: true });
    expect(forced.name).toBe("all-MiniLM-L6-v2");
    db.close();
  });

  it("clearActiveEmbedder resets the table", () => {
    const db = mkDb();
    setActiveEmbedder(db, findEmbedderEntry("bge-small-en-v1.5")!);
    clearActiveEmbedder(db);
    expect(getActiveEmbedder(db)).toBeNull();
    db.close();
  });
});
