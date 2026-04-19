/**
 * Tests for the three 5.1 config keys: autoReviewSpecs, autoDocumenter,
 * readinessGate. Covers:
 *   - resolveLoopConfig (per-run overrides > project config > hard defaults)
 *   - readinessGateBlocks (the readiness-gate policy table)
 *   - backfill behaviour on older configs/projects loaded without the keys
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { resolveLoopConfig, type LoopState } from "./iteration-loop.js";
import { readinessGateBlocks } from "./architect-runner.js";
import type { ProjectConfig } from "./types.js";
import { getProject } from "./projects.js";
import { createDefaultConfig, writeConfig } from "./config.js";

function makeProject(overrides?: Partial<ProjectConfig>): ProjectConfig {
  return {
    id: "test-proj",
    name: "test-project",
    repoPath: "/tmp/test-repo",
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
    ...overrides,
  };
}

function makeLoopState(overrides?: Partial<LoopState>): LoopState {
  return {
    projectId: "test-proj",
    projectName: "test-project",
    phase: "idle",
    currentIteration: 0,
    maxIterations: 10,
    pauseEvery: 0,
    startedAt: new Date().toISOString(),
    iterations: [],
    consecutiveStalled: 0,
    ...overrides,
  };
}

describe("resolveLoopConfig (item 5.1)", () => {
  it("falls back to hard defaults when nothing is set", () => {
    const cfg = resolveLoopConfig(makeProject(), makeLoopState());
    expect(cfg.autoReviewSpecs).toBe(false);
    expect(cfg.autoDocumenter).toBe(true);
    expect(cfg.readinessGate).toBe("blocked");
  });

  it("uses project config when set", () => {
    const cfg = resolveLoopConfig(
      makeProject({
        autoReviewSpecs: true,
        autoDocumenter: false,
        readinessGate: "needs_refinement_or_blocked",
      }),
      makeLoopState(),
    );
    expect(cfg.autoReviewSpecs).toBe(true);
    expect(cfg.autoDocumenter).toBe(false);
    expect(cfg.readinessGate).toBe("needs_refinement_or_blocked");
  });

  it("per-run override wins over project config", () => {
    const cfg = resolveLoopConfig(
      makeProject({
        autoReviewSpecs: true,
        autoDocumenter: true,
        readinessGate: "blocked",
      }),
      makeLoopState({
        runOverrides: {
          autoReviewSpecs: false,
          autoDocumenter: false,
          readinessGate: "never",
        },
      }),
    );
    expect(cfg.autoReviewSpecs).toBe(false);
    expect(cfg.autoDocumenter).toBe(false);
    expect(cfg.readinessGate).toBe("never");
  });

  it("partial override leaves other keys alone", () => {
    const cfg = resolveLoopConfig(
      makeProject({
        autoReviewSpecs: true,
        autoDocumenter: false,
        readinessGate: "blocked",
      }),
      makeLoopState({
        runOverrides: { autoReviewSpecs: false },
      }),
    );
    expect(cfg.autoReviewSpecs).toBe(false);
    expect(cfg.autoDocumenter).toBe(false); // project still wins
    expect(cfg.readinessGate).toBe("blocked");
  });
});

describe("readinessGateBlocks (item 5.1)", () => {
  it("'never' never blocks", () => {
    expect(readinessGateBlocks("READY", "never")).toBe(false);
    expect(readinessGateBlocks("NEEDS_REFINEMENT", "never")).toBe(false);
    expect(readinessGateBlocks("BLOCKED", "never")).toBe(false);
    expect(readinessGateBlocks(undefined, "never")).toBe(false);
  });

  it("'blocked' (default) blocks only on BLOCKED", () => {
    expect(readinessGateBlocks("READY", "blocked")).toBe(false);
    expect(readinessGateBlocks("NEEDS_REFINEMENT", "blocked")).toBe(false);
    expect(readinessGateBlocks("BLOCKED", "blocked")).toBe(true);
  });

  it("'blocked' is pessimistic on missing signals", () => {
    expect(readinessGateBlocks(undefined, "blocked")).toBe(true);
  });

  it("'needs_refinement_or_blocked' blocks on anything but READY", () => {
    expect(readinessGateBlocks("READY", "needs_refinement_or_blocked")).toBe(false);
    expect(readinessGateBlocks("NEEDS_REFINEMENT", "needs_refinement_or_blocked")).toBe(true);
    expect(readinessGateBlocks("BLOCKED", "needs_refinement_or_blocked")).toBe(true);
    expect(readinessGateBlocks(undefined, "needs_refinement_or_blocked")).toBe(true);
  });
});

describe("Config backfill for older configs (item 5.1)", () => {
  let origDir: string | undefined;
  let tmp: string;

  beforeEach(async () => {
    origDir = process.env.CFCF_CONFIG_DIR;
    tmp = await mkdtemp(join(tmpdir(), "cfcf-autoflags-"));
    process.env.CFCF_CONFIG_DIR = tmp;
  });

  afterEach(async () => {
    if (origDir === undefined) delete process.env.CFCF_CONFIG_DIR;
    else process.env.CFCF_CONFIG_DIR = origDir;
    await rm(tmp, { recursive: true, force: true });
  });

  it("a fresh default config has the three keys set", async () => {
    const cfg = createDefaultConfig(["claude-code", "codex"]);
    await writeConfig(cfg);
    const { readConfig } = await import("./config.js");
    const read = await readConfig();
    expect(read).not.toBeNull();
    expect(read!.autoReviewSpecs).toBe(false);
    expect(read!.autoDocumenter).toBe(true);
    expect(read!.readinessGate).toBe("blocked");
  });

  it("a pre-5.1 config file is backfilled on read", async () => {
    // Write a config that deliberately omits the 5.1 keys
    const cfg = createDefaultConfig(["claude-code"]);
    delete (cfg as Partial<typeof cfg>).autoReviewSpecs;
    delete (cfg as Partial<typeof cfg>).autoDocumenter;
    delete (cfg as Partial<typeof cfg>).readinessGate;
    await writeConfig(cfg);
    const { readConfig } = await import("./config.js");
    const read = await readConfig();
    expect(read!.autoReviewSpecs).toBe(false);
    expect(read!.autoDocumenter).toBe(true);
    expect(read!.readinessGate).toBe("blocked");
  });

  it("a pre-5.1 project config is backfilled on getProject()", async () => {
    const cfg = createDefaultConfig(["claude-code"]);
    await writeConfig(cfg);

    const projId = "old-proj-xyz";
    const projDir = join(tmp, "projects", projId);
    await mkdir(projDir, { recursive: true });
    // Pre-5.1 project config: no autoReviewSpecs / autoDocumenter / readinessGate keys
    await writeFile(
      join(projDir, "config.json"),
      JSON.stringify({
        id: projId,
        name: "old-proj",
        repoPath: "/tmp/x",
        devAgent: { adapter: "claude-code" },
        judgeAgent: { adapter: "codex" },
        architectAgent: { adapter: "claude-code" },
        documenterAgent: { adapter: "claude-code" },
        maxIterations: 10,
        pauseEvery: 0,
        onStalled: "alert",
        mergeStrategy: "auto",
        processTemplate: "default",
        currentIteration: 2,
      }),
      "utf-8",
    );

    const loaded = await getProject(projId);
    expect(loaded).not.toBeNull();
    expect(loaded!.autoReviewSpecs).toBe(false);
    expect(loaded!.autoDocumenter).toBe(true);
    expect(loaded!.readinessGate).toBe("blocked");
  });
});
