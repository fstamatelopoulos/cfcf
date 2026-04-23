/**
 * Tests for the iteration-loop Clio auto-ingest hooks.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { LocalClio } from "./backend/local-clio.js";
import {
  resolveIngestPolicy,
  parseDecisionLog,
  ingestReflectionAnalysis,
  ingestArchitectReview,
  ingestDecisionLogEntries,
  ingestIterationSummary,
  ingestRawIterationArtifacts,
  writeClioRelevant,
} from "./loop-ingest.js";
import type { WorkspaceConfig } from "../types.js";
import { writeConfig, createDefaultConfig } from "../config.js";

let tempDir: string;
let repoDir: string;
let clio: LocalClio;
const originalConfigDir = process.env.CFCF_CONFIG_DIR;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "cfcf-clio-loop-ingest-"));
  process.env.CFCF_CONFIG_DIR = tempDir;
  repoDir = join(tempDir, "repo");
  await mkdir(join(repoDir, "cfcf-docs", "iteration-logs"), { recursive: true });
  await mkdir(join(repoDir, "cfcf-docs", "iteration-handoffs"), { recursive: true });
  await mkdir(join(repoDir, "cfcf-docs", "iteration-reviews"), { recursive: true });
  await mkdir(join(repoDir, "cfcf-docs", "reflection-reviews"), { recursive: true });
  await writeConfig(createDefaultConfig(["claude-code"]));
  clio = new LocalClio({ path: join(tempDir, "clio.db") });
});

afterEach(async () => {
  await clio.close();
  process.env.CFCF_CONFIG_DIR = originalConfigDir;
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeWorkspace(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    id: "ws-abc123",
    name: "myws",
    repoPath: repoDir,
    devAgent: { adapter: "claude-code" },
    judgeAgent: { adapter: "codex" },
    architectAgent: { adapter: "claude-code" },
    documenterAgent: { adapter: "claude-code" },
    maxIterations: 10,
    pauseEvery: 0,
    onStalled: "alert",
    mergeStrategy: "auto",
    processTemplate: "default",
    currentIteration: 0,
    clioProject: "test-project",
    ...overrides,
  };
}

// ── resolveIngestPolicy ──────────────────────────────────────────────────

describe("resolveIngestPolicy", () => {
  it("returns workspace override when set", async () => {
    const ws = makeWorkspace({ clio: { ingestPolicy: "all" } });
    expect(await resolveIngestPolicy(ws)).toBe("all");
  });

  it("falls back to global when workspace is unset", async () => {
    await writeConfig({ ...createDefaultConfig(["claude-code"]), clio: { ingestPolicy: "off" } });
    const ws = makeWorkspace({ clio: undefined });
    expect(await resolveIngestPolicy(ws)).toBe("off");
  });

  it("defaults to summaries-only when neither is set", async () => {
    const ws = makeWorkspace({ clio: undefined });
    expect(await resolveIngestPolicy(ws)).toBe("summaries-only");
  });
});

// ── parseDecisionLog ─────────────────────────────────────────────────────

describe("parseDecisionLog", () => {
  it("parses tagged entries in order", () => {
    const raw = `
Some preamble.

## 2026-04-01T10:00:00Z  [role: dev]  [iter: 3]  [category: lesson]

First entry body.
Paragraph 2.

## 2026-04-02T11:00:00Z  [role: reflection]  [iter: 3]  [category: strategy]

Second entry body.
`;
    const entries = parseDecisionLog(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0].timestamp).toBe("2026-04-01T10:00:00Z");
    expect(entries[0].role).toBe("dev");
    expect(entries[0].iteration).toBe("3");
    expect(entries[0].category).toBe("lesson");
    expect(entries[0].body).toContain("First entry body");
    expect(entries[1].category).toBe("strategy");
  });

  it("returns [] for content without headers", () => {
    expect(parseDecisionLog("just prose")).toEqual([]);
    expect(parseDecisionLog("")).toEqual([]);
  });

  it("ignores malformed headers", () => {
    const raw = `
## 2026-04-01  [role: dev]  (iter: 3)  [category: lesson]

malformed -- parentheses instead of brackets

## 2026-04-02T11:00:00Z  [role: judge]  [iter: 3]  [category: lesson]

correct
`;
    const entries = parseDecisionLog(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe("judge");
  });
});

// ── ingestReflectionAnalysis ─────────────────────────────────────────────

describe("ingestReflectionAnalysis", () => {
  it("ingests when the file exists + policy != off", async () => {
    const ws = makeWorkspace();
    await writeFile(
      join(ws.repoPath, "cfcf-docs", "reflection-analysis.md"),
      "# Reflection\n\nAcross iters 1-3 the loop converges.",
      "utf-8",
    );
    const r = await ingestReflectionAnalysis(clio, ws, 3, {
      iteration: 3, plan_modified: false, iteration_health: "converging", key_observation: "converges",
    });
    expect(r?.created).toBe(true);
    expect(r?.document.metadata.artifact_type).toBe("reflection-analysis");
    expect(r?.document.metadata.iteration_health).toBe("converging");
    expect(r?.document.metadata.iteration).toBe(3);
  });

  it("returns null when policy=off", async () => {
    const ws = makeWorkspace({ clio: { ingestPolicy: "off" } });
    await writeFile(
      join(ws.repoPath, "cfcf-docs", "reflection-analysis.md"),
      "# Reflection",
      "utf-8",
    );
    const r = await ingestReflectionAnalysis(clio, ws, 3, null);
    expect(r).toBeNull();
  });

  it("returns null when the file is missing", async () => {
    const ws = makeWorkspace();
    const r = await ingestReflectionAnalysis(clio, ws, 3, null);
    expect(r).toBeNull();
  });
});

// ── ingestArchitectReview ────────────────────────────────────────────────

describe("ingestArchitectReview", () => {
  it("ingests pre-loop architect-review.md", async () => {
    const ws = makeWorkspace();
    await writeFile(
      join(ws.repoPath, "cfcf-docs", "architect-review.md"),
      "# Review\n\nReadiness: READY",
      "utf-8",
    );
    const r = await ingestArchitectReview(clio, ws, "loop", "READY");
    expect(r?.created).toBe(true);
    expect(r?.document.metadata.artifact_type).toBe("architect-review");
    expect(r?.document.metadata.trigger).toBe("loop");
    expect(r?.document.metadata.readiness).toBe("READY");
  });
});

// ── ingestDecisionLogEntries ─────────────────────────────────────────────

describe("ingestDecisionLogEntries", () => {
  it("summaries-only: only semantic-category entries for this iteration", async () => {
    const ws = makeWorkspace();
    await writeFile(
      join(ws.repoPath, "cfcf-docs", "decision-log.md"),
      `
## 2026-04-01T10:00Z  [role: dev]  [iter: 3]  [category: lesson]
L1

## 2026-04-01T10:05Z  [role: dev]  [iter: 3]  [category: observation]
O1 (should NOT ingest under summaries-only)

## 2026-04-01T10:10Z  [role: reflection]  [iter: 3]  [category: strategy]
S1

## 2026-04-01T10:15Z  [role: dev]  [iter: 4]  [category: lesson]
L2 (different iter -- should NOT ingest)
`,
      "utf-8",
    );
    const count = await ingestDecisionLogEntries(clio, ws, 3);
    expect(count).toBe(2); // lesson + strategy for iter 3
  });

  it("policy=all: ingests every entry for this iteration", async () => {
    const ws = makeWorkspace({ clio: { ingestPolicy: "all" } });
    await writeFile(
      join(ws.repoPath, "cfcf-docs", "decision-log.md"),
      `
## 2026-04-01T10:00Z  [role: dev]  [iter: 3]  [category: lesson]
L1

## 2026-04-01T10:05Z  [role: dev]  [iter: 3]  [category: observation]
O1

## 2026-04-01T10:10Z  [role: reflection]  [iter: 3]  [category: strategy]
S1
`,
      "utf-8",
    );
    const count = await ingestDecisionLogEntries(clio, ws, 3);
    expect(count).toBe(3);
  });

  it("policy=off returns 0", async () => {
    const ws = makeWorkspace({ clio: { ingestPolicy: "off" } });
    await writeFile(
      join(ws.repoPath, "cfcf-docs", "decision-log.md"),
      "## 2026-04-01T10:00Z  [role: dev]  [iter: 3]  [category: lesson]\nbody\n",
      "utf-8",
    );
    const count = await ingestDecisionLogEntries(clio, ws, 3);
    expect(count).toBe(0);
  });

  it("returns 0 when the file is missing", async () => {
    const ws = makeWorkspace();
    const count = await ingestDecisionLogEntries(clio, ws, 3);
    expect(count).toBe(0);
  });
});

// ── ingestIterationSummary ───────────────────────────────────────────────

describe("ingestIterationSummary", () => {
  it("builds + ingests the summary doc from dev/judge/reflection inputs", async () => {
    const ws = makeWorkspace();
    const r = await ingestIterationSummary(clio, {
      workspace: ws,
      iteration: 3,
      devSummary: "Added auth module.",
      judgeSignals: {
        iteration: 3, determination: "PROGRESS", quality_score: 8, tests_verified: true,
        should_continue: true, user_input_needed: false, key_concern: "rate limiting still pending",
      },
      reflectionSignals: {
        iteration: 3, plan_modified: false, iteration_health: "converging",
        key_observation: "auth module integrates cleanly",
      },
    });
    expect(r?.created).toBe(true);
    expect(r?.document.metadata.artifact_type).toBe("iteration-summary");
    expect(r?.document.metadata.judge_determination).toBe("PROGRESS");
    expect(r?.document.metadata.iteration_health).toBe("converging");
  });

  it("returns null when every section is empty", async () => {
    const ws = makeWorkspace();
    const r = await ingestIterationSummary(clio, {
      workspace: ws,
      iteration: 3,
      devSummary: null,
      judgeSignals: null,
      reflectionSignals: null,
    });
    expect(r).toBeNull();
  });

  it("policy=off returns null", async () => {
    const ws = makeWorkspace({ clio: { ingestPolicy: "off" } });
    const r = await ingestIterationSummary(clio, {
      workspace: ws,
      iteration: 3,
      devSummary: "something",
      judgeSignals: null,
      reflectionSignals: null,
    });
    expect(r).toBeNull();
  });
});

// ── ingestRawIterationArtifacts ──────────────────────────────────────────

describe("ingestRawIterationArtifacts", () => {
  it("ingests iteration-log + handoff + judge assessment under policy=all", async () => {
    const ws = makeWorkspace({ clio: { ingestPolicy: "all" } });
    await writeFile(
      join(ws.repoPath, "cfcf-docs", "iteration-logs", "iteration-3.md"),
      "# Iteration 3\n\n## Summary\n\nBody.",
      "utf-8",
    );
    await writeFile(
      join(ws.repoPath, "cfcf-docs", "iteration-handoffs", "iteration-3.md"),
      "# Handoff iter 3\n\nNext steps.",
      "utf-8",
    );
    await writeFile(
      join(ws.repoPath, "cfcf-docs", "iteration-reviews", "iteration-3.md"),
      "# Judge iter 3\n\nPROGRESS.",
      "utf-8",
    );
    const count = await ingestRawIterationArtifacts(clio, ws, 3);
    expect(count).toBe(3);
  });

  it("returns 0 under summaries-only (default)", async () => {
    const ws = makeWorkspace();
    await writeFile(
      join(ws.repoPath, "cfcf-docs", "iteration-logs", "iteration-3.md"),
      "# Iteration 3\n\n## Summary\n\nBody.",
      "utf-8",
    );
    const count = await ingestRawIterationArtifacts(clio, ws, 3);
    expect(count).toBe(0);
  });
});

// ── writeClioRelevant ─────────────────────────────────────────────────────

describe("writeClioRelevant", () => {
  it("generates clio-relevant.md with no hits when the DB is empty", async () => {
    const ws = makeWorkspace();
    const res = await writeClioRelevant(clio, ws, "# Problem\n\nBuild an auth service");
    expect(res.hits).toBe(0);
    const { readFile } = await import("fs/promises");
    const body = await readFile(res.path, "utf-8");
    expect(body).toContain("No relevant cross-workspace context yet");
  });

  it("surfaces hits from other workspaces / Projects", async () => {
    // Seed some documents
    await clio.ingest({
      project: "other-project",
      title: "Sibling reflection",
      content: "# Auth reflection\n\nUse real-time yields instead of fake-timers for authentication race conditions.",
      metadata: { artifact_type: "reflection-analysis", role: "reflection" },
    });
    await clio.ingest({
      project: "test-project",  // same Project as the workspace
      title: "Same-project review",
      content: "# Architect review\n\nreadiness READY for authentication work",
      metadata: { artifact_type: "architect-review", role: "architect" },
    });

    const ws = makeWorkspace();
    const res = await writeClioRelevant(clio, ws, "# Problem\n\nauthentication auth tests flaky");
    expect(res.hits).toBeGreaterThan(0);
    const { readFile } = await import("fs/promises");
    const body = await readFile(res.path, "utf-8");
    expect(body).toContain("Broad matches");
    // Same-Project narrow hits should appear when workspace.clioProject is set.
    expect(body).toContain("test-project");
  });
});
