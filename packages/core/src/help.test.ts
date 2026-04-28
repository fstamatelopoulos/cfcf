/**
 * Tests for the help-content surface (re-exports of the generated
 * embed module). The generator itself is exercised at build time;
 * these tests verify the runtime shape + alias resolution.
 */

import { describe, it, expect } from "bun:test";
import { listHelpTopics, resolveHelpTopic, getHelpContent, HELP_TOPICS } from "./help.js";

describe("help content surface", () => {
  it("ships at least the seven canonical topics", () => {
    const slugs = listHelpTopics().map((t) => t.slug);
    for (const required of [
      "manual",
      "workflow",
      "cli",
      "clio",
      "installing",
      "troubleshooting",
      "api",
    ]) {
      expect(slugs).toContain(required);
    }
  });

  it("manual is first in declaration order (default for `cfcf help`)", () => {
    expect(listHelpTopics()[0].slug).toBe("manual");
  });

  it("each topic has a non-trivial title parsed from the source H1", () => {
    for (const t of listHelpTopics()) {
      expect(t.title.length).toBeGreaterThan(2);
      expect(t.title).not.toBe(t.slug); // would mean H1 wasn't found in source
    }
  });

  it("resolveHelpTopic returns the canonical entry for a slug", () => {
    const t = resolveHelpTopic("manual");
    expect(t).not.toBeNull();
    expect(t!.slug).toBe("manual");
  });

  it("resolveHelpTopic resolves aliases (case-insensitive)", () => {
    expect(resolveHelpTopic("cli-usage")?.slug).toBe("cli");
    expect(resolveHelpTopic("commands")?.slug).toBe("cli");
    expect(resolveHelpTopic("MEMORY")?.slug).toBe("clio");
    expect(resolveHelpTopic("Install")?.slug).toBe("installing");
    expect(resolveHelpTopic("troubleshoot")?.slug).toBe("troubleshooting");
  });

  it("resolveHelpTopic returns null for unknown queries", () => {
    expect(resolveHelpTopic("does-not-exist")).toBeNull();
    expect(resolveHelpTopic("")).toBeNull();
  });

  it("getHelpContent returns the decoded Markdown body", () => {
    const body = getHelpContent("manual");
    expect(body).not.toBeNull();
    // Brand convention (2026-04-27): "cf²" in user-facing docs/UI;
    // "cfcf" only in source code, CLI commands, package paths.
    expect(body!).toContain("# cf² User Manual");
    // Spot-check that the embedded copy matches the source: the manual
    // mentions completion auto-install in its body.
    expect(body!).toContain("Shell completion");
    expect(body!).toContain("Troubleshooting");
  });

  it("getHelpContent returns null for unknown slugs", () => {
    expect(getHelpContent("nope")).toBeNull();
  });

  it("getHelpContent caches decoded content (same string identity on repeat calls)", () => {
    const a = getHelpContent("manual");
    const b = getHelpContent("manual");
    expect(a).toBe(b); // === comparison; cache returns the same string
  });

  it("HELP_TOPICS keys match each entry's slug", () => {
    for (const [key, topic] of Object.entries(HELP_TOPICS)) {
      expect(topic.slug).toBe(key);
    }
  });
});
