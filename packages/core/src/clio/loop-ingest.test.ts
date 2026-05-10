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
  ingestProblemPack,
  PROBLEM_PACK_FILES,
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

  it("defaults to 'all' when neither is set", async () => {
    const ws = makeWorkspace({ clio: undefined });
    expect(await resolveIngestPolicy(ws)).toBe("all");
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
    const ws = makeWorkspace({ clio: { ingestPolicy: "summaries-only" } });
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

  it("returns 0 under summaries-only", async () => {
    const ws = makeWorkspace({ clio: { ingestPolicy: "summaries-only" } });
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

// ── ingestProblemPack (item 6.9 follow-up) ────────────────────────────────

describe("ingestProblemPack", () => {
  async function seedProblemPack(opts: Partial<Record<typeof PROBLEM_PACK_FILES[number], string>>) {
    const cfcfDocs = join(repoDir, "cfcf-docs");
    await mkdir(cfcfDocs, { recursive: true });
    for (const [filename, content] of Object.entries(opts)) {
      if (content !== undefined) {
        await writeFile(join(cfcfDocs, filename), content, "utf-8");
      }
    }
  }

  it("creates one Clio doc per problem-pack file with the canonical metadata triple", async () => {
    const ws = makeWorkspace();
    await seedProblemPack({
      "problem.md": "# Problem\n\nBuild an OAuth-secured API for tracker.",
      "success.md": "# Success\n\nTests pass + docs generated.",
      "constraints.md": "# Constraints\n\nNo external dependencies.",
      // hints.md + style-guide.md absent on disk
    });

    const result = await ingestProblemPack(clio, ws, "iteration-start");
    expect(result.ingested).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.missing).toBe(2); // hints.md + style-guide.md

    // Each doc lands with the right metadata + title.
    const docs = await clio.listDocuments({ project: "test-project" });
    const problemPackDocs = docs.filter(
      (d) => (d.metadata as { artifact_type?: string })?.artifact_type === "problem-pack",
    );
    expect(problemPackDocs).toHaveLength(3);

    const titles = problemPackDocs.map((d) => d.title).sort();
    expect(titles).toEqual([
      "myws: problem-pack constraints.md",
      "myws: problem-pack problem.md",
      "myws: problem-pack success.md",
    ]);

    // Metadata is consistent across the set.
    for (const doc of problemPackDocs) {
      const md = doc.metadata as Record<string, unknown>;
      expect(md.role).toBe("user");
      expect(md.artifact_type).toBe("problem-pack");
      expect(md.workspace_id).toBe(ws.id);
      expect(md.workspace_name).toBe(ws.name);
      expect(typeof md.filename).toBe("string");
      expect(PROBLEM_PACK_FILES).toContain(md.filename as typeof PROBLEM_PACK_FILES[number]);
    }
  });

  it("is idempotent on unchanged content (sha256 dedup → action=skipped)", async () => {
    const ws = makeWorkspace();
    await seedProblemPack({
      "problem.md": "# Problem\n\nIdempotency probe.",
    });

    const r1 = await ingestProblemPack(clio, ws, "iteration-start");
    expect(r1.ingested).toBe(1);
    expect(r1.perFile.find((f) => f.filename === "problem.md")?.action).toBe("created");

    const r2 = await ingestProblemPack(clio, ws, "iteration-start");
    // Second call: backend's sha256 dedup returns action="skipped"
    // because the file's content hash matches the live version.
    expect(r2.ingested).toBe(0);
    expect(r2.skipped).toBe(1);
    expect(r2.perFile.find((f) => f.filename === "problem.md")?.action).toBe("skipped");

    // Doc count in Clio is unchanged — no duplicate row created.
    const docs = await clio.listDocuments({ project: "test-project" });
    const problemDocs = docs.filter((d) => d.title === "myws: problem-pack problem.md");
    expect(problemDocs).toHaveLength(1);
  });

  it("updates the existing doc in place when content changes (no duplicate row)", async () => {
    const ws = makeWorkspace();
    await seedProblemPack({ "problem.md": "# Problem\n\nv1 text." });
    const r1 = await ingestProblemPack(clio, ws, "iteration-start");
    const v1DocId = r1.perFile[0].documentId;
    expect(v1DocId).toBeTruthy();

    // User edits the file (PA's typical mid-session pattern).
    await seedProblemPack({ "problem.md": "# Problem\n\nv2 text — refined after PA review." });
    const r2 = await ingestProblemPack(clio, ws, "pa-session-end");
    expect(r2.ingested).toBe(1);
    expect(r2.perFile[0].action).toBe("updated");
    // Same doc id — update-by-title within the project, not a fresh create.
    expect(r2.perFile[0].documentId).toBe(v1DocId);

    // Still one row for problem.md (the update snapshotted the prior
    // version into clio_document_versions; live row is the new content).
    const docs = await clio.listDocuments({ project: "test-project" });
    const problemDocs = docs.filter((d) => d.title === "myws: problem-pack problem.md");
    expect(problemDocs).toHaveLength(1);
  });

  it("respects workspace.clio.ingestPolicy = 'off' (skips everything)", async () => {
    const ws = makeWorkspace({ clio: { ingestPolicy: "off" } });
    await seedProblemPack({
      "problem.md": "# Problem\n\nShould be ignored.",
    });

    const result = await ingestProblemPack(clio, ws, "iteration-start");
    expect(result.ingested).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.missing).toBe(0);
    expect(result.perFile).toHaveLength(0);

    const docs = await clio.listDocuments({ project: "test-project" });
    expect(docs).toHaveLength(0);
  });

  it("routes to the workspace's effective Clio Project (cf-workspace-<id> when clioProject unset)", async () => {
    // Simulate a pre-6.9 workspace with no clioProject set on its
    // config — effectiveClioProject() falls back to cf-workspace-<id>.
    const ws = makeWorkspace({ clioProject: undefined });
    await seedProblemPack({ "problem.md": "# Problem\n\nRouting probe." });

    await ingestProblemPack(clio, ws, "workspace-init");

    const docs = await clio.listDocuments({ project: `cf-workspace-${ws.id}` });
    expect(docs.find((d) => d.title.includes("problem-pack problem.md"))).toBeTruthy();
  });

  it("respects an explicit shared clioProject (e.g. backend-services)", async () => {
    const ws = makeWorkspace({ clioProject: "backend-services" });
    await seedProblemPack({ "problem.md": "# Problem\n\nShared-project probe." });

    await ingestProblemPack(clio, ws, "workspace-init");

    const sharedDocs = await clio.listDocuments({ project: "backend-services" });
    expect(sharedDocs.find((d) => d.title.includes("problem-pack problem.md"))).toBeTruthy();
    // And NOT in the per-workspace fallback project.
    const fallbackDocs = await clio.listDocuments({ project: `cf-workspace-${ws.id}` });
    expect(fallbackDocs.find((d) => d.title.includes("problem-pack"))).toBeFalsy();
  });

  it("stamps the trigger source so audit + usage logs can distinguish entry points", async () => {
    const ws = makeWorkspace();
    await seedProblemPack({ "problem.md": "# Problem\n\nTrigger probe." });

    const result = await ingestProblemPack(clio, ws, "pa-session-end");
    const docId = result.perFile[0].documentId!;
    const doc = await clio.getDocument(docId);
    expect(doc?.source).toContain("cfcf-auto:problem-pack:problem.md:pa-session-end");
    expect((doc?.metadata as Record<string, unknown>)?.ingest_trigger).toBe("pa-session-end");
  });

  it("surfaces missing files but doesn't fail the call", async () => {
    const ws = makeWorkspace();
    // No problem-pack files seeded at all.

    const result = await ingestProblemPack(clio, ws, "iteration-start");
    expect(result.ingested).toBe(0);
    expect(result.missing).toBe(PROBLEM_PACK_FILES.length);
    for (const entry of result.perFile) {
      expect(entry.action).toBe("missing");
    }
  });

  it("writes a `internal` access-path usage row alongside the audit-log row (item 6.35 follow-up)", async () => {
    // Pre-fix: auto-ingest hooks called backend.ingest() directly,
    // bypassing the HTTP middleware. The Audit tab saw the writes
    // (audit-log is internal to LocalClio) but the Usage tab missed
    // them — confusing inconsistency. This test pins the new
    // recordInternalUsage() behaviour: each problem-pack ingest
    // produces a clio_usage_log row with accessPath="internal" so
    // the Usage tab + `cfcf clio usage` see them.
    const ws = makeWorkspace();
    await seedProblemPack({ "problem.md": "# Problem\n\nProbe." });

    await ingestProblemPack(clio, ws, "iteration-start");

    const usage = await clio.getUsageLog({ accessPath: "internal" });
    const ingestRow = usage.find((u) =>
      u.operation === "ingest" &&
      typeof u.extra === "object" &&
      u.extra !== null &&
      (u.extra as Record<string, unknown>).artifact_type === "problem-pack",
    );
    expect(ingestRow).toBeTruthy();
    // Requestor stamp follows the role|cfcf|system convention for
    // user-stakeholder problem-pack writes (NOT user|cli|default —
    // the auto-ingest path is cfcf-driven, not human-CLI-driven).
    expect(ingestRow?.requestor).toBe("user|cfcf|system");
    expect(ingestRow?.accessPath).toBe("internal");
  });

  it("treats whitespace-only content as missing (won't create empty docs)", async () => {
    const ws = makeWorkspace();
    await seedProblemPack({
      "problem.md": "   \n\n\t\n",
    });
    const result = await ingestProblemPack(clio, ws, "iteration-start");
    expect(result.ingested).toBe(0);
    expect(result.missing).toBe(PROBLEM_PACK_FILES.length); // including the empty problem.md
  });

  it("default actor stamps the WRITER as user|cfcf|system (cfcf-driven, no role agent)", async () => {
    const ws = makeWorkspace();
    await seedProblemPack({ "problem.md": "# Problem\n\nDefault actor probe." });

    const result = await ingestProblemPack(clio, ws, "iteration-start");
    const docId = result.perFile[0].documentId!;
    const doc = await clio.getDocument(docId);
    expect(doc?.author).toBe("user|cfcf|system");
    // role: "user" stays in metadata regardless — the user OWNS the spec
    // content even when iteration-start triggers the ingest.
    expect((doc?.metadata as Record<string, unknown>)?.role).toBe("user");
  });

  it("actorOverride stamps the actual writer (PA case) without changing the metadata role (item 6.9 follow-up)", async () => {
    const ws = makeWorkspace();
    await seedProblemPack({ "problem.md": "# Problem\n\nPA wrote this." });

    const paActor = "product-architect|claude-code|sonnet";
    const result = await ingestProblemPack(clio, ws, "pa-session-end", paActor);
    const docId = result.perFile[0].documentId!;
    const doc = await clio.getDocument(docId);

    // author column = the OVERRIDE: the audit log shows PA as the
    // writer, so a future search for "what did PA do?" surfaces this.
    expect(doc?.author).toBe(paActor);
    // role STAYS "user" because that's the semantic stakeholder of
    // the problem-pack content, not a PA artefact.
    expect((doc?.metadata as Record<string, unknown>)?.role).toBe("user");
    // ingest_trigger captures the entry-point separately so analytics
    // can distinguish PA-driven from cfcf-driven from boot-reconcile.
    expect((doc?.metadata as Record<string, unknown>)?.ingest_trigger).toBe("pa-session-end");
  });

  it("supports the pa-boot-reconcile trigger (item 6.9 follow-up — PA died before session-end fallback)", async () => {
    const ws = makeWorkspace();
    await seedProblemPack({
      "problem.md": "# Problem\n\nMid-edit content that PA's killed-process left on disk.",
    });

    const result = await ingestProblemPack(
      clio,
      ws,
      "pa-boot-reconcile",
      "product-architect|claude-code|sonnet",
    );
    expect(result.ingested).toBe(1);
    expect(result.perFile[0].action).toBe("created");
    const doc = await clio.getDocument(result.perFile[0].documentId!);
    expect((doc?.metadata as Record<string, unknown>)?.ingest_trigger).toBe("pa-boot-reconcile");
    expect(doc?.source).toContain("pa-boot-reconcile");
  });
});
