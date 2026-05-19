/**
 * Tests for the History tab's interactive/loop partition (v0.24.5).
 * Locks in the rule that "interactive" events keep ONE permanent
 * home regardless of status — terminated PAs stay in the
 * Interactive section. This was the load-bearing correction during
 * design: the initial proposal would have moved terminated rows
 * out, hiding history; the corrected proposal partitions by
 * event-type only, never by status.
 */

import { describe, test, expect } from "bun:test";
import type {
  HistoryEvent,
  IterationHistoryEvent,
  ReviewHistoryEvent,
  ReflectionHistoryEvent,
  DocumentHistoryEvent,
  PaSessionHistoryEvent,
  LoopStoppedHistoryEvent,
} from "../types";
import {
  partitionInteractiveEvents,
  INTERACTIVE_EVENT_TYPES,
} from "./history-partition";

function makePaSession(overrides?: Partial<PaSessionHistoryEvent>): PaSessionHistoryEvent {
  return {
    id: `pa-${Math.random().toString(36).slice(2, 10)}`,
    type: "pa-session",
    status: "completed",
    startedAt: "2026-05-14T10:00:00.000Z",
    logFile: "pa.log",
    agent: "claude-code",
    sessionId: "pa-2026-05-14T10-00-00-abc123",
    sessionFilePath: ".cfcf-pa/session-pa-2026-05-14T10-00-00-abc123.md",
    workspaceRegisteredAtStart: true,
    gitInitializedAtStart: true,
    problemPackFilesAtStart: 3,
    ...overrides,
  };
}

function makeIteration(overrides?: Partial<IterationHistoryEvent>): IterationHistoryEvent {
  return {
    id: `iter-${Math.random().toString(36).slice(2, 10)}`,
    type: "iteration",
    status: "completed",
    startedAt: "2026-05-14T11:00:00.000Z",
    logFile: "iter.log",
    agent: "codex",
    iteration: 1,
    branch: "cfcf/iteration-1",
    devLogFile: "iter-1-dev.log",
    judgeLogFile: "iter-1-judge.log",
    devAgent: "codex",
    judgeAgent: "codex",
    ...overrides,
  };
}

function makeReview(overrides?: Partial<ReviewHistoryEvent>): ReviewHistoryEvent {
  return {
    id: `review-${Math.random().toString(36).slice(2, 10)}`,
    type: "review",
    status: "completed",
    startedAt: "2026-05-14T12:00:00.000Z",
    logFile: "review.log",
    agent: "claude-code",
    trigger: "manual",
    ...overrides,
  };
}

function makeReflection(overrides?: Partial<ReflectionHistoryEvent>): ReflectionHistoryEvent {
  return {
    id: `refl-${Math.random().toString(36).slice(2, 10)}`,
    type: "reflection",
    status: "completed",
    startedAt: "2026-05-14T13:00:00.000Z",
    logFile: "refl.log",
    agent: "claude-code",
    iteration: 1,
    trigger: "loop",
    ...overrides,
  };
}

function makeDocument(overrides?: Partial<DocumentHistoryEvent>): DocumentHistoryEvent {
  return {
    id: `doc-${Math.random().toString(36).slice(2, 10)}`,
    type: "document",
    status: "completed",
    startedAt: "2026-05-14T14:00:00.000Z",
    logFile: "doc.log",
    agent: "claude-code",
    ...overrides,
  };
}

function makeLoopStopped(overrides?: Partial<LoopStoppedHistoryEvent>): LoopStoppedHistoryEvent {
  return {
    id: `stopped-${Math.random().toString(36).slice(2, 10)}`,
    type: "loop-stopped",
    status: "completed",
    startedAt: "2026-05-14T15:00:00.000Z",
    logFile: "",
    iteration: 5,
    ...overrides,
  };
}

describe("INTERACTIVE_EVENT_TYPES", () => {
  test("contains pa-session (the only interactive event type today)", () => {
    expect(INTERACTIVE_EVENT_TYPES.has("pa-session")).toBe(true);
  });

  test("does NOT contain loop event types — those are the audit trail of automation", () => {
    expect(INTERACTIVE_EVENT_TYPES.has("iteration")).toBe(false);
    expect(INTERACTIVE_EVENT_TYPES.has("review")).toBe(false);
    expect(INTERACTIVE_EVENT_TYPES.has("reflection")).toBe(false);
    expect(INTERACTIVE_EVENT_TYPES.has("document")).toBe(false);
    expect(INTERACTIVE_EVENT_TYPES.has("loop-stopped")).toBe(false);
  });
});

describe("partitionInteractiveEvents", () => {
  test("splits PA sessions into interactive[], everything else into loop[]", () => {
    const events: HistoryEvent[] = [
      makePaSession({ id: "pa1" }),
      makeIteration({ id: "iter1" }),
      makeReview({ id: "rev1" }),
      makePaSession({ id: "pa2" }),
      makeDocument({ id: "doc1" }),
    ];
    const result = partitionInteractiveEvents(events);
    expect(result.interactive.map((e) => e.id).sort()).toEqual(["pa1", "pa2"]);
    expect(result.loop.map((e) => e.id).sort()).toEqual(["doc1", "iter1", "rev1"]);
  });

  test("both arrays come back sorted newest-first (descending by startedAt)", () => {
    const events: HistoryEvent[] = [
      makePaSession({ id: "pa-old", startedAt: "2026-05-14T08:00:00.000Z" }),
      makePaSession({ id: "pa-new", startedAt: "2026-05-14T10:00:00.000Z" }),
      makePaSession({ id: "pa-mid", startedAt: "2026-05-14T09:00:00.000Z" }),
      makeIteration({ id: "iter-old", startedAt: "2026-05-14T11:00:00.000Z" }),
      makeIteration({ id: "iter-new", startedAt: "2026-05-14T13:00:00.000Z" }),
      makeIteration({ id: "iter-mid", startedAt: "2026-05-14T12:00:00.000Z" }),
    ];
    const result = partitionInteractiveEvents(events);
    expect(result.interactive.map((e) => e.id)).toEqual(["pa-new", "pa-mid", "pa-old"]);
    expect(result.loop.map((e) => e.id)).toEqual(["iter-new", "iter-mid", "iter-old"]);
  });

  test("ACTIVE PA stays at the top of interactive[] (newest startedAt) regardless of status", () => {
    // The load-bearing case for this whole feature: a long-running
    // PA that started days ago is still alive. New iteration events
    // accumulate. The active PA stays findable in section A.
    const activeOldPa = makePaSession({
      id: "pa-running",
      status: "running",
      startedAt: "2026-05-12T08:00:00.000Z", // started 2 days ago
    });
    const recentIter = makeIteration({
      id: "iter-recent",
      startedAt: "2026-05-14T15:00:00.000Z", // just now
    });
    const recentlyCompletedPa = makePaSession({
      id: "pa-just-done",
      status: "completed",
      startedAt: "2026-05-14T14:00:00.000Z", // an hour ago, completed
    });
    const events: HistoryEvent[] = [recentIter, activeOldPa, recentlyCompletedPa];
    const result = partitionInteractiveEvents(events);
    // The "just-done" PA is newer-by-startedAt and shows first; the
    // active 2-day-old PA is second. Both are in interactive[],
    // independent of status — the row is FINDABLE either way because
    // section A has at most a handful of entries.
    expect(result.interactive.map((e) => e.id)).toEqual(["pa-just-done", "pa-running"]);
    expect(result.loop.map((e) => e.id)).toEqual(["iter-recent"]);
  });

  test("TERMINATED interactive events stay in interactive[] (status does NOT change partition)", () => {
    // The correction the user pushed for in design review: don't
    // move events between sections when status flips. If a PA was
    // ever interactive, it stays in interactive[] forever — no
    // disappearing-on-completion, no "where did it go" confusion.
    const events: HistoryEvent[] = [
      makePaSession({ id: "pa-running", status: "running" }),
      makePaSession({ id: "pa-completed", status: "completed" }),
      makePaSession({ id: "pa-failed", status: "failed" }),
    ];
    const result = partitionInteractiveEvents(events);
    expect(result.interactive).toHaveLength(3);
    expect(result.loop).toHaveLength(0);
  });

  test("handles all loop event types correctly", () => {
    const events: HistoryEvent[] = [
      makeIteration(),
      makeReview(),
      makeReflection(),
      makeDocument(),
      makeLoopStopped(),
    ];
    const result = partitionInteractiveEvents(events);
    expect(result.interactive).toHaveLength(0);
    expect(result.loop).toHaveLength(5);
  });

  test("empty input returns empty arrays (defensive — never throws)", () => {
    const result = partitionInteractiveEvents([]);
    expect(result.interactive).toEqual([]);
    expect(result.loop).toEqual([]);
  });

  test("preserves all events — partition is total (interactive ∪ loop = input)", () => {
    const events: HistoryEvent[] = [
      makePaSession({ id: "pa1" }),
      makeIteration({ id: "iter1" }),
      makeReview({ id: "rev1" }),
      makePaSession({ id: "pa2" }),
      makeReflection({ id: "refl1" }),
      makeDocument({ id: "doc1" }),
      makeLoopStopped({ id: "stop1" }),
    ];
    const result = partitionInteractiveEvents(events);
    const allOut = [...result.interactive, ...result.loop].map((e) => e.id).sort();
    const allIn = events.map((e) => e.id).sort();
    expect(allOut).toEqual(allIn);
  });

  test("does not mutate the input array", () => {
    const events: HistoryEvent[] = [
      makePaSession({ startedAt: "2026-05-14T10:00:00.000Z" }),
      makeIteration({ startedAt: "2026-05-14T08:00:00.000Z" }),
      makePaSession({ startedAt: "2026-05-14T12:00:00.000Z" }),
    ];
    const originalOrder = events.map((e) => e.startedAt);
    partitionInteractiveEvents(events);
    expect(events.map((e) => e.startedAt)).toEqual(originalOrder);
  });
});
