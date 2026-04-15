import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, readFile, access } from "fs/promises";
import { tmpdir } from "os";
import {
  writeContextToRepo,
  generateInstructionContent,
  parseHandoffDocument,
  parseSignalFile,
  generateIterationSummary,
} from "./context-assembler.js";
import type { ProblemPack } from "./problem-pack.js";
import type { IterationContext } from "./context-assembler.js";
import type { ProjectConfig } from "./types.js";

function makePack(overrides?: Partial<ProblemPack>): ProblemPack {
  return {
    problem: "# Problem\nBuild a calculator.",
    success: "# Success\nAll tests pass.",
    context: [],
    sourcePath: "/tmp/test-pack",
    ...overrides,
  };
}

function makeProject(overrides?: Partial<ProjectConfig>): ProjectConfig {
  return {
    id: "test-proj-abc123",
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

function makeCtx(overrides?: Partial<IterationContext>): IterationContext {
  return {
    iteration: 1,
    problemPack: makePack(),
    project: makeProject(),
    ...overrides,
  };
}

describe("context-assembler", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cfcf-ctx-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("writeContextToRepo", () => {
    it("creates cfcf-docs/ with all required files", async () => {
      await writeContextToRepo(tempDir, makeCtx());

      // Check required files exist
      await access(join(tempDir, "cfcf-docs", "problem.md"));
      await access(join(tempDir, "cfcf-docs", "success.md"));
      await access(join(tempDir, "cfcf-docs", "process.md"));
      await access(join(tempDir, "cfcf-docs", "plan.md"));
      await access(join(tempDir, "cfcf-docs", "decision-log.md"));
      await access(join(tempDir, "cfcf-docs", "iteration-handoff.md"));
      await access(join(tempDir, "cfcf-docs", "cfcf-iteration-signals.json"));
      await access(join(tempDir, "cfcf-docs", "iteration-history.md"));
      await access(join(tempDir, "cfcf-docs", "judge-assessment.md"));
      await access(join(tempDir, "cfcf-docs", "user-feedback.md"));
    });

    it("writes problem.md from problem pack", async () => {
      await writeContextToRepo(tempDir, makeCtx());
      const content = await readFile(join(tempDir, "cfcf-docs", "problem.md"), "utf-8");
      expect(content).toContain("Build a calculator");
    });

    it("writes optional files when present", async () => {
      const ctx = makeCtx({
        problemPack: makePack({ constraints: "No globals", hints: "Use TypeScript" }),
      });
      await writeContextToRepo(tempDir, ctx);

      const constraints = await readFile(join(tempDir, "cfcf-docs", "constraints.md"), "utf-8");
      expect(constraints).toBe("No globals");
    });

    it("does not overwrite agent-editable files on second call", async () => {
      await writeContextToRepo(tempDir, makeCtx());

      // Simulate agent editing plan.md
      const { writeFile } = await import("fs/promises");
      await writeFile(join(tempDir, "cfcf-docs", "plan.md"), "Agent's plan\n", "utf-8");

      // Write context again (iteration 2)
      await writeContextToRepo(tempDir, makeCtx({ iteration: 2 }));

      const plan = await readFile(join(tempDir, "cfcf-docs", "plan.md"), "utf-8");
      expect(plan).toBe("Agent's plan\n"); // Not overwritten
    });

    it("refreshes handoff template each iteration", async () => {
      await writeContextToRepo(tempDir, makeCtx());

      // Simulate agent filling in handoff
      const { writeFile } = await import("fs/promises");
      await writeFile(join(tempDir, "cfcf-docs", "iteration-handoff.md"), "Filled in handoff\n", "utf-8");

      // Write context again (iteration 2) -- handoff should be reset
      await writeContextToRepo(tempDir, makeCtx({ iteration: 2 }));

      const handoff = await readFile(join(tempDir, "cfcf-docs", "iteration-handoff.md"), "utf-8");
      expect(handoff).toContain("Iteration Handoff"); // Template again
    });
  });

  describe("generateInstructionContent", () => {
    it("generates instruction content for first iteration", () => {
      const content = generateInstructionContent(makeCtx());
      expect(content).toContain("Iteration 1");
      expect(content).toContain("test-project");
      expect(content).toContain("Problem Summary");
      expect(content).toContain("Success Criteria");
      expect(content).toContain("first iteration");
      expect(content).toContain("cfcf-docs/process.md");
    });

    it("generates different content for later iterations", () => {
      const content = generateInstructionContent(makeCtx({ iteration: 3 }));
      expect(content).toContain("Iteration 3");
      expect(content).toContain("iteration 3");
      expect(content).toContain("iteration-history.md");
    });

    it("includes judge feedback when present", () => {
      const content = generateInstructionContent(
        makeCtx({ previousJudgeAssessment: "Good progress on the calculator." }),
      );
      expect(content).toContain("Previous Judge Feedback");
      expect(content).toContain("Good progress");
    });

    it("includes tier 3 pointers for optional files", () => {
      const content = generateInstructionContent(
        makeCtx({
          problemPack: makePack({
            constraints: "no globals",
            hints: "use TypeScript",
            context: [{ filename: "api.md", content: "api docs" }],
          }),
        }),
      );
      expect(content).toContain("constraints.md");
      expect(content).toContain("hints.md");
      expect(content).toContain("api.md");
    });
  });

  describe("parseHandoffDocument", () => {
    it("returns null when file does not exist", async () => {
      expect(await parseHandoffDocument(tempDir)).toBeNull();
    });

    it("returns null when file is still the template", async () => {
      await writeContextToRepo(tempDir, makeCtx());
      expect(await parseHandoffDocument(tempDir)).toBeNull();
    });

    it("returns content when agent filled it in", async () => {
      const { mkdir, writeFile } = await import("fs/promises");
      await mkdir(join(tempDir, "cfcf-docs"), { recursive: true });
      await writeFile(
        join(tempDir, "cfcf-docs", "iteration-handoff.md"),
        "# Iteration Handoff\n\n## Summary\nBuilt the calculator.\n",
        "utf-8",
      );
      const result = await parseHandoffDocument(tempDir);
      expect(result).toContain("Built the calculator");
    });
  });

  describe("parseSignalFile", () => {
    it("returns null when file does not exist", async () => {
      expect(await parseSignalFile(tempDir)).toBeNull();
    });

    it("returns null when file is the template (empty agent field)", async () => {
      await writeContextToRepo(tempDir, makeCtx());
      expect(await parseSignalFile(tempDir)).toBeNull();
    });

    it("parses a valid signal file", async () => {
      const { mkdir, writeFile } = await import("fs/promises");
      await mkdir(join(tempDir, "cfcf-docs"), { recursive: true });
      await writeFile(
        join(tempDir, "cfcf-docs", "cfcf-iteration-signals.json"),
        JSON.stringify({
          iteration: 1,
          agent: "claude-code",
          status: "completed",
          user_input_needed: false,
          tests_run: true,
          tests_passed: 5,
          tests_failed: 0,
          tests_total: 5,
          self_assessment: "high",
          blockers: [],
        }),
        "utf-8",
      );
      const result = await parseSignalFile(tempDir);
      expect(result).not.toBeNull();
      expect(result!.agent).toBe("claude-code");
      expect(result!.tests_passed).toBe(5);
    });

    it("returns null for malformed JSON", async () => {
      const { mkdir, writeFile } = await import("fs/promises");
      await mkdir(join(tempDir, "cfcf-docs"), { recursive: true });
      await writeFile(
        join(tempDir, "cfcf-docs", "cfcf-iteration-signals.json"),
        "not json",
        "utf-8",
      );
      expect(await parseSignalFile(tempDir)).toBeNull();
    });
  });

  describe("generateIterationSummary", () => {
    it("generates summary from signals", () => {
      const summary = generateIterationSummary(1, null, {
        iteration: 1,
        agent: "claude-code",
        status: "completed",
        user_input_needed: false,
        tests_run: true,
        tests_passed: 5,
        tests_failed: 1,
        tests_total: 6,
        self_assessment: "medium",
        blockers: [],
      }, 0);

      expect(summary).toContain("Iteration 1");
      expect(summary).toContain("completed");
      expect(summary).toContain("5/6 passed");
    });

    it("generates summary when signals are missing", () => {
      const summary = generateIterationSummary(2, null, null, 1);
      expect(summary).toContain("Iteration 2");
      expect(summary).toContain("Exit code: 1");
      expect(summary).toContain("not filled in");
    });

    it("extracts summary from handoff document", () => {
      const handoff = "# Handoff\n\n## Summary\nBuilt the auth module.\n\n## Changes Made\n...";
      const summary = generateIterationSummary(1, handoff, null, 0);
      expect(summary).toContain("Built the auth module");
    });
  });
});
