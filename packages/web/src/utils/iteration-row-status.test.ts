/**
 * Tests for the F.21 per-half status derivation. Locks in the
 * matrix the user pushed back on during initial review: judge row
 * must show "pending" — NOT "running" — while dev is the live
 * phase. Matches the PhaseIndicator's "one phase highlighted at a
 * time" semantic.
 */

import { describe, test, expect } from "bun:test";
import type { IterationHistoryEvent } from "../types";
import {
  deriveDevRowStatus,
  deriveJudgeRowStatus,
  deriveIterationRowStatuses,
} from "./iteration-row-status";

function makeEvent(partial: Partial<IterationHistoryEvent>): IterationHistoryEvent {
  return {
    id: "iter-test",
    type: "iteration",
    status: "running",
    startedAt: "2026-05-12T10:00:00.000Z",
    logFile: "iter-1-dev.log",
    agent: "codex",
    iteration: 1,
    branch: "cfcf/iteration-1",
    devLogFile: "iter-1-dev.log",
    judgeLogFile: "iter-1-judge.log",
    devAgent: "codex",
    judgeAgent: "codex",
    ...partial,
  };
}

describe("deriveDevRowStatus", () => {
  test("dev executing → running", () => {
    expect(deriveDevRowStatus(makeEvent({ status: "running" }))).toBe("running");
  });

  test("dev finished, exit 0 → completed", () => {
    expect(
      deriveDevRowStatus(makeEvent({ status: "running", devExitCode: 0 })),
    ).toBe("completed");
  });

  test("dev finished, non-zero exit → failed", () => {
    expect(
      deriveDevRowStatus(makeEvent({ status: "running", devExitCode: 1 })),
    ).toBe("failed");
  });

  test("iteration completed, devExitCode set → completed", () => {
    expect(
      deriveDevRowStatus(makeEvent({ status: "completed", devExitCode: 0 })),
    ).toBe("completed");
  });

  test("iteration ended without a captured devExitCode → falls back to event terminal status (completed)", () => {
    // Rare path: loop crashed before parsing dev's exit. We
    // surface the event's terminal status so the row isn't
    // stuck saying "running".
    expect(
      deriveDevRowStatus(makeEvent({ status: "completed", devExitCode: undefined })),
    ).toBe("completed");
  });

  test("iteration ended without a captured devExitCode → falls back to failed", () => {
    expect(
      deriveDevRowStatus(makeEvent({ status: "failed", devExitCode: undefined })),
    ).toBe("failed");
  });
});

describe("deriveJudgeRowStatus", () => {
  test("dev still running → judge pending (NOT running — matches PhaseIndicator)", () => {
    // The bug the user caught during F.21 review: judge row was
    // mirroring the event's running status while dev was still
    // executing. Should be "pending" instead.
    expect(
      deriveJudgeRowStatus(makeEvent({ status: "running" })),
    ).toBe("pending");
  });

  test("dev done (exit 0), judge not yet started → judge running", () => {
    expect(
      deriveJudgeRowStatus(
        makeEvent({ status: "running", devExitCode: 0 }),
      ),
    ).toBe("running");
  });

  test("dev failed → judge skipped (loop bails before spawning judge)", () => {
    expect(
      deriveJudgeRowStatus(
        makeEvent({ status: "failed", devExitCode: 1 }),
      ),
    ).toBe("skipped");
  });

  test("both done, both exit 0 → judge completed", () => {
    expect(
      deriveJudgeRowStatus(
        makeEvent({
          status: "completed",
          devExitCode: 0,
          judgeExitCode: 0,
        }),
      ),
    ).toBe("completed");
  });

  test("dev exit 0, judge non-zero → judge failed", () => {
    expect(
      deriveJudgeRowStatus(
        makeEvent({
          status: "failed",
          devExitCode: 0,
          judgeExitCode: 1,
        }),
      ),
    ).toBe("failed");
  });
});

describe("deriveIterationRowStatuses (combined)", () => {
  test("five canonical lifecycle states", () => {
    // 1. Dev executing — dev:running, judge:pending
    expect(
      deriveIterationRowStatuses(makeEvent({ status: "running" })),
    ).toEqual({ dev: "running", judge: "pending" });

    // 2. Dev done, judge executing — dev:completed, judge:running
    expect(
      deriveIterationRowStatuses(
        makeEvent({ status: "running", devExitCode: 0 }),
      ),
    ).toEqual({ dev: "completed", judge: "running" });

    // 3. Both done, success — dev:completed, judge:completed
    expect(
      deriveIterationRowStatuses(
        makeEvent({
          status: "completed",
          devExitCode: 0,
          judgeExitCode: 0,
        }),
      ),
    ).toEqual({ dev: "completed", judge: "completed" });

    // 4. Dev failed, judge skipped
    expect(
      deriveIterationRowStatuses(
        makeEvent({ status: "failed", devExitCode: 1 }),
      ),
    ).toEqual({ dev: "failed", judge: "skipped" });

    // 5. Dev done, judge failed
    expect(
      deriveIterationRowStatuses(
        makeEvent({
          status: "failed",
          devExitCode: 0,
          judgeExitCode: 1,
        }),
      ),
    ).toEqual({ dev: "completed", judge: "failed" });
  });
});
