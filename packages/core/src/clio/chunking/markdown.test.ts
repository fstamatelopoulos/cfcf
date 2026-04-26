/**
 * Tests for the heading-aware Markdown chunker.
 *
 * Mirrors the assertions in cerefox/tests/chunking/test_markdown.py where
 * applicable. Given the 1:1 port, cross-checks with Cerefox's expected
 * outputs help catch any divergence in the TS translation.
 */

import { describe, it, expect } from "bun:test";
import { chunkMarkdown } from "./markdown.js";

describe("chunkMarkdown", () => {
  it("returns an empty array for empty input", () => {
    expect(chunkMarkdown("")).toEqual([]);
    expect(chunkMarkdown("   \n\n  \n")).toEqual([]);
  });

  it("short-circuits small documents to a single chunk", () => {
    const text = "# Hello\n\nSome body text.";
    const chunks = chunkMarkdown(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({
      chunkIndex: 0,
      headingPath: [],
      headingLevel: 0,
      title: "",
      content: text,
      charCount: text.length,
    });
  });

  it("preserves preamble text (no heading) as level-0 chunk", () => {
    const body = "A".repeat(100);
    const headings = Array.from({ length: 20 }, (_, i) => `## Section ${i}\n\ncontent ${i}`).join("\n\n");
    const text = `${body}\n\n${headings}`;

    const chunks = chunkMarkdown(text, { maxChunkChars: 150 });
    // First chunk is the preamble.
    expect(chunks[0].headingLevel).toBe(0);
    expect(chunks[0].headingPath).toEqual([]);
    expect(chunks[0].content).toContain("AAA");
  });

  it("greedy accumulation combines small sections", () => {
    // Four small sections; maxChunkChars forces two per chunk.
    const text = [
      "# One",
      "one body",
      "# Two",
      "two body",
      "# Three",
      "three body",
      "# Four",
      "four body",
    ].join("\n\n");

    const chunks = chunkMarkdown(text, { maxChunkChars: 45 });
    // Each chunk should fit at least two sections.
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(c.charCount).toBeLessThanOrEqual(45);
    }
    // Total content preserved (minus separators + trimming).
    const rejoined = chunks.map((c) => c.content).join("\n\n");
    for (const keyword of ["One", "Two", "Three", "Four"]) {
      expect(rejoined).toContain(keyword);
    }
  });

  it("tracks the heading breadcrumb across H1/H2/H3", () => {
    // Trigger actual chunking by making the doc larger than maxChunkChars.
    const filler = (label: string) => label + " " + "X".repeat(200);
    const text = [
      "# Overview",
      filler("overview body"),
      "## Architecture",
      filler("architecture body"),
      "### Components",
      filler("components body"),
      "## Data Model",
      filler("data model body"),
    ].join("\n\n");

    const chunks = chunkMarkdown(text, { maxChunkChars: 300 });

    // Find a chunk at the deepest heading level and check breadcrumb.
    const componentsChunks = chunks.filter((c) => c.headingLevel === 3);
    expect(componentsChunks.length).toBeGreaterThan(0);
    expect(componentsChunks[0].headingPath).toEqual(["Overview", "Architecture", "Components"]);
    expect(componentsChunks[0].title).toBe("Components");

    // And a chunk where we pop back up one level (H2 after H3).
    const dataModelChunks = chunks.filter(
      (c) => c.headingLevel === 2 && c.title === "Data Model",
    );
    expect(dataModelChunks.length).toBeGreaterThan(0);
    expect(dataModelChunks[0].headingPath).toEqual(["Overview", "Data Model"]);
  });

  it("splits an oversized single section at paragraph boundaries", () => {
    // Build a single H1 section whose body is many paragraphs, each small.
    const paragraphs = Array.from({ length: 20 }, (_, i) =>
      `Paragraph ${i}: ` + "x".repeat(200),
    );
    const text = "# Big Section\n\n" + paragraphs.join("\n\n");

    const chunks = chunkMarkdown(text, { maxChunkChars: 1000 });
    expect(chunks.length).toBeGreaterThan(1);
    // All chunks stay under the limit.
    for (const c of chunks) {
      expect(c.charCount).toBeLessThanOrEqual(1000);
    }
    // First chunk carries the heading prefix.
    expect(chunks[0].content.startsWith("# Big Section")).toBe(true);
    // The heading carries through on every chunk's metadata.
    for (const c of chunks) {
      expect(c.title).toBe("Big Section");
      expect(c.headingPath).toEqual(["Big Section"]);
    }
  });

  it("merges too-small paragraph pieces into the preceding piece", () => {
    // One section whose paragraphs are much smaller than minChunkChars --
    // they should coalesce rather than produce many tiny chunks.
    const tiny = Array.from({ length: 50 }, (_, i) => `p${i}`).join("\n\n");
    const huge = "L".repeat(500);
    const text = "# Section\n\n" + huge + "\n\n" + tiny;

    const chunks = chunkMarkdown(text, { maxChunkChars: 600, minChunkChars: 50 });

    // There should be far fewer chunks than there are paragraphs.
    expect(chunks.length).toBeLessThan(10);
  });

  it("hard-splits a paragraph longer than maxChunkChars", () => {
    const blob = "z".repeat(5000);
    const text = `# Section\n\n${blob}`;
    const chunks = chunkMarkdown(text, { maxChunkChars: 1000 });
    expect(chunks.length).toBeGreaterThan(1);
    // Matches Cerefox behavior: the first chunk carries the heading
    // prefix prepended to the first hard-split piece, which can exceed
    // maxChunkChars by roughly the heading length. Subsequent chunks
    // stay at or under maxChunkChars.
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].charCount).toBeLessThanOrEqual(1000);
    }
    expect(chunks[0].charCount).toBeLessThanOrEqual(1000 + "# Section\n\n".length);
  });

  it("treats H4+ as inline body (no chunk boundary)", () => {
    const filler = "W".repeat(500);
    const text = [
      "# Top",
      "#### Fourth level should NOT split",
      filler,
      "##### Fifth level either",
      filler,
    ].join("\n\n");
    const chunks = chunkMarkdown(text, { maxChunkChars: 2000 });

    // Either all the H4+ content ended up in the same chunk, or it got
    // paragraph-split -- but no chunk should have heading_level > 3.
    for (const c of chunks) {
      expect(c.headingLevel).toBeLessThanOrEqual(3);
    }
  });

  it("strips trailing hashes from headings (## foo ##)", () => {
    const text = [
      "## Alpha ##",
      "body alpha",
      "### Beta ###",
      "body beta",
    ].join("\n\n") + "\n\n" + "Z".repeat(500);
    const chunks = chunkMarkdown(text, { maxChunkChars: 200 });
    const titles = chunks.map((c) => c.title).filter(Boolean);
    // Titles should not contain trailing '#' characters.
    for (const t of titles) {
      expect(t).not.toMatch(/#/);
    }
  });

  it("assigns sequential chunk_index starting from 0", () => {
    const paras = Array.from({ length: 30 }, (_, i) => `para ${i} ` + "q".repeat(100));
    const text = "# Top\n\n" + paras.join("\n\n");
    const chunks = chunkMarkdown(text, { maxChunkChars: 400 });
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunkIndex).toBe(i);
    }
  });

  it("respects the Cerefox default of 4000 chars when maxChunkChars is unset", () => {
    // A single-chunk document just under 4000 chars stays one chunk.
    const text = "# Under\n\n" + "a".repeat(3900);
    const chunks = chunkMarkdown(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].charCount).toBeLessThanOrEqual(4000);

    // Just over 4000 forces splitting.
    const bigger = "# Over\n\n" + "b".repeat(5000);
    const biggerChunks = chunkMarkdown(bigger);
    expect(biggerChunks.length).toBeGreaterThan(1);
  });
});
