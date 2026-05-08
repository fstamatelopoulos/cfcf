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

  // Regression: 2026-05-08 — parseArchitectSignals used to reject ANY
  // submission with all-empty supporting fields as "untouched template",
  // which conflated two genuinely different cases:
  //   (a) The agent never edited the file. Reject.
  //   (b) The agent legitimately found nothing to add (a clean re-review
  //       of a complete project). With readiness == READY or
  //       SCOPE_COMPLETE, empty arrays + null recommended_approach are
  //       the correct semantic answer.
  // Surfaced when qwen3-coder ran the SA on a calc workspace whose plan
  // was 100% complete; qwen produced READY + empty arrays (correct) and
  // cfcf paused with "signal file missing or malformed" (incorrect).
  // Fix: only reject empty supporting fields when readiness is one of
  // the values that semantically demand explanation (NEEDS_REFINEMENT,
  // BLOCKED). The four tests below pin both halves of the contract.

  test("accepts READY with empty supporting fields (clean re-review verdict)", async () => {
    const signals: ArchitectSignals = {
      readiness: "READY",
      gaps: [],
      suggestions: [],
      risks: [],
      // recommended_approach intentionally omitted — equivalent to null
    };
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      JSON.stringify(signals),
      "utf-8",
    );
    const result = await parseArchitectSignals(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.readiness).toBe("READY");
  });

  test("accepts SCOPE_COMPLETE with empty supporting fields", async () => {
    const signals: ArchitectSignals = {
      readiness: "SCOPE_COMPLETE",
      gaps: [],
      suggestions: [],
      risks: [],
    };
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      JSON.stringify(signals),
      "utf-8",
    );
    const result = await parseArchitectSignals(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.readiness).toBe("SCOPE_COMPLETE");
  });

  test("rejects NEEDS_REFINEMENT with empty fields (untouched template)", async () => {
    // The cfcf template ships with `readiness: "NEEDS_REFINEMENT"` + all
    // empty arrays + null recommended_approach. If we get this exact
    // shape back, the agent never touched the file.
    const signals: ArchitectSignals = {
      readiness: "NEEDS_REFINEMENT",
      gaps: [],
      suggestions: [],
      risks: [],
    };
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      JSON.stringify(signals),
      "utf-8",
    );
    const result = await parseArchitectSignals(TEST_DIR);
    expect(result).toBeNull();
  });

  test("rejects BLOCKED with empty fields (template-shaped)", async () => {
    // BLOCKED with no gaps/risks/suggestions is suspicious — if the
    // agent really meant BLOCKED, it should explain why. Treat as
    // template-untouched.
    const signals: ArchitectSignals = {
      readiness: "BLOCKED",
      gaps: [],
      suggestions: [],
      risks: [],
    };
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      JSON.stringify(signals),
      "utf-8",
    );
    const result = await parseArchitectSignals(TEST_DIR);
    expect(result).toBeNull();
  });
});
