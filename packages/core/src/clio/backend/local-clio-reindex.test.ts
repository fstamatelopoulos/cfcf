/**
 * LocalClio reindex tests. Uses a swappable MockEmbedder pair so we can
 * simulate the "ingest under embedder A → switch active to B → reindex"
 * flow deterministically.
 */

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LocalClio } from "./local-clio.js";
import {
  l2Normalise,
  findEmbedderEntry,
  setActiveEmbedder,
  type Embedder,
  type EmbedderEntry,
} from "../embedders/index.js";

/**
 * Mock embedder parameterised by (name, dim, token-hash-shift). The
 * shift makes two mock embedders produce different vectors for the same
 * text, which is what we need to verify that reindex actually re-runs.
 */
class MockEmbedder implements Embedder {
  constructor(
    readonly name: string,
    readonly dim: number,
    readonly recommendedChunkMaxChars: number,
    private readonly shift: number,
  ) {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.embedOne(t));
  }
  private embedOne(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 1);
    for (const token of tokens) {
      let h = 0;
      for (let i = 0; i < token.length; i++) h = (h * 31 + token.charCodeAt(i)) & 0xffff;
      const idx = (h + this.shift) % this.dim;
      v[idx] += 1;
    }
    return l2Normalise(v);
  }
}

const BGE = findEmbedderEntry("bge-small-en-v1.5")!;
const MINI = findEmbedderEntry("all-MiniLM-L6-v2")!;

// A fake bge entry that matches dim=16 so we can reuse in-test records
// without depending on a real 384-dim ONNX model.
function makeTestEntry(name: string, dim: number, chunkMax: number): EmbedderEntry {
  return {
    name,
    hfModelId: `mock/${name}`,
    dim,
    recommendedChunkMaxChars: chunkMax,
    recommendedExpansionRadius: 2,
    approxSizeMb: 0,
    description: "test embedder",
  };
}

let tempDir: string;
let clio: LocalClio;
let current: MockEmbedder;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "cfcf-clio-reindex-test-"));
  const entry = makeTestEntry("mock-A", 16, 1800);
  current = new MockEmbedder(entry.name, entry.dim, entry.recommendedChunkMaxChars, 0);
  clio = new LocalClio({
    path: join(tempDir, "clio.db"),
    embedder: current,
  });
  // Mark as active so reindex's "no active embedder" guard is satisfied.
  // Access the underlying DB via the public method used by the route
  // layer. We go through setActiveEmbedder directly to bypass the
  // "refuses to switch when embeddings exist" guard (fresh DB, no
  // embeddings yet).
  const entry_typed: EmbedderEntry = {
    ...entry,
    hfModelId: "mock/A",
    approxSizeMb: 0,
    description: "mock",
    recommendedExpansionRadius: 2,
  };
  // openClioDb was already called in LocalClio constructor; grab the
  // handle via the record-setter exposed on LocalClio.
  const rec = clio.getActiveEmbedderRecord();
  if (!rec) {
    // We need to write the record without triggering the switching
    // guard -- there are no embeddings yet, so installActiveEmbedder's
    // guard passes naturally.
    // @ts-expect-error -- accessing private db for test setup
    setActiveEmbedder(clio.db, entry_typed);
  }
});

afterEach(async () => {
  await clio.close();
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("LocalClio.reindex", () => {
  it("throws when no embedder is active", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cfcf-clio-reindex-noembed-"));
    const bare = new LocalClio({ path: join(dir, "clio.db") });
    await expect(bare.reindex()).rejects.toThrow(/no active embedder/i);
    await bare.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips chunks already matching the active embedder (idempotent)", async () => {
    await clio.ingest({ project: "p1", title: "A", content: "# A\n\nalpha content alpha" });
    await clio.ingest({ project: "p1", title: "B", content: "# B\n\nbeta content beta" });

    const result = await clio.reindex();
    expect(result.embedder).toBe("mock-A");
    expect(result.chunksReembedded).toBe(0);
    expect(result.chunksSkipped).toBe(result.chunksScanned);
    expect(result.chunksScanned).toBeGreaterThan(0);
  });

  it("re-embeds chunks that have no embedding", async () => {
    // Ingest WITHOUT an embedder -- chunks land with embedding=NULL.
    const dir = mkdtempSync(join(tmpdir(), "cfcf-clio-reindex-backfill-"));
    const bare = new LocalClio({ path: join(dir, "clio.db") });
    await bare.ingest({ project: "p1", title: "A", content: "# A\n\nalpha content" });
    await bare.ingest({ project: "p1", title: "B", content: "# B\n\nbeta content" });
    await bare.close();

    // Reopen with an embedder + set it active; reindex backfills.
    const entry = makeTestEntry("mock-backfill", 16, 1800);
    const mock = new MockEmbedder(entry.name, entry.dim, entry.recommendedChunkMaxChars, 0);
    const reopened = new LocalClio({ path: join(dir, "clio.db"), embedder: mock });
    // @ts-expect-error -- private db for test setup
    setActiveEmbedder(reopened.db, entry);

    const result = await reopened.reindex();
    expect(result.chunksReembedded).toBeGreaterThan(0);
    expect(result.chunksSkipped).toBe(0);

    await reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("re-embeds chunks when the embedder has changed", async () => {
    // Ingest under mock-A.
    await clio.ingest({ project: "p1", title: "A", content: "# A\n\ncontent alpha" });
    const r1 = await clio.reindex();
    expect(r1.chunksReembedded).toBe(0);

    // Swap to mock-B (different embedder slug). Use force so the
    // store-side guard doesn't stop us.
    const entryB = makeTestEntry("mock-B", 16, 1800);
    const mockB = new MockEmbedder(entryB.name, entryB.dim, entryB.recommendedChunkMaxChars, 7);
    clio.setEmbedder(mockB);
    // @ts-expect-error -- private db for test setup
    setActiveEmbedder(clio.db, entryB, { force: true });

    const r2 = await clio.reindex();
    expect(r2.chunksReembedded).toBeGreaterThan(0);
    expect(r2.embedder).toBe("mock-B");

    // Rerun under the new embedder is idempotent.
    const r3 = await clio.reindex();
    expect(r3.chunksReembedded).toBe(0);
  });

  it("--force re-embeds everything even when the embedder matches", async () => {
    await clio.ingest({ project: "p1", title: "A", content: "# A\n\ncontent alpha" });
    await clio.ingest({ project: "p1", title: "B", content: "# B\n\ncontent beta" });

    const r1 = await clio.reindex();
    expect(r1.chunksReembedded).toBe(0);

    const r2 = await clio.reindex({ force: true });
    expect(r2.chunksReembedded).toBe(r2.chunksScanned);
    expect(r2.chunksScanned).toBeGreaterThan(0);
  });

  it("project filter restricts the reindex to one Clio Project", async () => {
    // Ingest under FTS-only (no embedder on this side) so reindex has
    // actual work. To keep this test simple, ingest via current embedder
    // and then force a re-embed scoped to project p-target.
    await clio.ingest({ project: "p-target", title: "T", content: "# T\n\ntarget alpha" });
    await clio.ingest({ project: "p-other", title: "O", content: "# O\n\nother alpha" });

    const r = await clio.reindex({ project: "p-target", force: true });
    expect(r.chunksScanned).toBeGreaterThan(0);
    // p-other is untouched (chunksScanned is already filtered).
    const allForce = await clio.reindex({ force: true });
    expect(allForce.chunksScanned).toBeGreaterThan(r.chunksScanned);
  });

  it("unknown project returns zero stats, not an error", async () => {
    const r = await clio.reindex({ project: "never-created" });
    expect(r.chunksReembedded).toBe(0);
    expect(r.chunksScanned).toBe(0);
  });
});
