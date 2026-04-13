/**
 * Tests for the judge runner module.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, writeFile, readFile, rm } from "fs/promises";
import {
  writeJudgeInstructions,
  resetJudgeSignals,
  parseJudgeSignals,
  parseJudgeAssessment,
  archiveJudgeAssessment,
  summarizeJudgeAssessment,
  buildJudgeCommand,
} from "./judge-runner.js";
import type { ProjectConfig, JudgeSignals } from "./types.js";

const TEST_DIR = join(import.meta.dir, "..", ".test-judge-runner");

function makeProject(overrides?: Partial<ProjectConfig>): ProjectConfig {
  return {
    id: "test-proj",
    name: "test-project",
    repoPath: TEST_DIR,
    devAgent: { adapter: "claude-code" },
    judgeAgent: { adapter: "codex" },
    architectAgent: { adapter: "claude-code" },
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
  await mkdir(join(TEST_DIR, "cfcf-docs", "iteration-reviews"), { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("writeJudgeInstructions", () => {
  test("writes instructions with correct placeholders", async () => {
    await writeJudgeInstructions(TEST_DIR, makeProject(), 3);
    const content = await readFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-judge-instructions.md"),
      "utf-8",
    );
    expect(content).toContain("Iteration 3");
    expect(content).toContain("test-project");
    expect(content).not.toContain("{{ITERATION}}");
    expect(content).not.toContain("{{PROJECT_NAME}}");
  });
});

describe("resetJudgeSignals", () => {
  test("writes template signal file", async () => {
    await resetJudgeSignals(TEST_DIR);
    const content = await readFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-judge-signals.json"),
      "utf-8",
    );
    const signals = JSON.parse(content);
    expect(signals.iteration).toBe(0);
    expect(signals.determination).toBe("PROGRESS");
    expect(signals.quality_score).toBe(5);
  });
});

describe("parseJudgeSignals", () => {
  test("returns null for template file (untouched)", async () => {
    await resetJudgeSignals(TEST_DIR);
    const result = await parseJudgeSignals(TEST_DIR);
    expect(result).toBeNull();
  });

  test("returns parsed signals when filled in", async () => {
    const signals: JudgeSignals = {
      iteration: 3,
      determination: "PROGRESS",
      quality_score: 7,
      tests_verified: true,
      tests_passed: 10,
      tests_failed: 2,
      tests_total: 12,
      should_continue: true,
      user_input_needed: false,
      key_concern: "Error handling incomplete",
    };
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-judge-signals.json"),
      JSON.stringify(signals),
      "utf-8",
    );
    const result = await parseJudgeSignals(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.determination).toBe("PROGRESS");
    expect(result!.quality_score).toBe(7);
    expect(result!.key_concern).toBe("Error handling incomplete");
  });

  test("returns null for missing file", async () => {
    const result = await parseJudgeSignals("/nonexistent");
    expect(result).toBeNull();
  });

  test("returns null for malformed JSON", async () => {
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-judge-signals.json"),
      "not json",
      "utf-8",
    );
    const result = await parseJudgeSignals(TEST_DIR);
    expect(result).toBeNull();
  });
});

describe("parseJudgeAssessment", () => {
  test("returns null for missing file", async () => {
    const result = await parseJudgeAssessment("/nonexistent");
    expect(result).toBeNull();
  });

  test("returns null for very short content", async () => {
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "judge-assessment.md"),
      "Short",
      "utf-8",
    );
    const result = await parseJudgeAssessment(TEST_DIR);
    expect(result).toBeNull();
  });

  test("returns content for substantial assessment", async () => {
    const assessment = "# Judge Assessment\n\n## Summary\nThe iteration made good progress on the core features.\n\n## Quality\nScore: 7/10";
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "judge-assessment.md"),
      assessment,
      "utf-8",
    );
    const result = await parseJudgeAssessment(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result).toContain("good progress");
  });
});

describe("archiveJudgeAssessment", () => {
  test("copies assessment to iteration-reviews/", async () => {
    const assessment = "# Iteration 2 Judge Assessment\n\nGood work.";
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "judge-assessment.md"),
      assessment,
      "utf-8",
    );
    const success = await archiveJudgeAssessment(TEST_DIR, 2);
    expect(success).toBe(true);

    const archived = await readFile(
      join(TEST_DIR, "cfcf-docs", "iteration-reviews", "iteration-2.md"),
      "utf-8",
    );
    expect(archived).toBe(assessment);
  });

  test("returns false when source file missing", async () => {
    const success = await archiveJudgeAssessment(TEST_DIR, 99);
    expect(success).toBe(false);
  });
});

describe("summarizeJudgeAssessment", () => {
  test("returns summary from signals", () => {
    const signals: JudgeSignals = {
      iteration: 1,
      determination: "PROGRESS",
      quality_score: 8,
      tests_verified: true,
      tests_passed: 10,
      tests_failed: 0,
      tests_total: 10,
      should_continue: true,
      user_input_needed: false,
      key_concern: "Minor edge cases",
    };
    const summary = summarizeJudgeAssessment(signals, null);
    expect(summary).toContain("PROGRESS");
    expect(summary).toContain("8/10");
    expect(summary).toContain("10/10");
    expect(summary).toContain("Minor edge cases");
  });

  test("handles null signals", () => {
    const summary = summarizeJudgeAssessment(null, null);
    expect(summary).toContain("not received");
  });

  test("extracts summary from assessment markdown", () => {
    const assessment = "# Assessment\n\n## Summary\nGreat iteration with solid test coverage.\n\n## Details\n...";
    const signals: JudgeSignals = {
      iteration: 1,
      determination: "PROGRESS",
      quality_score: 7,
      tests_verified: true,
      should_continue: true,
      user_input_needed: false,
    };
    const summary = summarizeJudgeAssessment(signals, assessment);
    expect(summary).toContain("Great iteration");
  });
});

describe("buildJudgeCommand", () => {
  test("builds command for codex adapter", () => {
    const cmd = buildJudgeCommand(makeProject({ judgeAgent: { adapter: "codex" } }));
    expect(cmd).not.toBeNull();
    expect(cmd!.command).toBe("codex");
    expect(cmd!.args).toContain("exec");
    expect(cmd!.args).toContain("--full-auto");
    expect(cmd!.args).toContain("-a");
    expect(cmd!.args).toContain("never");
  });

  test("builds command with model parameter", () => {
    const cmd = buildJudgeCommand(
      makeProject({ judgeAgent: { adapter: "claude-code", model: "opus" } }),
    );
    expect(cmd).not.toBeNull();
    expect(cmd!.command).toBe("claude");
    expect(cmd!.args).toContain("--model");
    expect(cmd!.args).toContain("opus");
  });

  test("returns null for unknown adapter", () => {
    const cmd = buildJudgeCommand(makeProject({ judgeAgent: { adapter: "unknown" } }));
    expect(cmd).toBeNull();
  });
});
