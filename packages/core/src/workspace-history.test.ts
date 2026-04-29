/**
 * Tests for the project-history module.
 *
 * Focuses on the ReviewHistoryEvent.signals field persistence (0.4.0),
 * plus basic append/update/cleanup semantics.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import {
  appendHistoryEvent,
  readHistory,
  updateHistoryEvent,
  cleanupStaleRunningEvents,
  type ReviewHistoryEvent,
  type IterationHistoryEvent,
  type PaSessionHistoryEvent,
} from "./workspace-history.js";
import type { ArchitectSignals } from "./types.js";

const TEST_CONFIG_DIR = join(tmpdir(), `cfcf-history-test-${process.pid}`);
const PROJECT_ID = "test-proj";

beforeEach(async () => {
  process.env.CFCF_CONFIG_DIR = TEST_CONFIG_DIR;
  await mkdir(join(TEST_CONFIG_DIR, "workspaces", PROJECT_ID), { recursive: true });
});

afterEach(async () => {
  await rm(TEST_CONFIG_DIR, { recursive: true, force: true });
  delete process.env.CFCF_CONFIG_DIR;
});

function makeReviewEvent(id: string): ReviewHistoryEvent {
  return {
    id,
    type: "review",
    status: "running",
    startedAt: new Date().toISOString(),
    logFile: `architect-${id}.log`,
    agent: "codex",
  };
}

describe("project-history basics", () => {
  test("readHistory returns empty array for unknown project", async () => {
    const events = await readHistory("nonexistent-proj");
    expect(events).toEqual([]);
  });

  test("appendHistoryEvent persists events across reads", async () => {
    await appendHistoryEvent(PROJECT_ID, makeReviewEvent("r1"));
    await appendHistoryEvent(PROJECT_ID, makeReviewEvent("r2"));
    const events = await readHistory(PROJECT_ID);
    expect(events).toHaveLength(2);
    expect(events[0].id).toBe("r1");
    expect(events[1].id).toBe("r2");
  });

  test("updateHistoryEvent returns null for unknown id", async () => {
    await appendHistoryEvent(PROJECT_ID, makeReviewEvent("r1"));
    const result = await updateHistoryEvent(PROJECT_ID, "does-not-exist", {
      status: "completed",
    });
    expect(result).toBeNull();
  });

  test("cleanupStaleRunningEvents marks running events as failed", async () => {
    await appendHistoryEvent(PROJECT_ID, makeReviewEvent("r1"));
    await appendHistoryEvent(PROJECT_ID, {
      ...makeReviewEvent("r2"),
      status: "completed",
    });
    const changed = await cleanupStaleRunningEvents(PROJECT_ID, "crash");
    expect(changed).toBe(1);
    const events = await readHistory(PROJECT_ID);
    const r1 = events.find((e) => e.id === "r1")!;
    expect(r1.status).toBe("failed");
    expect(r1.error).toBe("crash");
  });
});

describe("ReviewHistoryEvent.signals persistence", () => {
  test("updateHistoryEvent persists full ArchitectSignals object", async () => {
    await appendHistoryEvent(PROJECT_ID, makeReviewEvent("rev1"));

    const signals: ArchitectSignals = {
      readiness: "NEEDS_REFINEMENT",
      gaps: ["success.md has no measurable criteria", "No test scenarios"],
      suggestions: ["Add acceptance test list", "Define SLA targets"],
      risks: ["External API instability"],
      recommended_approach: "Start with the happy path, then cover edge cases.",
    };

    await updateHistoryEvent(PROJECT_ID, "rev1", {
      status: "completed",
      readiness: signals.readiness,
      signals,
    } as Partial<ReviewHistoryEvent>);

    const events = await readHistory(PROJECT_ID);
    const rev = events[0] as ReviewHistoryEvent;
    expect(rev.readiness).toBe("NEEDS_REFINEMENT");
    expect(rev.signals).toBeDefined();
    expect(rev.signals!.gaps).toHaveLength(2);
    expect(rev.signals!.suggestions).toHaveLength(2);
    expect(rev.signals!.risks).toHaveLength(1);
    expect(rev.signals!.recommended_approach).toContain("happy path");
  });

  test("signals survive round-trip serialization to disk", async () => {
    await appendHistoryEvent(PROJECT_ID, makeReviewEvent("rev1"));
    const signals: ArchitectSignals = {
      readiness: "READY",
      gaps: [],
      suggestions: [],
      risks: [],
    };
    await updateHistoryEvent(PROJECT_ID, "rev1", {
      status: "completed",
      signals,
    } as Partial<ReviewHistoryEvent>);

    // Read raw JSON from disk to confirm it's persisted (not just in memory).
    const raw = await readFile(
      join(TEST_CONFIG_DIR, "workspaces", PROJECT_ID, "history.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as ReviewHistoryEvent[];
    expect(parsed[0].signals).toEqual(signals);
  });

  test("old events without signals still read correctly (backward compat)", async () => {
    // Simulate a history.json written before 0.4.0 (no signals field).
    const legacyEvent: ReviewHistoryEvent = {
      id: "legacy",
      type: "review",
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      logFile: "architect-001.log",
      agent: "codex",
      readiness: "NEEDS_REFINEMENT",
      // no `signals` field
    };
    await appendHistoryEvent(PROJECT_ID, legacyEvent);
    const events = await readHistory(PROJECT_ID);
    const rev = events[0] as ReviewHistoryEvent;
    expect(rev.readiness).toBe("NEEDS_REFINEMENT");
    expect(rev.signals).toBeUndefined();
  });

  test("updating an iteration event does not accidentally add signals", async () => {
    const iter: IterationHistoryEvent = {
      id: "iter1",
      type: "iteration",
      status: "running",
      startedAt: new Date().toISOString(),
      logFile: "iteration-001-dev.log",
      agent: "codex",
      iteration: 1,
      branch: "cfcf/iteration-1",
      devLogFile: "iteration-001-dev.log",
      judgeLogFile: "iteration-001-judge.log",
      devAgent: "codex",
      judgeAgent: "codex",
    };
    await appendHistoryEvent(PROJECT_ID, iter);
    await updateHistoryEvent(PROJECT_ID, "iter1", {
      status: "completed",
      judgeDetermination: "PROGRESS",
      judgeQuality: 7,
    } as Partial<IterationHistoryEvent>);

    const events = await readHistory(PROJECT_ID);
    const e = events[0] as IterationHistoryEvent;
    expect(e.judgeDetermination).toBe("PROGRESS");
    expect((e as unknown as { signals?: unknown }).signals).toBeUndefined();
  });
});

describe("project-history PA-session events (5.14 v2)", () => {
  function makePaSessionEvent(
    overrides: Partial<PaSessionHistoryEvent> = {},
  ): PaSessionHistoryEvent {
    return {
      id: "pa-session-1",
      type: "pa-session",
      status: "running",
      startedAt: "2026-04-29T10:00:00Z",
      logFile: ".cfcf-pa/session-pa-2026-04-29-abc.md",
      agent: "claude-code",
      sessionId: "pa-2026-04-29-abc",
      sessionFilePath: ".cfcf-pa/session-pa-2026-04-29-abc.md",
      workspaceRegisteredAtStart: true,
      gitInitializedAtStart: true,
      problemPackFilesAtStart: 0,
      ...overrides,
    };
  }

  test("appendHistoryEvent + readHistory roundtrip a PA-session event", async () => {
    await appendHistoryEvent(PROJECT_ID, makePaSessionEvent());
    const events = await readHistory(PROJECT_ID);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("pa-session");
    const pa = events[0] as PaSessionHistoryEvent;
    expect(pa.sessionId).toBe("pa-2026-04-29-abc");
    expect(pa.workspaceRegisteredAtStart).toBe(true);
    expect(pa.problemPackFilesAtStart).toBe(0);
  });

  test("updateHistoryEvent enriches a running PA-session with completion data", async () => {
    await appendHistoryEvent(PROJECT_ID, makePaSessionEvent());
    await updateHistoryEvent(PROJECT_ID, "pa-session-1", {
      status: "completed",
      completedAt: "2026-04-29T10:25:00Z",
      exitCode: 0,
      outcomeSummary: "Drafted problem.md and success.md.",
      decisionsCount: 3,
      clioWorkspaceMemoryDocId: "doc-uuid-1",
    } as Partial<PaSessionHistoryEvent>);

    const events = await readHistory(PROJECT_ID);
    const pa = events[0] as PaSessionHistoryEvent;
    expect(pa.status).toBe("completed");
    expect(pa.outcomeSummary).toContain("Drafted");
    expect(pa.decisionsCount).toBe(3);
    expect(pa.clioWorkspaceMemoryDocId).toBe("doc-uuid-1");
    expect(pa.exitCode).toBe(0);
  });

  test("cleanupStaleRunningEvents does NOT touch running PA sessions (decoupled from server lifecycle)", async () => {
    // PA's agent + launcher run in the user's terminal, not as
    // server children. Server restart is irrelevant to their status.
    // Cleanup must skip them, otherwise an actually-still-running
    // session shows up in the History tab as "failed" until the user
    // closes their PA shell (which is wrong + confusing).
    await appendHistoryEvent(PROJECT_ID, makePaSessionEvent());
    const failed = await cleanupStaleRunningEvents(PROJECT_ID);
    expect(failed).toBe(0);
    const events = await readHistory(PROJECT_ID);
    expect(events[0].status).toBe("running");
    expect((events[0] as PaSessionHistoryEvent).error).toBeUndefined();
  });

  test("cleanupStaleRunningEvents still cleans up other event types (iteration/review/document/reflection)", async () => {
    // Mixed: a running iteration + a running PA session. Iteration
    // gets cleaned up; PA session is left alone.
    await appendHistoryEvent(PROJECT_ID, {
      id: "iter-99",
      type: "iteration",
      status: "running",
      startedAt: new Date().toISOString(),
      logFile: "iteration-099-dev.log",
      agent: "codex",
      iteration: 99,
      branch: "cfcf/iteration-99",
      devLogFile: "iteration-099-dev.log",
      judgeLogFile: "iteration-099-judge.log",
      devAgent: "codex",
      judgeAgent: "codex",
    } as IterationHistoryEvent);
    await appendHistoryEvent(PROJECT_ID, makePaSessionEvent({ id: "pa-99" }));

    const failed = await cleanupStaleRunningEvents(PROJECT_ID);
    expect(failed).toBe(1); // only the iteration

    const events = await readHistory(PROJECT_ID);
    const iter = events.find((e) => e.id === "iter-99");
    const pa = events.find((e) => e.id === "pa-99");
    expect(iter?.status).toBe("failed");
    expect(pa?.status).toBe("running");
  });
});
