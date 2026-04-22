import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "fs/promises";
import { tmpdir } from "os";
import {
  parseReflectionSignals,
  resetReflectionSignals,
  writeReflectionInstructions,
  validatePlanRewrite,
  resolveReflectionAgent,
} from "./reflection-runner.js";
import type { WorkspaceConfig } from "./types.js";

function makeProject(overrides?: Partial<WorkspaceConfig>): WorkspaceConfig {
  return {
    id: "test-proj-abc123",
    name: "test-project",
    repoPath: "/tmp/test-repo",
    devAgent: { adapter: "claude-code" },
    judgeAgent: { adapter: "codex" },
    architectAgent: { adapter: "claude-code" },
    documenterAgent: { adapter: "claude-code" },
    reflectionAgent: { adapter: "claude-code", model: "opus" },
    reflectSafeguardAfter: 3,
    maxIterations: 10,
    pauseEvery: 0,
    onStalled: "alert",
    mergeStrategy: "auto",
    processTemplate: "default",
    currentIteration: 3,
    ...overrides,
  };
}

describe("reflection-runner", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cfcf-refl-test-"));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("resolveReflectionAgent", () => {
    it("uses project.reflectionAgent when set", () => {
      const agent = resolveReflectionAgent(makeProject({ reflectionAgent: { adapter: "codex" } }));
      expect(agent.adapter).toBe("codex");
    });
    it("falls back to architectAgent", () => {
      const p = makeProject();
      delete p.reflectionAgent;
      const agent = resolveReflectionAgent(p);
      expect(agent.adapter).toBe("claude-code"); // architect
    });
    it("falls back to devAgent if no architect", () => {
      const p = makeProject();
      delete p.reflectionAgent;
      // @ts-expect-error -- testing missing arch
      delete p.architectAgent;
      const agent = resolveReflectionAgent(p);
      expect(agent.adapter).toBe("claude-code"); // dev
    });
  });

  describe("writeReflectionInstructions", () => {
    it("substitutes iteration + project name", async () => {
      await writeReflectionInstructions(tempDir, makeProject(), 5);
      const content = await readFile(
        join(tempDir, "cfcf-docs", "cfcf-reflection-instructions.md"),
        "utf-8",
      );
      expect(content).toContain("Iteration 5");
      expect(content).toContain("test-project");
      expect(content).not.toContain("{{ITERATION}}");
      expect(content).not.toContain("{{PROJECT_NAME}}");
    });
  });

  describe("parseReflectionSignals", () => {
    it("returns null when file is missing", async () => {
      await mkdir(join(tempDir, "cfcf-docs"), { recursive: true });
      expect(await parseReflectionSignals(tempDir)).toBeNull();
    });
    it("returns null for template default", async () => {
      await resetReflectionSignals(tempDir);
      expect(await parseReflectionSignals(tempDir)).toBeNull();
    });
    it("returns parsed signals when filled in", async () => {
      await mkdir(join(tempDir, "cfcf-docs"), { recursive: true });
      await writeFile(
        join(tempDir, "cfcf-docs", "cfcf-reflection-signals.json"),
        JSON.stringify({
          iteration: 3,
          plan_modified: true,
          iteration_health: "converging",
          key_observation: "Auth layer coming together",
          recommend_stop: false,
        }),
        "utf-8",
      );
      const s = await parseReflectionSignals(tempDir);
      expect(s).not.toBeNull();
      expect(s!.iteration).toBe(3);
      expect(s!.iteration_health).toBe("converging");
      expect(s!.plan_modified).toBe(true);
    });
    it("returns null for malformed JSON", async () => {
      await mkdir(join(tempDir, "cfcf-docs"), { recursive: true });
      await writeFile(
        join(tempDir, "cfcf-docs", "cfcf-reflection-signals.json"),
        "not json",
        "utf-8",
      );
      expect(await parseReflectionSignals(tempDir)).toBeNull();
    });
  });

  describe("validatePlanRewrite (non-destructive)", () => {
    const basePlan = `# Plan

## Iteration 1 -- Foundation
- [x] Scaffold repo -- dev notes here
- [x] Wire CI

## Iteration 2 -- Core
- [ ] Add auth module
- [ ] Add API handlers
`;
    it("accepts a rewrite that preserves all completed items + headers", () => {
      const newPlan = `# Plan (revised)

## Iteration 1 -- Foundation
- [x] Scaffold repo -- dev notes here
- [x] Wire CI

## Iteration 2 -- Core
- [ ] Add auth module
- [ ] Add API handlers
- [ ] Add rate limiter (new)
`;
      expect(validatePlanRewrite(basePlan, newPlan)).toEqual({ valid: true });
    });

    it("allows reordering pending items", () => {
      const newPlan = `# Plan

## Iteration 1 -- Foundation
- [x] Scaffold repo
- [x] Wire CI

## Iteration 2 -- Core (reshuffled)
- [ ] Add API handlers
- [ ] Add auth module
`;
      expect(validatePlanRewrite(basePlan, newPlan)).toEqual({ valid: true });
    });

    it("rejects when a completed item is removed", () => {
      const newPlan = `# Plan

## Iteration 1 -- Foundation
- [x] Scaffold repo

## Iteration 2 -- Core
- [ ] Add auth module
`;
      const res = validatePlanRewrite(basePlan, newPlan);
      expect(res.valid).toBe(false);
      if (!res.valid) expect(res.reason).toMatch(/completed item removed/);
    });

    it("rejects when an iteration header is dropped", () => {
      const newPlan = `# Plan

## Iteration 1 -- Foundation
- [x] Scaffold repo
- [x] Wire CI

## Other -- Not Iteration
- [ ] Stuff
`;
      const res = validatePlanRewrite(basePlan, newPlan);
      expect(res.valid).toBe(false);
      if (!res.valid) expect(res.reason).toMatch(/iteration header removed/);
    });

    it("rejects empty plan", () => {
      expect(validatePlanRewrite(basePlan, "").valid).toBe(false);
      expect(validatePlanRewrite(basePlan, "   ").valid).toBe(false);
    });

    it("allows retitling an iteration header (number is the identity)", () => {
      const newPlan = `# Plan

## Iteration 1 -- Renamed
- [x] Scaffold repo
- [x] Wire CI

## Iteration 2 -- Also renamed
- [ ] Add auth module
- [ ] Add API handlers
`;
      expect(validatePlanRewrite(basePlan, newPlan)).toEqual({ valid: true });
    });
  });
});
