/**
 * Tests for the architect runner module.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, writeFile, rm } from "fs/promises";
import {
  writeArchitectInstructions,
  resetArchitectSignals,
  parseArchitectSignals,
} from "./architect-runner.js";
import type { WorkspaceConfig, ArchitectSignals } from "./types.js";

const TEST_DIR = join(import.meta.dir, "..", ".test-architect-runner");

function makeProject(overrides?: Partial<WorkspaceConfig>): WorkspaceConfig {
  return {
    id: "test-proj",
    name: "test-project",
    repoPath: TEST_DIR,
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

beforeEach(async () => {
  await mkdir(join(TEST_DIR, "cfcf-docs"), { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("writeArchitectInstructions", () => {
  test("writes instructions with project name", async () => {
    await writeArchitectInstructions(TEST_DIR, makeProject({ name: "my-app" }));
    const { readFile } = await import("fs/promises");
    const content = await readFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-instructions.md"),
      "utf-8",
    );
    expect(content).toContain("my-app");
    expect(content).not.toContain("{{PROJECT_NAME}}");
    expect(content).toContain("Solution Architect");
    expect(content).toContain("plan.md");
  });
});

describe("resetArchitectSignals", () => {
  test("writes template signal file", async () => {
    await resetArchitectSignals(TEST_DIR);
    const { readFile } = await import("fs/promises");
    const content = await readFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      "utf-8",
    );
    const signals = JSON.parse(content);
    expect(signals.readiness).toBe("NEEDS_REFINEMENT");
    expect(signals.gaps).toEqual([]);
  });
});

describe("parseArchitectSignals", () => {
  test("returns null for untouched template", async () => {
    await resetArchitectSignals(TEST_DIR);
    const result = await parseArchitectSignals(TEST_DIR);
    expect(result).toBeNull();
  });

  test("returns parsed signals when filled in", async () => {
    const signals: ArchitectSignals = {
      readiness: "READY",
      gaps: ["Missing error handling spec"],
      suggestions: ["Add rate limiting"],
      risks: ["External API dependency"],
      recommended_approach: "Use Express with Zod validation",
    };
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      JSON.stringify(signals),
      "utf-8",
    );
    const result = await parseArchitectSignals(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.readiness).toBe("READY");
    expect(result!.gaps).toHaveLength(1);
    expect(result!.recommended_approach).toContain("Express");
  });

  test("returns null for missing file", async () => {
    const result = await parseArchitectSignals("/nonexistent");
    expect(result).toBeNull();
  });

  test("returns null for malformed JSON", async () => {
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      "not json",
      "utf-8",
    );
    const result = await parseArchitectSignals(TEST_DIR);
    expect(result).toBeNull();
  });

  test("returns null when readiness is missing", async () => {
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      JSON.stringify({ gaps: ["something"] }),
      "utf-8",
    );
    const result = await parseArchitectSignals(TEST_DIR);
    expect(result).toBeNull();
  });
});
