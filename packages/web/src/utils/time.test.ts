/**
 * Tests for the shared duration formatters (used by both the live timer
 * in PhaseIndicator and the static Duration column in ProjectHistory).
 */

import { describe, test, expect } from "bun:test";
import { formatDuration, formatDurationOrRunning } from "./time";

describe("formatDuration", () => {
  const base = "2026-04-18T10:00:00.000Z";

  test("returns '-' when startedAt is missing", () => {
    expect(formatDuration(undefined)).toBe("-");
  });

  test("returns '-' when startedAt is invalid", () => {
    expect(formatDuration("not-a-date")).toBe("-");
  });

  test("formats sub-minute durations as seconds", () => {
    const end = new Date(new Date(base).getTime() + 12_000).toISOString();
    expect(formatDuration(base, end)).toBe("12s");
  });

  test("formats sub-hour durations as m + zero-padded seconds", () => {
    const end = new Date(new Date(base).getTime() + (2 * 60 + 4) * 1000).toISOString();
    expect(formatDuration(base, end)).toBe("2m 04s");
  });

  test("formats hour+ durations as h + zero-padded minutes", () => {
    const end = new Date(new Date(base).getTime() + (1 * 3600 + 3 * 60) * 1000).toISOString();
    expect(formatDuration(base, end)).toBe("1h 03m");
  });

  test("clamps negative durations to 0", () => {
    const end = new Date(new Date(base).getTime() - 5_000).toISOString();
    expect(formatDuration(base, end)).toBe("0s");
  });

  test("uses Date.now() when completedAt is omitted", () => {
    // Started 3 seconds ago.
    const recent = new Date(Date.now() - 3_000).toISOString();
    const out = formatDuration(recent);
    // Allow a 1s tolerance for timing jitter.
    expect(["2s", "3s", "4s"]).toContain(out);
  });
});

describe("formatDurationOrRunning", () => {
  test("returns 'running' when completedAt is missing", () => {
    expect(formatDurationOrRunning("2026-04-18T10:00:00.000Z")).toBe("running");
  });

  test("returns formatted duration when completedAt is set", () => {
    const start = "2026-04-18T10:00:00.000Z";
    const end = new Date(new Date(start).getTime() + 45_000).toISOString();
    expect(formatDurationOrRunning(start, end)).toBe("45s");
  });
});
