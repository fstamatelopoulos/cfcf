/**
 * Tests for the iteration loop controller and decision engine.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir, readFile } from "fs/promises";
import { tmpdir } from "os";
import { makeDecision, getLoopState, startLoop, stopLoop, shouldRunReflection, type LoopState } from "./iteration-loop.js";
import type { WorkspaceConfig, DevSignals, JudgeSignals, ReflectionSignals } from "./types.js";

function makeProject(overrides?: Partial<WorkspaceConfig>): WorkspaceConfig {
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

function makeLoopState(overrides?: Partial<LoopState>): LoopState {
  return {
    workspaceId: "test-proj-abc123",
    workspaceName: "test-project",
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
    const { createWorkspace } = await import("./workspaces.js");
    const project = await createWorkspace({ name: "persist-test", repoPath: repoDir });

    // Start loop -- it will fail quickly (no agent installed) but state should persist
    const state = await startLoop(project);
    expect(state.workspaceId).toBe(project.id);

    // Wait a moment for the background task to write state
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Verify file exists on disk
    const statePath = join(tempDir, "workspaces", project.id, "loop-state.json");
    const raw = await readFile(statePath, "utf-8");
    const persisted = JSON.parse(raw);
    expect(persisted.workspaceId).toBe(project.id);
    expect(persisted.workspaceName).toBe("persist-test");
  });

  test("getLoopState loads from disk when not in memory", async () => {
    // Write a state file directly to disk
    const workspaceId = "fake-project-123";
    const projectDir = join(tempDir, "workspaces", workspaceId);
    await mkdir(projectDir, { recursive: true });

    const fakeState: LoopState = {
      workspaceId,
      workspaceName: "fake-project",
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
    const loaded = await getLoopState(workspaceId);
    expect(loaded).not.toBeUndefined();
    expect(loaded!.phase).toBe("paused");
    expect(loaded!.currentIteration).toBe(3);
    expect(loaded!.pauseReason).toBe("cadence");
    expect(loaded!.retryJudge).toBe(true);
  });
});

// --- Reflection trigger logic (item 5.6) ---

describe("shouldRunReflection (trigger logic)", () => {
  test("runs when judge.reflection_needed is true", () => {
    const res = shouldRunReflection(
      makeJudgeSignals({ reflection_needed: true, reflection_reason: "auth is stalling" }),
      makeLoopState(),
      makeProject({ reflectSafeguardAfter: 3 }),
    );
    expect(res.run).toBe(true);
    expect(res.reason).toContain("judge requested");
  });

  test("runs when reflection_needed is missing (default behavior)", () => {
    const res = shouldRunReflection(
      makeJudgeSignals(), // no reflection_needed
      makeLoopState(),
      makeProject(),
    );
    expect(res.run).toBe(true);
  });

  test("skips when judge opts out and safeguard ceiling not reached", () => {
    const res = shouldRunReflection(
      makeJudgeSignals({ reflection_needed: false }),
      makeLoopState({ iterationsSinceLastReflection: 0 }),
      makeProject({ reflectSafeguardAfter: 3 }),
    );
    expect(res.run).toBe(false);
    expect(res.reason).toContain("judge opted out");
  });

  test("skips once more when count=1 and ceiling=3", () => {
    const res = shouldRunReflection(
      makeJudgeSignals({ reflection_needed: false }),
      makeLoopState({ iterationsSinceLastReflection: 1 }),
      makeProject({ reflectSafeguardAfter: 3 }),
    );
    expect(res.run).toBe(false);
  });

  test("forces reflection when skip would cross the safeguard ceiling", () => {
    const res = shouldRunReflection(
      makeJudgeSignals({ reflection_needed: false }),
      makeLoopState({ iterationsSinceLastReflection: 2 }),
      makeProject({ reflectSafeguardAfter: 3 }),
    );
    expect(res.run).toBe(true);
    expect(res.reason).toContain("safeguard ceiling reached");
  });

  test("uses default safeguard=3 when project doesn't set one", () => {
    const p = makeProject();
    delete p.reflectSafeguardAfter;
    const res = shouldRunReflection(
      makeJudgeSignals({ reflection_needed: false }),
      makeLoopState({ iterationsSinceLastReflection: 2 }),
      p,
    );
    expect(res.run).toBe(true); // 2 + 1 >= 3 → force
  });

  test("skips when judge signals are missing (harness will pause separately)", () => {
    const res = shouldRunReflection(null, makeLoopState(), makeProject());
    expect(res.run).toBe(false);
  });
});

describe("makeDecision - reflection precedence (research Q6)", () => {
  function makeReflectionSignals(overrides?: Partial<ReflectionSignals>): ReflectionSignals {
    return {
      iteration: 1,
      plan_modified: false,
      iteration_health: "stalled",
      key_observation: "auth approach keeps failing test X",
      recommend_stop: true,
      ...overrides,
    };
  }

  test("reflection.recommend_stop pauses even when judge says PROGRESS", () => {
    const decision = makeDecision(
      makeJudgeSignals({ determination: "PROGRESS" }),
      makeDevSignals(),
      makeLoopState(),
      makeProject(),
      makeReflectionSignals({ recommend_stop: true }),
    );
    expect(decision.action).toBe("pause");
    expect(decision.pauseReason).toBe("anomaly");
    expect(decision.reason).toContain("Reflection flagged");
  });

  test("reflection.recommend_stop=false does not interfere with judge", () => {
    const decision = makeDecision(
      makeJudgeSignals({ determination: "PROGRESS" }),
      makeDevSignals(),
      makeLoopState(),
      makeProject(),
      makeReflectionSignals({ recommend_stop: false }),
    );
    expect(decision.action).toBe("continue");
  });

  test("max_iterations check still dominates reflection.recommend_stop", () => {
    const decision = makeDecision(
      makeJudgeSignals(),
      makeDevSignals(),
      makeLoopState({ currentIteration: 10, maxIterations: 10 }),
      makeProject({ maxIterations: 10 }),
      makeReflectionSignals({ recommend_stop: true }),
    );
    expect(decision.action).toBe("stop");
    expect(decision.pauseReason).toBe("max_iterations");
  });

  test("no reflectionSignals: legacy behavior preserved", () => {
    const decision = makeDecision(
      makeJudgeSignals({ determination: "PROGRESS" }),
      makeDevSignals(),
      makeLoopState(),
      makeProject(),
      undefined,
    );
    expect(decision.action).toBe("continue");
  });

  // 2026-05-01: judge=SUCCESS + recommend_stop=true is ambiguous between
  // "I agree, mission accomplished" and "I disagree with SUCCESS." We
  // disambiguate via iteration_health. See makeDecision doc-comment.

  test("judge=SUCCESS + recommend_stop=true + health=converging: silent SUCCESS stop (reflection agrees)", () => {
    // Real-world reproducer: tracker workspace, iter-5, 2026-05-01.
    // Reflection ran via reflectSafeguardAfter ceiling on the SUCCESS
    // iteration; agreed with judge; pre-fix this surfaced as a spurious
    // user-input popup.
    const decision = makeDecision(
      makeJudgeSignals({ determination: "SUCCESS" }),
      makeDevSignals(),
      makeLoopState(),
      makeProject(),
      makeReflectionSignals({
        recommend_stop: true,
        iteration_health: "converging",
        key_observation: "loop has nothing left to do",
      }),
    );
    expect(decision.action).toBe("stop");
    expect(decision.reason).toContain("SUCCESS");
    expect(decision.pauseReason).not.toBe("anomaly");
  });

  test("judge=SUCCESS + recommend_stop=true + health=stable: silent SUCCESS stop (reflection agrees)", () => {
    const decision = makeDecision(
      makeJudgeSignals({ determination: "SUCCESS" }),
      makeDevSignals(),
      makeLoopState(),
      makeProject(),
      makeReflectionSignals({
        recommend_stop: true,
        iteration_health: "stable",
      }),
    );
    expect(decision.action).toBe("stop");
    expect(decision.reason).toContain("SUCCESS");
  });

  test("judge=SUCCESS + recommend_stop=true + health=stalled: pause for user (reflection disagrees)", () => {
    // Defense-in-depth: judge says SUCCESS but the cross-iteration view
    // sees the loop stuck somewhere. User must arbitrate.
    const decision = makeDecision(
      makeJudgeSignals({ determination: "SUCCESS" }),
      makeDevSignals(),
      makeLoopState(),
      makeProject(),
      makeReflectionSignals({
        recommend_stop: true,
        iteration_health: "stalled",
        key_observation: "judge said SUCCESS but the auth approach is still broken in iter-3 carryover",
      }),
    );
    expect(decision.action).toBe("pause");
    expect(decision.pauseReason).toBe("anomaly");
    expect(decision.reason).toContain("Reflection flagged");
  });

  test("judge=SUCCESS + recommend_stop=true + health=diverging: pause for user (reflection disagrees)", () => {
    const decision = makeDecision(
      makeJudgeSignals({ determination: "SUCCESS" }),
      makeDevSignals(),
      makeLoopState(),
      makeProject(),
      makeReflectionSignals({
        recommend_stop: true,
        iteration_health: "diverging",
      }),
    );
    expect(decision.action).toBe("pause");
    expect(decision.pauseReason).toBe("anomaly");
  });

  test("judge=SUCCESS + recommend_stop=true + health=inconclusive: pause for user (reflection disagrees)", () => {
    const decision = makeDecision(
      makeJudgeSignals({ determination: "SUCCESS" }),
      makeDevSignals(),
      makeLoopState(),
      makeProject(),
      makeReflectionSignals({
        recommend_stop: true,
        iteration_health: "inconclusive",
      }),
    );
    expect(decision.action).toBe("pause");
    expect(decision.pauseReason).toBe("anomaly");
  });
});

// =================================================================
// Item 6.25: structured pause actions
// =================================================================

import { pauseReasonAllowedActions } from "./iteration-loop.js";
import type { ResumeAction } from "./types.js";

describe("pauseReasonAllowedActions (item 6.25)", () => {
  function expectActions(actual: ResumeAction[], expected: ResumeAction[]): void {
    expect([...actual].sort()).toEqual([...expected].sort());
  }

  test("pre-loop block (undefined pauseReason): continue + stop_loop_now + refine_plan", () => {
    expectActions(pauseReasonAllowedActions(undefined), [
      "continue",
      "stop_loop_now",
      "refine_plan",
    ]);
  });

  test("user_input_needed without dev signals: full set (treated as A3 superset)", () => {
    expectActions(pauseReasonAllowedActions("user_input_needed"), [
      "continue",
      "finish_loop",
      "stop_loop_now",
      "refine_plan",
      "consult_reflection",
    ]);
  });

  test("user_input_needed + dev mid-iter (A2): only continue + stop_loop_now", () => {
    expectActions(
      pauseReasonAllowedActions("user_input_needed", {
        dev: makeDevSignals({ user_input_needed: true, questions: ["q?"] }),
      }),
      ["continue", "stop_loop_now"],
    );
  });

  test("user_input_needed + judge needs input (A3, no dev flag): full set", () => {
    expectActions(
      pauseReasonAllowedActions("user_input_needed", {
        dev: makeDevSignals({ user_input_needed: false }),
        judge: makeJudgeSignals({ user_input_needed: true }),
      }),
      ["continue", "finish_loop", "stop_loop_now", "refine_plan", "consult_reflection"],
    );
  });

  test("anomaly without signals: full permissive set (A4/A5/A6/A9 superset)", () => {
    expectActions(pauseReasonAllowedActions("anomaly"), [
      "continue",
      "finish_loop",
      "stop_loop_now",
      "refine_plan",
      "consult_reflection",
    ]);
  });

  test("anomaly + judge=null (A8 — broken state): only stop_loop_now + refine_plan", () => {
    expectActions(
      pauseReasonAllowedActions("anomaly", { judge: null }),
      ["stop_loop_now", "refine_plan"],
    );
  });

  test("cadence (A7): full set", () => {
    expectActions(pauseReasonAllowedActions("cadence"), [
      "continue",
      "finish_loop",
      "stop_loop_now",
      "refine_plan",
      "consult_reflection",
    ]);
  });

  test("max_iterations (B1): only finish_loop + stop_loop_now", () => {
    expectActions(pauseReasonAllowedActions("max_iterations"), [
      "finish_loop",
      "stop_loop_now",
    ]);
  });

  test("default (continue) is in pre-loop A1, anomaly, cadence, user_input_needed superset", () => {
    expect(pauseReasonAllowedActions(undefined)).toContain("continue");
    expect(pauseReasonAllowedActions("anomaly")).toContain("continue");
    expect(pauseReasonAllowedActions("cadence")).toContain("continue");
    expect(pauseReasonAllowedActions("user_input_needed")).toContain("continue");
  });

  test("max_iterations excludes continue + refine_plan + consult_reflection", () => {
    const allowed = pauseReasonAllowedActions("max_iterations");
    expect(allowed).not.toContain("continue");
    expect(allowed).not.toContain("refine_plan");
    expect(allowed).not.toContain("consult_reflection");
  });
});
