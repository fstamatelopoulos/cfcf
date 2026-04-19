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
  rebuildIterationHistoryFromLogs,
  mergeInstructionFile,
  writeInstructionFile,
  CFCF_INSTRUCTION_BEGIN,
  CFCF_INSTRUCTION_END,
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

    it("injects iteration-scope discipline on every iteration", () => {
      // Reaches live CLAUDE.md every run -- not just via process.md template
      // which is copied only on first iteration.
      const first = generateInstructionContent(makeCtx({ iteration: 1 }));
      const later = generateInstructionContent(makeCtx({ iteration: 4 }));
      for (const content of [first, later]) {
        expect(content).toContain("Iteration Scope");
        expect(content).toContain("one phase per iteration");
        expect(content).toContain("cfcf-docs/plan.md");
      }
      // First iteration tells the agent to map phases to iterations;
      // later iterations tell it to pick up the next pending chunk.
      expect(first).toContain("map phases to concrete iterations");
      expect(later).toContain("next pending iteration");
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

  describe("rebuildIterationHistoryFromLogs", () => {
    it("returns null when iteration-logs/ is missing", async () => {
      expect(await rebuildIterationHistoryFromLogs(tempDir)).toBeNull();
    });

    it("returns null when iteration-logs/ is empty", async () => {
      const { mkdir } = await import("fs/promises");
      await mkdir(join(tempDir, "cfcf-docs", "iteration-logs"), { recursive: true });
      expect(await rebuildIterationHistoryFromLogs(tempDir)).toBeNull();
    });

    it("concatenates summaries newest-first", async () => {
      const { mkdir, writeFile } = await import("fs/promises");
      const logsDir = join(tempDir, "cfcf-docs", "iteration-logs");
      await mkdir(logsDir, { recursive: true });
      await writeFile(
        join(logsDir, "iteration-1.md"),
        "# Iteration 1 -- Foundation\n\n## Summary\nScaffolded the project.\n\n## Changes\n- foo\n",
        "utf-8",
      );
      await writeFile(
        join(logsDir, "iteration-2.md"),
        "# Iteration 2 -- Core\n\n## Summary\nAdded core features.\n\n## Changes\n- bar\n",
        "utf-8",
      );
      const content = await rebuildIterationHistoryFromLogs(tempDir);
      expect(content).not.toBeNull();
      // Newest first
      const idxTwo = content!.indexOf("Iteration 2");
      const idxOne = content!.indexOf("Iteration 1");
      expect(idxTwo).toBeGreaterThanOrEqual(0);
      expect(idxOne).toBeGreaterThan(idxTwo);
      expect(content).toContain("Foundation");
      expect(content).toContain("Core");
      expect(content).toContain("Scaffolded the project.");
      expect(content).toContain("Added core features.");
      expect(content).toContain("[full log: cfcf-docs/iteration-logs/iteration-2.md]");
    });

    it("survives missing Summary section", async () => {
      const { mkdir, writeFile } = await import("fs/promises");
      const logsDir = join(tempDir, "cfcf-docs", "iteration-logs");
      await mkdir(logsDir, { recursive: true });
      await writeFile(
        join(logsDir, "iteration-3.md"),
        "# Iteration 3 -- Experiment\n\nNo summary heading here.\n",
        "utf-8",
      );
      const content = await rebuildIterationHistoryFromLogs(tempDir);
      expect(content).toContain("Iteration 3");
      expect(content).toContain("(no summary section)");
    });

    it("skips non-matching files in iteration-logs/", async () => {
      const { mkdir, writeFile } = await import("fs/promises");
      const logsDir = join(tempDir, "cfcf-docs", "iteration-logs");
      await mkdir(logsDir, { recursive: true });
      await writeFile(join(logsDir, "README.md"), "# Not an iteration log", "utf-8");
      await writeFile(join(logsDir, "iteration-1.md"), "# Iteration 1\n\n## Summary\nOk.\n", "utf-8");
      const content = await rebuildIterationHistoryFromLogs(tempDir);
      expect(content).toContain("Iteration 1");
      expect(content).not.toContain("Not an iteration log");
    });

    it("is used by writeContextToRepo when iteration-logs exist", async () => {
      const { mkdir, writeFile } = await import("fs/promises");
      const logsDir = join(tempDir, "cfcf-docs", "iteration-logs");
      await mkdir(logsDir, { recursive: true });
      await writeFile(
        join(logsDir, "iteration-1.md"),
        "# Iteration 1 -- Foo\n\n## Summary\nRebuild-source content.\n",
        "utf-8",
      );
      await writeContextToRepo(tempDir, makeCtx({
        iteration: 2,
        iterationHistory: "# Legacy history (should be ignored)\n",
      }));
      const written = await readFile(join(tempDir, "cfcf-docs", "iteration-history.md"), "utf-8");
      expect(written).toContain("Rebuild-source content.");
      expect(written).not.toContain("Legacy history");
    });

    it("falls back to ctx.iterationHistory when iteration-logs empty", async () => {
      await writeContextToRepo(tempDir, makeCtx({
        iteration: 2,
        iterationHistory: "# Fallback history\nUsed because no logs.\n",
      }));
      const written = await readFile(join(tempDir, "cfcf-docs", "iteration-history.md"), "utf-8");
      expect(written).toContain("Fallback history");
    });
  });

  describe("mergeInstructionFile (sentinel-based CLAUDE.md merge)", () => {
    const body = "# cfcf Iteration 1 Instructions\nblah blah\n";

    it("wraps the body when the file doesn't exist", () => {
      const out = mergeInstructionFile(null, body);
      expect(out).toContain(CFCF_INSTRUCTION_BEGIN);
      expect(out).toContain(CFCF_INSTRUCTION_END);
      expect(out).toContain("cfcf Iteration 1 Instructions");
      expect(out.split("\n")[0]).toBe(CFCF_INSTRUCTION_BEGIN);
    });

    it("prepends the cfcf block when file exists without markers", () => {
      const userContent = "# My notes\n\nTeam conventions go here.\n";
      const out = mergeInstructionFile(userContent, body);
      // cfcf block comes first, user content preserved verbatim after it
      expect(out.startsWith(CFCF_INSTRUCTION_BEGIN)).toBe(true);
      expect(out).toContain("Team conventions go here.");
      expect(out.indexOf(CFCF_INSTRUCTION_END)).toBeLessThan(out.indexOf("Team conventions"));
    });

    it("replaces only the cfcf block when markers exist; user content untouched", () => {
      const existing =
        `${CFCF_INSTRUCTION_BEGIN}\n# cfcf Iteration 1 Instructions\nstale content\n${CFCF_INSTRUCTION_END}\n\n# My notes\n\nTeam conventions go here.\n`;
      const newBody = "# cfcf Iteration 2 Instructions\nfresh content\n";
      const out = mergeInstructionFile(existing, newBody);
      expect(out).toContain("fresh content");
      expect(out).not.toContain("stale content");
      // User content is still there, byte-for-byte
      expect(out).toContain("# My notes\n\nTeam conventions go here.\n");
      // Only one pair of markers
      expect(out.match(new RegExp(CFCF_INSTRUCTION_BEGIN, "g"))!.length).toBe(1);
      expect(out.match(new RegExp(CFCF_INSTRUCTION_END, "g"))!.length).toBe(1);
    });

    it("preserves user content that was above the marker block", () => {
      const existing =
        `# My project\n\n${CFCF_INSTRUCTION_BEGIN}\nold cfcf\n${CFCF_INSTRUCTION_END}\nuser notes after\n`;
      const out = mergeInstructionFile(existing, "new cfcf");
      expect(out.startsWith("# My project\n\n")).toBe(true);
      expect(out).toContain("new cfcf");
      expect(out).toContain("user notes after");
      expect(out).not.toContain("old cfcf");
    });

    it("falls back to prepend when markers are missing after a user edit", () => {
      const existing = "# cfcf Iteration 1 Instructions (hand-stripped)\nuser removed markers\n";
      const out = mergeInstructionFile(existing, "fresh\n");
      expect(out.startsWith(CFCF_INSTRUCTION_BEGIN)).toBe(true);
      expect(out).toContain("user removed markers");
      expect(out).toContain("fresh");
    });

    it("is idempotent across iterations with no user changes", () => {
      const a = mergeInstructionFile(null, "iter 1 body\n");
      const b = mergeInstructionFile(a, "iter 2 body\n");
      const c = mergeInstructionFile(b, "iter 2 body\n");
      expect(b).toBe(c);
    });
  });

  describe("writeInstructionFile", () => {
    it("roundtrips through the filesystem and preserves user content", async () => {
      const { writeFile: wf, readFile: rf } = await import("fs/promises");
      const filename = "CLAUDE.md";
      const userContent = "# User project notes\n\nImportant stuff.\n";
      await wf(join(tempDir, filename), userContent, "utf-8");

      await writeInstructionFile(tempDir, filename, "first iteration body\n");
      const first = await rf(join(tempDir, filename), "utf-8");
      expect(first).toContain("first iteration body");
      expect(first).toContain("Important stuff");

      await writeInstructionFile(tempDir, filename, "second iteration body\n");
      const second = await rf(join(tempDir, filename), "utf-8");
      expect(second).toContain("second iteration body");
      expect(second).not.toContain("first iteration body");
      expect(second).toContain("Important stuff");
    });
  });

  describe("generateInstructionContent -- iteration-log artifact", () => {
    it("instructs the dev agent to write iteration-logs/iteration-N.md", () => {
      const content = generateInstructionContent(makeCtx({ iteration: 7 }));
      expect(content).toContain("cfcf-docs/iteration-logs/iteration-7.md");
    });

    it("mentions the tagged decision-log format", () => {
      const content = generateInstructionContent(makeCtx());
      expect(content).toMatch(/\[role: dev\]/);
      expect(content).toMatch(/\[category: decision\|lesson\]/);
    });
  });
});
