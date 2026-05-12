/**
 * Tests for the project-history module.
 *
 * Focuses on the ReviewHistoryEvent.signals field persistence (0.4.0),
 * plus basic append/update/cleanup semantics.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, rm, readFile, writeFile, utimes } from "fs/promises";
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
const TEST_LOGS_DIR = join(tmpdir(), `cfcf-history-test-logs-${process.pid}`);
const PROJECT_ID = "test-proj";

beforeEach(async () => {
  process.env.CFCF_CONFIG_DIR = TEST_CONFIG_DIR;
  process.env.CFCF_LOGS_DIR = TEST_LOGS_DIR;
  await mkdir(join(TEST_CONFIG_DIR, "workspaces", PROJECT_ID), { recursive: true });
  await mkdir(join(TEST_LOGS_DIR, PROJECT_ID), { recursive: true });
});

afterEach(async () => {
  await rm(TEST_CONFIG_DIR, { recursive: true, force: true });
  await rm(TEST_LOGS_DIR, { recursive: true, force: true });
  delete process.env.CFCF_CONFIG_DIR;
  delete process.env.CFCF_LOGS_DIR;
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

describe("updateHistoryEvent stale-error cleanup (item 6.35 follow-up)", () => {
  test("clears stale error when transitioning failed -> completed", async () => {
    // Simulate the bug: cleanupStaleRunningEvents wrongly marks an event
    // as failed, then the agent's own completion update arrives later.
    // Without the fix, the spread merge keeps the error string.
    await appendHistoryEvent(PROJECT_ID, {
      ...makeReviewEvent("rev-stale"),
      status: "failed",
      error: "Server restarted while this event was running",
      completedAt: new Date().toISOString(),
    });

    const updated = await updateHistoryEvent(PROJECT_ID, "rev-stale", {
      status: "completed",
      readiness: "READY",
    } as Partial<ReviewHistoryEvent>);

    expect(updated?.status).toBe("completed");
    expect(updated?.error).toBeUndefined();
  });

  test("preserves explicit error when patch sets one", async () => {
    // If a caller explicitly passes a new error value, honor it. Only the
    // implicit-stale case is cleaned up.
    await appendHistoryEvent(PROJECT_ID, {
      ...makeReviewEvent("rev-explicit"),
      status: "failed",
      error: "old error",
    });

    const updated = await updateHistoryEvent(PROJECT_ID, "rev-explicit", {
      status: "completed",
      error: "new explicit error",
    } as Partial<ReviewHistoryEvent>);

    expect(updated?.status).toBe("completed");
    expect(updated?.error).toBe("new explicit error");
  });

  test("leaves error untouched when status stays 'failed'", async () => {
    await appendHistoryEvent(PROJECT_ID, {
      ...makeReviewEvent("rev-stillfailed"),
      status: "failed",
      error: "original failure",
    });

    const updated = await updateHistoryEvent(PROJECT_ID, "rev-stillfailed", {
      readiness: "BLOCKED",
    } as Partial<ReviewHistoryEvent>);

    expect(updated?.status).toBe("failed");
    expect(updated?.error).toBe("original failure");
  });
});

describe("cleanupStaleRunningEvents liveness probe (item 6.35 follow-up)", () => {
  async function writeLog(name: string, content = "log line\n", mtimeMs?: number): Promise<void> {
    const path = join(TEST_LOGS_DIR, PROJECT_ID, name);
    await mkdir(join(TEST_LOGS_DIR, PROJECT_ID), { recursive: true });
    await writeFile(path, content, "utf-8");
    if (mtimeMs !== undefined) {
      const t = new Date(mtimeMs);
      await utimes(path, t, t);
    }
  }

  test("skips events whose log file was written in the last 90s", async () => {
    // Log written ~5s ago — agent is alive.
    await writeLog("architect-r-alive.log", "...", Date.now() - 5_000);
    await appendHistoryEvent(PROJECT_ID, {
      ...makeReviewEvent("r-alive"),
      logFile: "architect-r-alive.log",
    });

    const failed = await cleanupStaleRunningEvents(PROJECT_ID);
    expect(failed).toBe(0);

    const events = await readHistory(PROJECT_ID);
    expect(events[0].status).toBe("running");
    expect(events[0].error).toBeUndefined();
  });

  test("still cleans events whose log file is older than 90s", async () => {
    // Log written 5 minutes ago — agent is dead.
    await writeLog("architect-r-dead.log", "...", Date.now() - 5 * 60_000);
    await appendHistoryEvent(PROJECT_ID, {
      ...makeReviewEvent("r-dead"),
      logFile: "architect-r-dead.log",
    });

    const failed = await cleanupStaleRunningEvents(PROJECT_ID);
    expect(failed).toBe(1);

    const events = await readHistory(PROJECT_ID);
    expect(events[0].status).toBe("failed");
  });

  test("cleans events with no log file at all (defensive default)", async () => {
    // No log file — can't probe, fall back to old behaviour (mark failed).
    await appendHistoryEvent(PROJECT_ID, {
      ...makeReviewEvent("r-nolog"),
      logFile: "does-not-exist.log",
    });

    const failed = await cleanupStaleRunningEvents(PROJECT_ID);
    expect(failed).toBe(1);
  });

  test("iteration: alive if EITHER dev or judge log is recent", async () => {
    // Dev log is old, judge log is fresh — judge is still running.
    await writeLog("iter-100-dev.log", "...", Date.now() - 5 * 60_000);
    await writeLog("iter-100-judge.log", "...", Date.now() - 3_000);
    await appendHistoryEvent(PROJECT_ID, {
      id: "iter-100",
      type: "iteration",
      status: "running",
      startedAt: new Date().toISOString(),
      logFile: "iter-100-dev.log",
      agent: "codex",
      iteration: 100,
      branch: "cfcf/iteration-100",
      devLogFile: "iter-100-dev.log",
      judgeLogFile: "iter-100-judge.log",
      devAgent: "codex",
      judgeAgent: "codex",
    } as IterationHistoryEvent);

    const failed = await cleanupStaleRunningEvents(PROJECT_ID);
    expect(failed).toBe(0);

    const events = await readHistory(PROJECT_ID);
    expect(events[0].status).toBe("running");
  });
});

// ── F.21 (v0.24+): per-half timestamps on iteration events ─────────

describe("IterationHistoryEvent.devCompletedAt persistence (F.21)", () => {
  test("optional field round-trips through append + read", async () => {
    const iter: IterationHistoryEvent = {
      id: "iter-with-dev-completed",
      type: "iteration",
      status: "running",
      startedAt: "2026-05-12T10:00:00.000Z",
      logFile: "iteration-001-dev.log",
      agent: "codex",
      iteration: 1,
      branch: "cfcf/iteration-1",
      devLogFile: "iteration-001-dev.log",
      judgeLogFile: "iteration-001-judge.log",
      devAgent: "codex",
      judgeAgent: "claude-code",
      devCompletedAt: "2026-05-12T10:08:32.000Z",
    };
    await appendHistoryEvent(PROJECT_ID, iter);
    const events = await readHistory(PROJECT_ID);
    const e = events[0] as IterationHistoryEvent;
    expect(e.devCompletedAt).toBe("2026-05-12T10:08:32.000Z");
  });

  test("survives updateHistoryEvent patch flow (F.21 wiring in iteration-loop)", async () => {
    // Append a `running` iteration with no devCompletedAt (the loop
    // doesn't know dev's completion time at append-time).
    const iter: IterationHistoryEvent = {
      id: "iter-update-flow",
      type: "iteration",
      status: "running",
      startedAt: "2026-05-12T10:00:00.000Z",
      logFile: "iter-2-dev.log",
      agent: "codex",
      iteration: 2,
      branch: "cfcf/iteration-2",
      devLogFile: "iter-2-dev.log",
      judgeLogFile: "iter-2-judge.log",
      devAgent: "codex",
      judgeAgent: "codex",
    };
    await appendHistoryEvent(PROJECT_ID, iter);

    // Iteration loop completes both halves → patches the event with
    // both timestamps. Matches the call shape in iteration-loop.ts.
    await updateHistoryEvent(PROJECT_ID, "iter-update-flow", {
      status: "completed",
      completedAt: "2026-05-12T10:15:00.000Z",
      devCompletedAt: "2026-05-12T10:08:00.000Z",
      devExitCode: 0,
      judgeExitCode: 0,
      judgeDetermination: "PROGRESS",
      judgeQuality: 7,
    } as Partial<IterationHistoryEvent>);

    const events = await readHistory(PROJECT_ID);
    const e = events[0] as IterationHistoryEvent;
    expect(e.devCompletedAt).toBe("2026-05-12T10:08:00.000Z");
    expect(e.completedAt).toBe("2026-05-12T10:15:00.000Z");
    // Sanity: dev's window (start → devCompletedAt) is contained
    // within the iteration window (start → completedAt).
    expect(new Date(e.devCompletedAt!).getTime()).toBeLessThan(
      new Date(e.completedAt!).getTime(),
    );
  });

  test("backward compat: pre-F.21 events without devCompletedAt still parse", async () => {
    // A legacy event from a pre-F.21 server: no devCompletedAt field
    // at all. Should read back cleanly with the field undefined; the
    // UI handles the absence by rendering "—" for the dev row's
    // duration column.
    const legacy: IterationHistoryEvent = {
      id: "iter-legacy",
      type: "iteration",
      status: "completed",
      startedAt: "2026-04-01T10:00:00.000Z",
      completedAt: "2026-04-01T10:20:00.000Z",
      logFile: "iter-1-dev.log",
      agent: "codex",
      iteration: 1,
      branch: "cfcf/iteration-1",
      devLogFile: "iter-1-dev.log",
      judgeLogFile: "iter-1-judge.log",
      devAgent: "codex",
      judgeAgent: "codex",
      devExitCode: 0,
      judgeExitCode: 0,
      judgeDetermination: "PROGRESS",
      judgeQuality: 7,
      // no devCompletedAt
    };
    await appendHistoryEvent(PROJECT_ID, legacy);
    const events = await readHistory(PROJECT_ID);
    const e = events[0] as IterationHistoryEvent;
    expect(e.devCompletedAt).toBeUndefined();
    expect(e.completedAt).toBe("2026-04-01T10:20:00.000Z");
  });
});
