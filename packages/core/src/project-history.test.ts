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
} from "./project-history.js";
import type { ArchitectSignals } from "./types.js";

const TEST_CONFIG_DIR = join(tmpdir(), `cfcf-history-test-${process.pid}`);
const PROJECT_ID = "test-proj";

beforeEach(async () => {
  process.env.CFCF_CONFIG_DIR = TEST_CONFIG_DIR;
  await mkdir(join(TEST_CONFIG_DIR, "projects", PROJECT_ID), { recursive: true });
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
      join(TEST_CONFIG_DIR, "projects", PROJECT_ID, "history.json"),
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
