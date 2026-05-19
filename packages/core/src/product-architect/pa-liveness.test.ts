/**
 * Tests for the on-demand PA-session liveness check (v0.24.5).
 *
 * The "PID is alive" path is hard to exercise deterministically
 * without spawning + killing real subprocesses. These tests pin
 * the observable contract: history wiring, status filter, ordering
 * (newest live wins), and the safe defaults around missing /
 * malformed inputs. The PID primitive (`isPidAlive`) is also
 * tested directly with `process.pid` (this process is definitely
 * alive) + a known-dead PID.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  getPaSessionLiveness,
  getPaSessionsForWorkspaces,
  isPidAlive,
} from "./pa-liveness.js";
import type { PaSessionHistoryEvent } from "../workspace-history.js";

let tempDir: string;
const originalConfigDir = process.env.CFCF_CONFIG_DIR;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "cfcf-pa-liveness-test-"));
  process.env.CFCF_CONFIG_DIR = tempDir;
});

afterEach(async () => {
  process.env.CFCF_CONFIG_DIR = originalConfigDir;
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/**
 * Write a fake history.json for the given workspace. The format
 * matches what readHistory() expects: a JSON array of events.
 */
async function writeHistory(workspaceId: string, events: Array<Partial<PaSessionHistoryEvent> & { type: string }>): Promise<void> {
  const dir = join(tempDir, "workspaces", workspaceId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "history.json"), JSON.stringify(events, null, 2), "utf-8");
}

describe("isPidAlive", () => {
  it("returns true for the current process PID (definitely alive)", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("returns false for a PID that's almost certainly dead", () => {
    // PID 1 is init / launchd — alive but likely owned by root,
    // which would return EPERM (alive). Use a high PID unlikely
    // to exist instead.
    expect(isPidAlive(2147483646)).toBe(false);
  });
});

describe("getPaSessionLiveness", () => {
  it("returns null when no history exists", async () => {
    const result = await getPaSessionLiveness("nonexistent-workspace-id");
    expect(result).toBeNull();
  });

  it("returns null when history has no pa-session events", async () => {
    await writeHistory("ws1", [
      { type: "iteration", id: "iter1", status: "completed", startedAt: "2026-05-14T10:00:00.000Z" } as never,
    ]);
    const result = await getPaSessionLiveness("ws1");
    expect(result).toBeNull();
  });

  it("returns null when only completed/failed pa-sessions exist (no `running` candidates)", async () => {
    await writeHistory("ws1", [
      {
        type: "pa-session",
        id: "pa1",
        status: "completed",
        startedAt: "2026-05-14T10:00:00.000Z",
        sessionId: "pa-2026-05-14T10-00-00-abc",
        launcherPid: process.pid,
      },
    ]);
    const result = await getPaSessionLiveness("ws1");
    expect(result).toBeNull();
  });

  it("returns null when running event exists but lacks launcherPid (pre-v0.24 event)", async () => {
    // No precise way to verify pre-v0.24 events; we skip them
    // rather than show a potentially-stale chip. boot-reconcile's
    // mtime fallback handles them at next server boot.
    await writeHistory("ws1", [
      {
        type: "pa-session",
        id: "pa1",
        status: "running",
        startedAt: "2026-05-14T10:00:00.000Z",
        sessionId: "pa-2026-05-14T10-00-00-abc",
        // launcherPid missing
      },
    ]);
    const result = await getPaSessionLiveness("ws1");
    expect(result).toBeNull();
  });

  it("returns liveness details when running event has a live launcherPid", async () => {
    // Using process.pid as the launcher PID — guaranteed alive
    // (this test process IS that PID).
    await writeHistory("ws1", [
      {
        type: "pa-session",
        id: "pa1",
        status: "running",
        startedAt: "2026-05-14T10:00:00.000Z",
        sessionId: "pa-2026-05-14T10-00-00-abc123",
        launcherPid: process.pid,
      },
    ]);
    const result = await getPaSessionLiveness("ws1");
    expect(result).not.toBeNull();
    expect(result?.active).toBe(true);
    expect(result?.sessionId).toBe("pa-2026-05-14T10-00-00-abc123");
    expect(result?.launcherPid).toBe(process.pid);
    expect(result?.startedAt).toBe("2026-05-14T10:00:00.000Z");
    expect(result?.eventId).toBe("pa1");
  });

  it("returns null when running event's launcherPid is dead", async () => {
    await writeHistory("ws1", [
      {
        type: "pa-session",
        id: "pa1",
        status: "running",
        startedAt: "2026-05-14T10:00:00.000Z",
        sessionId: "pa-2026-05-14T10-00-00-abc",
        launcherPid: 2147483646, // unlikely-to-exist PID
      },
    ]);
    const result = await getPaSessionLiveness("ws1");
    expect(result).toBeNull();
  });

  it("walks newest-first; surfaces the most recent live PA when multiple are running", async () => {
    await writeHistory("ws1", [
      {
        type: "pa-session",
        id: "pa-old",
        status: "running",
        startedAt: "2026-05-14T09:00:00.000Z",
        sessionId: "pa-old-session",
        launcherPid: process.pid,
      },
      {
        type: "pa-session",
        id: "pa-new",
        status: "running",
        startedAt: "2026-05-14T11:00:00.000Z",
        sessionId: "pa-new-session",
        launcherPid: process.pid,
      },
    ]);
    const result = await getPaSessionLiveness("ws1");
    expect(result?.sessionId).toBe("pa-new-session");
    expect(result?.eventId).toBe("pa-new");
  });

  it("falls through stale entries when the newest running event has a dead PID", async () => {
    // newest = dead PID; older = live PID. The walk should
    // continue past the stale one and surface the older live PA.
    await writeHistory("ws1", [
      {
        type: "pa-session",
        id: "pa-stale-newer",
        status: "running",
        startedAt: "2026-05-14T11:00:00.000Z",
        sessionId: "pa-stale",
        launcherPid: 2147483646, // dead
      },
      {
        type: "pa-session",
        id: "pa-live-older",
        status: "running",
        startedAt: "2026-05-14T10:00:00.000Z",
        sessionId: "pa-live",
        launcherPid: process.pid, // alive
      },
    ]);
    const result = await getPaSessionLiveness("ws1");
    expect(result?.sessionId).toBe("pa-live");
  });
});

describe("getPaSessionsForWorkspaces (batch)", () => {
  it("returns a map of workspace-id → liveness | null, with one entry per id", async () => {
    await writeHistory("ws-alive", [
      {
        type: "pa-session",
        id: "pa1",
        status: "running",
        startedAt: "2026-05-14T10:00:00.000Z",
        sessionId: "alive-session",
        launcherPid: process.pid,
      },
    ]);
    await writeHistory("ws-dead", [
      {
        type: "pa-session",
        id: "pa2",
        status: "running",
        startedAt: "2026-05-14T10:00:00.000Z",
        sessionId: "dead-session",
        launcherPid: 2147483646,
      },
    ]);
    // ws-empty has no history at all

    const result = await getPaSessionsForWorkspaces(["ws-alive", "ws-dead", "ws-empty"]);
    expect(Object.keys(result).sort()).toEqual(["ws-alive", "ws-dead", "ws-empty"]);
    expect(result["ws-alive"]?.sessionId).toBe("alive-session");
    expect(result["ws-dead"]).toBeNull();
    expect(result["ws-empty"]).toBeNull();
  });

  it("returns an empty object for empty input (defensive — never throws)", async () => {
    const result = await getPaSessionsForWorkspaces([]);
    expect(result).toEqual({});
  });
});
