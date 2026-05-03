/**
 * Tests for the Help Assistant prompt assembler. The assembler is a
 * pure function over the embedded help bundle + caller-provided
 * context, so testing is straightforward.
 */

import { describe, it, expect } from "bun:test";
import { assembleHelpAssistantPrompt } from "./prompt-assembler.js";

describe("assembleHelpAssistantPrompt", () => {
  it("includes the role preamble + scope + permission model + local env", () => {
    const prompt = assembleHelpAssistantPrompt();
    expect(prompt).toContain("# You are the cf² Help Assistant");
    expect(prompt).toContain("# Scope");
    expect(prompt).toContain("# Permission model");
    expect(prompt).toContain("# Local environment");
    expect(prompt).toContain("# Memory");
    expect(prompt).toContain("# cf² documentation");
    expect(prompt).toContain("# Closing notes");
  });

  it("declares both Clio memory projects in the Memory section", () => {
    const prompt = assembleHelpAssistantPrompt();
    expect(prompt).toContain("`cf-system-ha-memory`");
    expect(prompt).toContain("`cf-system-memory-global`");
  });

  it("notes empty memory inventory when no entries provided", () => {
    const prompt = assembleHelpAssistantPrompt({ memoryInventory: [] });
    expect(prompt).toContain("(empty -- memory Projects don't exist yet, or no docs in them)");
  });

  it("inlines the provided memory inventory verbatim", () => {
    const inv = [
      "### Project: `cf-system-memory-global` (1 doc)\n- **always TS** (`abc-123`)\n  user prefers TypeScript",
    ];
    const prompt = assembleHelpAssistantPrompt({ memoryInventory: inv });
    expect(prompt).toContain("always TS");
    expect(prompt).toContain("`abc-123`");
    expect(prompt).toContain("user prefers TypeScript");
  });

  it("omits the workspace section when no workspace context is given", () => {
    const prompt = assembleHelpAssistantPrompt();
    expect(prompt).not.toContain("# Workspace context");
  });

  it("includes workspace name + repo + iteration count when provided", () => {
    const prompt = assembleHelpAssistantPrompt({
      workspace: {
        name: "my-project",
        repoPath: "/Users/x/code/my-project",
        iterationCount: 7,
        recentIterations: ["iter 5: did X", "iter 6: did Y", "iter 7: did Z"],
      },
    });
    expect(prompt).toContain("# Workspace context");
    expect(prompt).toContain("my-project");
    expect(prompt).toContain("/Users/x/code/my-project");
    expect(prompt).toContain("Iterations done:  7");
    expect(prompt).toContain("iter 5: did X");
    expect(prompt).toContain("iter 7: did Z");
  });

  it("includes plan + decision-log content when provided", () => {
    const prompt = assembleHelpAssistantPrompt({
      workspace: {
        name: "p",
        repoPath: "/x",
        iterationCount: 1,
        recentIterations: [],
        plan: "## Plan items\n- [ ] do thing",
        decisionLog: "## 2026-04-27 — chose X over Y",
      },
    });
    expect(prompt).toContain("## Plan (`cfcf-docs/plan.md`)");
    expect(prompt).toContain("- [ ] do thing");
    expect(prompt).toContain("## Decision log (`cfcf-docs/decision-log.md`)");
    expect(prompt).toContain("chose X over Y");
  });

  it("includes the full embedded help bundle in the docs section", () => {
    const prompt = assembleHelpAssistantPrompt();
    // Spot-check that several canonical topics' content shows up.
    expect(prompt).toContain("Topic: `manual`");
    expect(prompt).toContain("Topic: `workflow`");
    expect(prompt).toContain("Topic: `cli`");
    expect(prompt).toContain("Topic: `troubleshooting`");
    // And one piece of content from the manual itself, post brand fix.
    expect(prompt).toContain("# cf² User Manual");
  });

  it("produces a non-trivial prompt size (> 100 KB) -- guard against accidental truncation", () => {
    const prompt = assembleHelpAssistantPrompt();
    expect(prompt.length).toBeGreaterThan(100_000);
    expect(prompt.length).toBeLessThan(500_000); // sanity ceiling
  });

  it("declares the HA's behavior contract in the closing notes", () => {
    const prompt = assembleHelpAssistantPrompt();
    expect(prompt).toContain("greet the user briefly");
    expect(prompt).toContain("conversation is gone");
  });
});
