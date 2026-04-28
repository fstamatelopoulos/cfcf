/**
 * Tests for the Product Architect workspace-state reader.
 *
 * Plan item 5.14.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatProblemPackState, readProblemPackState } from "./workspace-state.js";

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "cfcf-pa-state-"));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("readProblemPackState", () => {
  it("reports exists: false when cfcf-docs/ doesn't exist", async () => {
    const state = await readProblemPackState(repo);
    expect(state.exists).toBe(false);
    expect(state.problem).toBeNull();
    expect(state.success).toBeNull();
    expect(state.cfcfDocsPath).toBe(join(repo, "cfcf-docs"));
  });

  it("reads problem.md + success.md + process.md + constraints.md when present", async () => {
    const docs = join(repo, "cfcf-docs");
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, "problem.md"), "# Problem\n\nbuild a thing\n", "utf-8");
    await writeFile(join(docs, "success.md"), "# Success\n\ntests pass\n", "utf-8");
    await writeFile(join(docs, "process.md"), "# Process\n\nuse TDD\n", "utf-8");
    await writeFile(join(docs, "constraints.md"), "# Constraints\n\nno docker\n", "utf-8");

    const state = await readProblemPackState(repo);
    expect(state.exists).toBe(true);
    expect(state.problem).toContain("build a thing");
    expect(state.success).toContain("tests pass");
    expect(state.process).toContain("use TDD");
    expect(state.constraints).toContain("no docker");
    expect(state.decisionLog).toBeNull();
  });

  it("handles partial Problem Pack (only some files exist)", async () => {
    const docs = join(repo, "cfcf-docs");
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, "problem.md"), "# Problem\n", "utf-8");

    const state = await readProblemPackState(repo);
    expect(state.exists).toBe(true);
    expect(state.problem).toContain("Problem");
    expect(state.success).toBeNull();
    expect(state.process).toBeNull();
    expect(state.constraints).toBeNull();
  });
});

describe("formatProblemPackState", () => {
  it("renders the missing-directory hint when exists is false", () => {
    const out = formatProblemPackState({
      cfcfDocsPath: "/repo/cfcf-docs",
      exists: false,
      problem: null,
      success: null,
      process: null,
      constraints: null,
      decisionLog: null,
    });
    expect(out).toContain("does NOT exist");
    expect(out).toContain("cfcf workspace init");
  });

  it("flags missing files individually with hints", () => {
    const out = formatProblemPackState({
      cfcfDocsPath: "/repo/cfcf-docs",
      exists: true,
      problem: null,
      success: null,
      process: null,
      constraints: null,
      decisionLog: null,
    });
    expect(out).toContain("(not yet created -- describes what the user is trying to build");
    expect(out).toContain("(not yet created -- describes how we'll know we're done");
    expect(out).toContain("(not yet created -- non-negotiables about HOW");
    expect(out).toContain("(not yet created -- what NOT to do");
  });

  it("flags empty files distinctly from missing files", () => {
    const out = formatProblemPackState({
      cfcfDocsPath: "/repo/cfcf-docs",
      exists: true,
      problem: "",
      success: "real content",
      process: null,
      constraints: null,
      decisionLog: null,
    });
    expect(out).toContain("(file exists but is empty");
    expect(out).toContain("real content");
  });

  it("includes the optional decision log when present + non-empty", () => {
    const out = formatProblemPackState({
      cfcfDocsPath: "/repo/cfcf-docs",
      exists: true,
      problem: "p",
      success: "s",
      process: null,
      constraints: null,
      decisionLog: "## Decision: TDD\n",
    });
    expect(out).toContain("decision-log.md");
    expect(out).toContain("Decision: TDD");
  });

  it("omits the decision log section when blank", () => {
    const out = formatProblemPackState({
      cfcfDocsPath: "/repo/cfcf-docs",
      exists: true,
      problem: "p",
      success: "s",
      process: null,
      constraints: null,
      decisionLog: "   \n",
    });
    expect(out).not.toContain("decision-log.md");
  });
});
