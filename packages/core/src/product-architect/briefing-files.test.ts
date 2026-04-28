/**
 * Tests for the Product Architect briefing-file writers.
 *
 * The merge logic itself lives in context-assembler.ts (already tested
 * for the iteration-time CLAUDE.md/AGENTS.md). These tests verify the
 * PA-specific composition: header, version stamp, both files written,
 * user content preserved across re-writes.
 *
 * Plan item 5.14.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBriefingBody, writeBriefingFiles, PA_BRIEFING_FILENAMES } from "./briefing-files.js";

let docs: string;

beforeEach(async () => {
  docs = await mkdtemp(join(tmpdir(), "cfcf-pa-briefing-"));
});

afterEach(async () => {
  await rm(docs, { recursive: true, force: true });
});

describe("buildBriefingBody", () => {
  it("includes the cf²-managed header, version stamp, and prompt body", () => {
    const out = buildBriefingBody({
      systemPrompt: "# PA prompt body",
      versionStamp: "2026-04-28T00:00:00Z",
    });
    expect(out).toContain("auto-managed by cf²");
    expect(out).toContain("cfcf-pa-version: 2026-04-28T00:00:00Z");
    expect(out).toContain("# PA prompt body");
  });
});

describe("writeBriefingFiles", () => {
  it("creates both AGENTS.md and CLAUDE.md from scratch", async () => {
    const written = await writeBriefingFiles(docs, {
      systemPrompt: "# Hello PA",
      versionStamp: "v1",
    });
    expect(written).toHaveLength(2);
    for (const filename of PA_BRIEFING_FILENAMES) {
      const content = await readFile(join(docs, filename), "utf-8");
      expect(content).toContain("<!-- cfcf:begin -->");
      expect(content).toContain("<!-- cfcf:end -->");
      expect(content).toContain("# Hello PA");
      expect(content).toContain("cfcf-pa-version: v1");
    }
  });

  it("preserves user content outside the cf² sentinel block on re-write", async () => {
    // First write: clean.
    await writeBriefingFiles(docs, {
      systemPrompt: "# v1 body",
      versionStamp: "v1",
    });

    // User adds their own notes BELOW the cf² block.
    for (const filename of PA_BRIEFING_FILENAMES) {
      const path = join(docs, filename);
      const existing = await readFile(path, "utf-8");
      await writeFile(path, existing + "\n# My team's conventions\n\n- always two-space indent\n", "utf-8");
    }

    // Second write: refresh briefing.
    await writeBriefingFiles(docs, {
      systemPrompt: "# v2 body (different content)",
      versionStamp: "v2",
    });

    for (const filename of PA_BRIEFING_FILENAMES) {
      const path = join(docs, filename);
      const content = await readFile(path, "utf-8");
      // Inside markers updated:
      expect(content).toContain("# v2 body (different content)");
      expect(content).toContain("cfcf-pa-version: v2");
      expect(content).not.toContain("# v1 body");
      // Outside markers preserved:
      expect(content).toContain("# My team's conventions");
      expect(content).toContain("always two-space indent");
    }
  });

  it("creates the cfcf-docs directory if it doesn't exist", async () => {
    const subdir = join(docs, "nested", "cfcf-docs");
    await writeBriefingFiles(subdir, {
      systemPrompt: "# body",
      versionStamp: "vX",
    });
    for (const filename of PA_BRIEFING_FILENAMES) {
      const content = await readFile(join(subdir, filename), "utf-8");
      expect(content).toContain("# body");
    }
  });

  it("is idempotent: re-running with the same input doesn't change bytes", async () => {
    await writeBriefingFiles(docs, {
      systemPrompt: "# stable",
      versionStamp: "fixed",
    });
    const before = await readFile(join(docs, "AGENTS.md"), "utf-8");
    await writeBriefingFiles(docs, {
      systemPrompt: "# stable",
      versionStamp: "fixed",
    });
    const after = await readFile(join(docs, "AGENTS.md"), "utf-8");
    expect(after).toBe(before);
  });
});
