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
  countPlanItems,
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

  // Regression: 2026-05-08 — agents (qwen3-coder specifically) returning
  // READY for a fully-shipped project where the right answer is
  // SCOPE_COMPLETE. Defensive auto-promotion in parseArchitectSignals
  // checks plan.md and overrides READY → SCOPE_COMPLETE when there are
  // completed items and zero pending. Tests below pin the boundary
  // conditions.

  test("promotes READY → SCOPE_COMPLETE when plan.md has all completed items + zero pending", async () => {
    const signals: ArchitectSignals = {
      readiness: "READY",
      gaps: [],
      suggestions: [],
      risks: [],
    };
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      JSON.stringify(signals),
      "utf-8",
    );
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "plan.md"),
      "# Plan\n\n- [x] Done item one\n- [x] Done item two\n",
      "utf-8",
    );
    const result = await parseArchitectSignals(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.readiness).toBe("SCOPE_COMPLETE");
  });

  test("does NOT promote READY when plan.md still has pending items", async () => {
    const signals: ArchitectSignals = {
      readiness: "READY",
      gaps: [],
      suggestions: [],
      risks: [],
    };
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      JSON.stringify(signals),
      "utf-8",
    );
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "plan.md"),
      "# Plan\n\n- [x] Done\n- [ ] Pending one\n- [ ] Pending two\n",
      "utf-8",
    );
    const result = await parseArchitectSignals(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.readiness).toBe("READY");
  });

  test("does NOT promote READY when plan.md is empty (first-run mode)", async () => {
    // No `[x]` items + no `[ ]` items = no plan yet (first-run
    // architect just scaffolded an empty stub, or the file is
    // missing). Don't auto-promote — we'd be inferring SCOPE_COMPLETE
    // from absence-of-data which is not safe.
    const signals: ArchitectSignals = {
      readiness: "READY",
      gaps: [],
      suggestions: [],
      risks: [],
    };
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      JSON.stringify(signals),
      "utf-8",
    );
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "plan.md"),
      "# Plan\n\nTodo list will go here.\n",
      "utf-8",
    );
    const result = await parseArchitectSignals(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.readiness).toBe("READY");
  });

  test("does NOT promote READY when plan.md is missing", async () => {
    const signals: ArchitectSignals = {
      readiness: "READY",
      gaps: [],
      suggestions: [],
      risks: [],
    };
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      JSON.stringify(signals),
      "utf-8",
    );
    // Don't create plan.md
    const result = await parseArchitectSignals(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.readiness).toBe("READY");
  });

  test("does NOT touch SCOPE_COMPLETE / NEEDS_REFINEMENT / BLOCKED verdicts", async () => {
    // Auto-promotion only fires when readiness === "READY". Other
    // verdicts pass through unchanged regardless of plan.md state.
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "plan.md"),
      "# Plan\n\n- [x] Done one\n- [x] Done two\n",
      "utf-8",
    );
    for (const r of ["SCOPE_COMPLETE", "NEEDS_REFINEMENT", "BLOCKED"] as const) {
      const signals: ArchitectSignals = {
        readiness: r,
        gaps: r === "READY" || r === "SCOPE_COMPLETE" ? [] : ["dummy gap"],
        suggestions: r === "READY" || r === "SCOPE_COMPLETE" ? [] : ["dummy suggestion"],
        risks: r === "READY" || r === "SCOPE_COMPLETE" ? [] : ["dummy risk"],
      };
      await writeFile(
        join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
        JSON.stringify(signals),
        "utf-8",
      );
      const result = await parseArchitectSignals(TEST_DIR);
      expect(result).not.toBeNull();
      expect(result!.readiness).toBe(r);
    }
  });
});

describe("countPlanItems", () => {
  test("counts standard `- [ ]` and `- [x]` checkboxes", () => {
    const plan = `# Plan

## Iteration 1
- [x] First item
- [x] Second item

## Iteration 2
- [ ] Pending one
- [ ] Pending two
- [x] Already done in iter 2
`;
    expect(countPlanItems(plan)).toEqual({ pending: 2, completed: 3 });
  });

  test("accepts capital X for completed items", () => {
    expect(countPlanItems("- [X] Done\n- [x] Also done\n")).toEqual({ pending: 0, completed: 2 });
  });

  test("accepts `*` and `+` bullet markers", () => {
    expect(countPlanItems("* [x] one\n+ [ ] two\n- [x] three\n")).toEqual({ pending: 1, completed: 2 });
  });

  test("ignores non-checkbox lines", () => {
    const plan = `# Plan

Regular text lines aren't counted.
And [bracketed text] without checkboxes isn't either.
- Plain bullet, no checkbox
- [x] This counts
`;
    expect(countPlanItems(plan)).toEqual({ pending: 0, completed: 1 });
  });

  test("returns zeros for an empty plan", () => {
    expect(countPlanItems("")).toEqual({ pending: 0, completed: 0 });
    expect(countPlanItems("# Plan\n\nNo checkboxes here.\n")).toEqual({ pending: 0, completed: 0 });
  });
});
