/**
 * Tests for the Product Architect state assessor (v2).
 *
 * Verifies cfcf's pre-injection state computation:
 *   - Git status (.git/ presence + latest commit)
 *   - Workspace registration lookup by repoPath
 *   - cfcf server status from pid file
 *   - Iteration history detection
 *   - Problem Pack file states (problem-pack/*.md)
 *   - PA cache state (.cfcf-pa/*)
 *
 * The state-assessor's reads are best-effort — failures produce
 * null/empty fields rather than throws.
 *
 * Plan item 5.14 (v2).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessState, formatAssessedState, generateSessionId } from "./state-assessor.js";

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "cfcf-pa-state-"));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("generateSessionId", () => {
  it("produces a pa-<timestamp>-<random> shape", () => {
    const id = generateSessionId(new Date("2026-04-28T15:49:10.000Z"));
    expect(id).toMatch(/^pa-2026-04-28T15-49-10-000-[a-z0-9]+$/);
  });

  it("is unique across calls", () => {
    const a = generateSessionId();
    const b = generateSessionId();
    expect(a).not.toBe(b);
  });
});

describe("assessState — fresh repo", () => {
  it("reports no git repo, no workspace, no problem pack, no cache", async () => {
    const state = await assessState({ repoPath: repo });
    expect(state.git.isGitRepo).toBe(false);
    expect(state.workspace.registered).toBe(false);
    expect(state.problemPack.exists).toBe(false);
    expect(state.paCache.exists).toBe(false);
    expect(state.iterations.exists).toBe(false);
  });

  it("generates a session_id when not provided", async () => {
    const state = await assessState({ repoPath: repo });
    expect(state.sessionId).toMatch(/^pa-/);
  });

  it("respects an explicit session_id when provided", async () => {
    const state = await assessState({ repoPath: repo, sessionId: "pa-test-fixed" });
    expect(state.sessionId).toBe("pa-test-fixed");
  });
});

describe("assessState — git detection", () => {
  it("detects a git repo when .git/ is present", async () => {
    await mkdir(join(repo, ".git"), { recursive: true });
    const state = await assessState({ repoPath: repo });
    expect(state.git.isGitRepo).toBe(true);
    // No commits yet → null commit
    expect(state.git.latestCommit).toBeNull();
  });
});

describe("assessState — problem pack", () => {
  it("reads existing problem-pack files", async () => {
    const packDir = join(repo, "problem-pack");
    await mkdir(packDir, { recursive: true });
    await writeFile(join(packDir, "problem.md"), "# Problem\n\nbuild a thing\n", "utf-8");
    await writeFile(join(packDir, "success.md"), "# Success\n", "utf-8");

    const state = await assessState({ repoPath: repo });
    expect(state.problemPack.exists).toBe(true);
    const problem = state.problemPack.files.find((f) => f.filename === "problem.md");
    expect(problem?.exists).toBe(true);
    expect(problem?.content).toContain("build a thing");
    const success = state.problemPack.files.find((f) => f.filename === "success.md");
    expect(success?.exists).toBe(true);
    const constraints = state.problemPack.files.find((f) => f.filename === "constraints.md");
    expect(constraints?.exists).toBe(false);
  });

  it("lists context/ files when present", async () => {
    const ctxDir = join(repo, "problem-pack", "context");
    await mkdir(ctxDir, { recursive: true });
    await writeFile(join(ctxDir, "api-spec.md"), "## API", "utf-8");
    await writeFile(join(ctxDir, "schema.md"), "## Schema", "utf-8");

    const state = await assessState({ repoPath: repo });
    expect(state.problemPack.contextFiles).toContain("api-spec.md");
    expect(state.problemPack.contextFiles).toContain("schema.md");
  });

  it("truncates large files to the preview limit", async () => {
    const packDir = join(repo, "problem-pack");
    await mkdir(packDir, { recursive: true });
    const big = "x".repeat(10000);
    await writeFile(join(packDir, "problem.md"), big, "utf-8");

    const state = await assessState({ repoPath: repo });
    const problem = state.problemPack.files.find((f) => f.filename === "problem.md");
    expect(problem?.size).toBe(10000);
    expect(problem?.content?.length).toBe(4000);
  });
});

describe("assessState — PA cache", () => {
  it("reads the .cfcf-pa cache when present", async () => {
    const cacheDir = join(repo, ".cfcf-pa");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      join(cacheDir, "workspace-summary.md"),
      "# PA workspace memory\n\nLast session: drafted problem.md.",
      "utf-8",
    );
    await writeFile(
      join(cacheDir, "meta.json"),
      JSON.stringify({ lastSync: "2026-04-27T10:00:00Z", paWorkspaceMemoryDocId: "doc-1" }),
      "utf-8",
    );
    await writeFile(join(cacheDir, "session-pa-2026-04-27.md"), "# session log\n", "utf-8");

    const state = await assessState({ repoPath: repo });
    expect(state.paCache.exists).toBe(true);
    expect(state.paCache.workspaceSummary).toContain("Last session: drafted problem.md");
    expect(state.paCache.meta?.paWorkspaceMemoryDocId).toBe("doc-1");
    expect(state.paCache.sessionFiles).toContain("session-pa-2026-04-27.md");
  });
});

describe("assessState — iteration history", () => {
  it("counts iteration headers in cfcf-docs/iteration-history.md", async () => {
    const docsDir = join(repo, "cfcf-docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(
      join(docsDir, "iteration-history.md"),
      "# Iteration history\n\n## Iteration 1\nfoo\n\n## Iteration 2\nbar\n\n## Iteration 3\nbaz\n",
      "utf-8",
    );

    const state = await assessState({ repoPath: repo });
    expect(state.iterations.exists).toBe(true);
    expect(state.iterations.iterationCount).toBe(3);
    expect(state.iterations.tail).toContain("Iteration 3");
  });
});

describe("formatAssessedState", () => {
  it("renders the fresh-repo assessment with actionable hints", async () => {
    const state = await assessState({ repoPath: repo });
    const out = formatAssessedState(state);
    expect(out).toContain("Not a git repo");
    expect(out).toContain("git init");
    expect(out).toContain("No cfcf workspace registered");
    expect(out).toContain("FIRST priority");
    expect(out).toContain("cfcf workspace init --repo");
    expect(out).toContain("doesn't exist yet");
  });

  it("renders the populated-repo assessment with workspace + problem-pack details", async () => {
    await mkdir(join(repo, ".git"), { recursive: true });
    const packDir = join(repo, "problem-pack");
    await mkdir(packDir, { recursive: true });
    await writeFile(join(packDir, "problem.md"), "# Problem\n", "utf-8");

    const state = await assessState({ repoPath: repo });
    const out = formatAssessedState(state);
    expect(out).toContain("Git repo present");
    expect(out).toContain("`problem.md`");
  });
});
