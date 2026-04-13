/**
 * Tests for the iteration loop controller and decision engine.
 */

import { describe, test, expect } from "bun:test";
import { makeDecision, type LoopState } from "./iteration-loop.js";
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

  test("null judge signals → pause with anomaly", () => {
    const decision = makeDecision(
      null,
      makeDevSignals(),
      makeLoopState(),
      makeProject(),
    );
    expect(decision.action).toBe("pause");
    expect(decision.pauseReason).toBe("anomaly");
    expect(decision.reason).toContain("missing or malformed");
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
