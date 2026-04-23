/**
 * LocalClio hybrid + semantic search tests.
 *
 * Uses a deterministic MockEmbedder (token-hash -> vector) so we can
 * assert search behaviour without an actual ONNX model. Real embedder
 * integration is covered via manual user testing (design doc §6).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LocalClio } from "./local-clio.js";
import {
  type Embedder,
  type EmbedderEntry,
  l2Normalise,
  findEmbedderEntry,
} from "../embedders/index.js";

class MockEmbedder implements Embedder {
  readonly name = "mock-embedder";
  readonly dim = 16;
  readonly recommendedChunkMaxChars = 1800;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    // Tokenise by lowercased words; distribute each token across the
    // vector based on a deterministic hash. Two texts that share tokens
    // will have similar vectors.
    const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
    for (const token of tokens) {
      let h = 0;
      for (let i = 0; i < token.length; i++) h = (h * 31 + token.charCodeAt(i)) & 0xffff;
      const idx = h % this.dim;
      v[idx] += 1;
      v[(idx + 1) % this.dim] += 0.5;
    }
    return l2Normalise(v);
  }
}

let tempDir: string;
let clio: LocalClio;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "cfcf-clio-hybrid-test-"));
  const embedder = new MockEmbedder();
  clio = new LocalClio({
    path: join(tempDir, "clio.db"),
    embedder,
  });
});

afterEach(async () => {
  await clio.close();
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Helpers ──────────────────────────────────────────────────────────────

async function seedCorpus(c: LocalClio): Promise<void> {
  await c.ingest({
    project: "backend",
    title: "auth-retry",
    content: "# Authentication retry\n\nUse exponential backoff for auth retries. Token refresh matters.",
    metadata: { role: "reflection" },
  });
  await c.ingest({
    project: "backend",
    title: "db-pool",
    content: "# Database pooling\n\nKeep connection pools small under high concurrency. Avoid thread starvation.",
    metadata: { role: "architect" },
  });
  await c.ingest({
    project: "frontend",
    title: "tabbing",
    content: "# Tab navigation\n\nUse arrow keys for tabbed UI. Keyboard accessibility matters.",
    metadata: { role: "dev" },
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("LocalClio hybrid + semantic search", () => {
  it("ingest stores embeddings when an embedder is active", async () => {
    await seedCorpus(clio);
    const stats = await clio.stats();
    expect(stats.chunkCount).toBeGreaterThan(0);
    // Hybrid search should return something (embeddings are stored).
    const res = await clio.search({ query: "authentication retries", mode: "hybrid" });
    expect(res.mode).toBe("hybrid");
    expect(res.hits.length).toBeGreaterThan(0);
  });

  it("semantic mode ranks by cosine similarity", async () => {
    await seedCorpus(clio);
    const res = await clio.search({ query: "authentication retry backoff", mode: "semantic" });
    expect(res.mode).toBe("semantic");
    // With the mock embedder, the auth doc should win since it shares
    // tokens with the query.
    expect(res.hits[0]?.docTitle).toBe("auth-retry");
  });

  it("hybrid mode fuses FTS + vector rankings via RRF", async () => {
    await seedCorpus(clio);
    const res = await clio.search({ query: "authentication", mode: "hybrid" });
    expect(res.mode).toBe("hybrid");
    // Top hit should be auth-retry (matches in both FTS + vector).
    expect(res.hits[0]?.docTitle).toBe("auth-retry");
  });

  it("falls back to FTS when no embedder is active (despite mode=semantic)", async () => {
    // Fresh clio with no embedder injected + no active record.
    const bare = new LocalClio({ path: join(tempDir, "bare.db") });
    await bare.ingest({
      project: "p1",
      title: "only fts",
      content: "# Title\n\nauthentication stuff here",
    });
    const res = await bare.search({ query: "authentication", mode: "semantic" });
    // Mode in the response is "fts" because we fell back.
    expect(res.mode).toBe("fts");
    expect(res.hits.length).toBeGreaterThan(0);
    await bare.close();
  });

  it("small-to-big expansion attaches sibling chunks to hits", async () => {
    // Build a large doc so chunking produces multiple chunks.
    const body = Array.from({ length: 15 }, (_, i) =>
      `## Section ${i}\n\n` +
      "authentication reference " + "w".repeat(200) +
      ` section-marker-${i}`,
    ).join("\n\n");
    await clio.ingest({
      project: "backend",
      title: "big",
      content: body,
    });
    const res = await clio.search({ query: "authentication section-marker-5", mode: "hybrid", matchCount: 1 });
    expect(res.hits.length).toBe(1);
    // With expansion radius 2 (bge-small default for dim<=768), we
    // expect the hit's content to include siblings -- more chars than a
    // single chunk.
    const topHit = res.hits[0];
    expect(topHit.content.length).toBeGreaterThan(400);
    // Neighbour chunk markers should be present (either side-4 or
    // side-6 should show up if expansion worked).
    const mentions = ["section-marker-3", "section-marker-4", "section-marker-5", "section-marker-6", "section-marker-7"];
    const present = mentions.filter((m) => topHit.content.includes(m));
    expect(present.length).toBeGreaterThanOrEqual(2);
  });

  it("semantic + project filter returns empty for unknown project", async () => {
    await seedCorpus(clio);
    const res = await clio.search({ query: "auth", mode: "semantic", project: "no-such" });
    expect(res.hits).toEqual([]);
  });

  it("metadata filter is honored by hybrid mode", async () => {
    await seedCorpus(clio);
    const res = await clio.search({
      query: "authentication",
      mode: "hybrid",
      metadata: { role: "reflection" },
    });
    // Only the auth-retry doc has role=reflection.
    for (const h of res.hits) expect(h.docMetadata.role).toBe("reflection");
  });

  it("chunker picks the embedder's recommended_chunk_max_chars", async () => {
    // MockEmbedder recommends 1800 chars. Ingest a 3500-char document
    // that would fit in one chunk at 4000 but splits at 1800.
    const body = "# big\n\n" + "w".repeat(3500);
    const result = await clio.ingest({
      project: "p1",
      title: "chunk-test",
      content: body,
    });
    expect(result.chunksInserted).toBeGreaterThan(1);
  });
});

// ── Embedder entry dim coverage (catalogue consistency) ───────────────

describe("embedder catalogue coverage", () => {
  it("every catalogue entry has plausible fields", () => {
    const known: EmbedderEntry[] = [
      findEmbedderEntry("bge-small-en-v1.5")!,
      findEmbedderEntry("all-MiniLM-L6-v2")!,
      findEmbedderEntry("nomic-embed-text-v1.5")!,
      findEmbedderEntry("bge-base-en-v1.5")!,
    ];
    for (const e of known) {
      expect(e.dim).toBeGreaterThan(0);
      expect(e.recommendedChunkMaxChars).toBeGreaterThan(100);
      expect(e.recommendedExpansionRadius).toBeGreaterThanOrEqual(1);
      expect(e.approxSizeMb).toBeGreaterThan(0);
      expect(e.description).toBeTruthy();
      expect(e.hfModelId).toBeTruthy();
    }
  });
});
