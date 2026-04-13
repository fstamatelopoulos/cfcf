/**
 * Tests for the iteration loop controller and decision engine.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir, readFile } from "fs/promises";
import { tmpdir } from "os";
import { makeDecision, getLoopState, startLoop, stopLoop, type LoopState } from "./iteration-loop.js";
import type { ProjectConfig, DevSignals, JudgeSignals } from "./types.js";

function makeProject(overrides?: Partial<ProjectConfig>): ProjectConfig {
  return {
    id: "test-proj-abc123",
    name: "test-project",
    repoPath: "/tmp/test-repo",
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

function makeLoopState(overrides?: Partial<LoopState>): LoopState {
  return {
    projectId: "test-proj-abc123",
    projectName: "test-project",
    phase: "deciding",
    currentIteration: 1,
    maxIterations: 10,
    pauseEvery: 0,
    startedAt: new Date().toISOString(),
    iterations: [],
    consecutiveStalled: 0,
    ...overrides,
  };
}

function makeDevSignals(overrides?: Partial<DevSignals>): DevSignals {
  return {
    iteration: 1,
    agent: "claude-code",
    status: "completed",
    user_input_needed: false,
    tests_run: true,
    tests_passed: 10,
    tests_failed: 0,
    tests_total: 10,
    self_assessment: "high",
    ...overrides,
  };
}

function makeJudgeSignals(overrides?: Partial<JudgeSignals>): JudgeSignals {
  return {
    iteration: 1,
    determination: "PROGRESS",
    quality_score: 7,
    tests_verified: true,
    tests_passed: 10,
    tests_failed: 0,
    tests_total: 10,
    should_continue: true,
    user_input_needed: false,
    ...overrides,
  };
}

describe("Decision Engine - makeDecision", () => {
  // --- Judge determination mapping ---

  test("SUCCESS → stop with success", () => {
    const decision = makeDecision(
      makeJudgeSignals({ determination: "SUCCESS" }),
      makeDevSignals(),
      makeLoopState(),
      makeProject(),
    );
    expect(decision.action).toBe("stop");
    expect(decision.reason).toContain("SUCCESS");
  });

  test("PROGRESS → continue", () => {
    const decision = makeDecision(
      makeJudgeSignals({ determination: "PROGRESS" }),
      makeDevSignals(),
      makeLoopState(),
      makeProject(),
    );
    expect(decision.action).toBe("continue");
  });

  test("ANOMALY → pause", () => {
    const decision = makeDecision(
      makeJudgeSignals({ determination: "ANOMALY", anomaly_type: "token_exhaustion" }),
      makeDevSignals(),
      makeLoopState(),
      makeProject(),
    );
    expect(decision.action).toBe("pause");
    expect(decision.pauseReason).toBe("anomaly");
    expect(decision.reason).toContain("token_exhaustion");
  });

  // --- STALLED + onStalled policy ---

  test("STALLED + onStalled=alert → pause", () => {
    const decision = makeDecision(
      makeJudgeSignals({ determination: "STALLED" }),
      makeDevSignals(),
      makeLoopState(),
      makeProject({ onStalled: "alert" }),
    );
    expect(decision.action).toBe("pause");
    expect(decision.pauseReason).toBe("anomaly");
  });

  test("STALLED + onStalled=stop → stop", () => {
    const decision = makeDecision(
      makeJudgeSignals({ determination: "STALLED" }),
      makeDevSignals(),
      makeLoopState(),
      makeProject({ onStalled: "stop" }),
    );
    expect(decision.action).toBe("stop");
  });

  test("STALLED + onStalled=continue → continue", () => {
    const decision = makeDecision(
      makeJudgeSignals({ determination: "STALLED" }),
      makeDevSignals(),
      makeLoopState(),
      makeProject({ onStalled: "continue" }),
    );
    expect(decision.action).toBe("continue");
  });

  // --- User input needed ---

  test("dev agent user_input_needed → pause", () => {
    const decision = makeDecision(
      makeJudgeSignals(),
      makeDevSignals({
        user_input_needed: true,
        questions: ["Should we use REST or GraphQL?"],
      }),
      makeLoopState(),
      makeProject(),
    );
    expect(decision.action).toBe("pause");
    expect(decision.pauseReason).toBe("user_input_needed");
    expect(decision.questions).toEqual(["Should we use REST or GraphQL?"]);
  });

  test("judge user_input_needed → pause", () => {
    const decision = makeDecision(
      makeJudgeSignals({ user_input_needed: true, key_concern: "API spec unclear" }),
      makeDevSignals(),
      makeLoopState(),
      makeProject(),
    );
    expect(decision.action).toBe("pause");
    expect(decision.pauseReason).toBe("user_input_needed");
  });

  // --- Max iterations ---

  test("max iterations reached → stop", () => {
    const decision = makeDecision(
      makeJudgeSignals({ determination: "PROGRESS" }),
      makeDevSignals(),
      makeLoopState({ currentIteration: 10, maxIterations: 10 }),
      makeProject(),
    );
    expect(decision.action).toBe("stop");
    expect(decision.reason).toContain("Max iterations");
  });

  // --- Pause cadence ---

  test("pause cadence reached → pause", () => {
    const decision = makeDecision(
      makeJudgeSignals({ determination: "PROGRESS" }),
      makeDevSignals(),
      makeLoopState({ currentIteration: 3, pauseEvery: 3 }),
      makeProject({ pauseEvery: 3 }),
    );
    expect(decision.action).toBe("pause");
    expect(decision.pauseReason).toBe("cadence");
  });

  test("pause cadence not reached → continue", () => {
    const decision = makeDecision(
      makeJudgeSignals({ determination: "PROGRESS" }),
      makeDevSignals(),
      makeLoopState({ currentIteration: 2, pauseEvery: 3 }),
      makeProject({ pauseEvery: 3 }),
    );
    expect(decision.action).toBe("continue");
  });

  // --- Missing signals ---

  test("null judge signals → pause with anomaly and helpful message", () => {
    const decision = makeDecision(
      null,
      makeDevSignals(),
      makeLoopState(),
      makeProject(),
    );
    expect(decision.action).toBe("pause");
    expect(decision.pauseReason).toBe("anomaly");
    expect(decision.reason).toContain("missing or malformed");
    expect(decision.reason).toContain("judge log");
    expect(decision.questions).toBeDefined();
    expect(decision.questions!.length).toBeGreaterThan(0);
  });

  // --- Priority: dev user_input_needed before judge determination ---

  test("dev user_input_needed takes priority over judge PROGRESS", () => {
    const decision = makeDecision(
      makeJudgeSignals({ determination: "PROGRESS" }),
      makeDevSignals({ user_input_needed: true, questions: ["Question?"] }),
      makeLoopState(),
      makeProject(),
    );
    expect(decision.action).toBe("pause");
    expect(decision.pauseReason).toBe("user_input_needed");
  });

  // --- Max iterations takes priority over everything ---

  test("max iterations takes priority over dev questions", () => {
    const decision = makeDecision(
      makeJudgeSignals(),
      makeDevSignals({ user_input_needed: true, questions: ["Question?"] }),
      makeLoopState({ currentIteration: 10, maxIterations: 10 }),
      makeProject(),
    );
    expect(decision.action).toBe("stop");
  });
});

describe("Loop State Persistence", () => {
  let tempDir: string;
  const originalEnv = process.env.CFCF_CONFIG_DIR;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cfcf-loop-persist-test-"));
    process.env.CFCF_CONFIG_DIR = tempDir;
  });

  afterEach(async () => {
    process.env.CFCF_CONFIG_DIR = originalEnv;
    await rm(tempDir, { recursive: true, force: true });
  });

  test("getLoopState returns undefined when no state exists", async () => {
    const state = await getLoopState("nonexistent-project");
    expect(state).toBeUndefined();
  });

  test("startLoop persists state to disk", async () => {
    // Create a minimal project config dir + git repo
    const repoDir = join(tempDir, "test-repo");
    await mkdir(repoDir, { recursive: true });
    await Bun.spawn(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;
    await Bun.spawn(["git", "config", "user.email", "test@cfcf.dev"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;
    await Bun.spawn(["git", "config", "user.name", "cfcf test"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;
    const { writeFile: wf } = await import("fs/promises");
    await wf(join(repoDir, "README.md"), "# test\n");
    await Bun.spawn(["git", "add", "-A"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;
    await Bun.spawn(["git", "commit", "-m", "initial"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;

    // Create a problem-pack
    const packDir = join(repoDir, "problem-pack");
    await mkdir(packDir, { recursive: true });
    await wf(join(packDir, "problem.md"), "# Problem\nBuild a thing\n");
    await wf(join(packDir, "success.md"), "# Success\nAll tests pass\n");

    // Create a project config on disk
    const { createProject } = await import("./projects.js");
    const project = await createProject({ name: "persist-test", repoPath: repoDir });

    // Start loop -- it will fail quickly (no agent installed) but state should persist
    const state = await startLoop(project);
    expect(state.projectId).toBe(project.id);

    // Wait a moment for the background task to write state
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Verify file exists on disk
    const statePath = join(tempDir, "projects", project.id, "loop-state.json");
    const raw = await readFile(statePath, "utf-8");
    const persisted = JSON.parse(raw);
    expect(persisted.projectId).toBe(project.id);
    expect(persisted.projectName).toBe("persist-test");
  });

  test("getLoopState loads from disk when not in memory", async () => {
    // Write a state file directly to disk
    const projectId = "fake-project-123";
    const projectDir = join(tempDir, "projects", projectId);
    await mkdir(projectDir, { recursive: true });

    const fakeState: LoopState = {
      projectId,
      projectName: "fake-project",
      phase: "paused",
      currentIteration: 3,
      maxIterations: 10,
      pauseEvery: 3,
      startedAt: "2026-04-12T00:00:00Z",
      iterations: [],
      consecutiveStalled: 0,
      pauseReason: "cadence",
      retryJudge: true,
    };
    const { writeFile: wf } = await import("fs/promises");
    await wf(join(projectDir, "loop-state.json"), JSON.stringify(fakeState), "utf-8");

    // getLoopState should find it on disk
    const loaded = await getLoopState(projectId);
    expect(loaded).not.toBeUndefined();
    expect(loaded!.phase).toBe("paused");
    expect(loaded!.currentIteration).toBe(3);
    expect(loaded!.pauseReason).toBe("cadence");
    expect(loaded!.retryJudge).toBe(true);
  });
});
