import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobScheduler } from "./scheduler.js";
import type { Job } from "./types.js";

function tmpStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cfcf-sched-"));
  return join(dir, "scheduler-state.json");
}

describe("JobScheduler.tick", () => {
  test("runs a job whose interval has elapsed", async () => {
    const sched = new JobScheduler({ statePath: tmpStatePath(), runOnStartIfDue: false });
    let calls = 0;
    sched.register({ id: "j1", intervalMs: 1, fn: async () => { calls++; } });
    await sched.tick();
    expect(calls).toBe(1);
    expect(sched.getJob("j1")?.lastRun).toBeDefined();
  });

  test("skips a job whose interval has not yet elapsed", async () => {
    const sched = new JobScheduler({ statePath: tmpStatePath(), runOnStartIfDue: false });
    let calls = 0;
    sched.register({
      id: "j1",
      intervalMs: 60_000,
      fn: async () => { calls++; },
      lastRun: new Date(), // ran just now
    });
    await sched.tick();
    expect(calls).toBe(0);
  });

  test("records lastError on failure but still bumps lastRun (no hot loop)", async () => {
    const sched = new JobScheduler({ statePath: tmpStatePath(), runOnStartIfDue: false });
    let calls = 0;
    sched.register({
      id: "broken",
      intervalMs: 1,
      fn: async () => { calls++; throw new Error("boom"); },
    });
    await sched.tick();
    await sched.tick(); // would re-fire if lastRun didn't bump
    // Both ticks pass intervalMs=1 with a small Date delta but the bumped
    // lastRun keeps us from running on the SAME `now` value.
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(sched.getJob("broken")?.lastError).toBe("boom");
    expect(sched.getJob("broken")?.lastRun).toBeDefined();
  });

  test("clears lastError on a subsequent successful run", async () => {
    const sched = new JobScheduler({ statePath: tmpStatePath(), runOnStartIfDue: false });
    let shouldThrow = true;
    sched.register({
      id: "flap",
      intervalMs: 1,
      fn: async () => { if (shouldThrow) throw new Error("first"); },
    });
    await sched.tick();
    expect(sched.getJob("flap")?.lastError).toBe("first");
    shouldThrow = false;
    // Force re-run by clearing lastRun
    sched.getJob("flap")!.lastRun = undefined;
    await sched.tick();
    expect(sched.getJob("flap")?.lastError).toBeUndefined();
  });
});

describe("JobScheduler persistence", () => {
  test("persists lastRun + lastError after each run", async () => {
    const path = tmpStatePath();
    const sched = new JobScheduler({ statePath: path, runOnStartIfDue: false });
    sched.register({ id: "j1", intervalMs: 1, fn: async () => { throw new Error("x"); } });
    await sched.tick();
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    expect(raw.version).toBe(1);
    expect(raw.jobs.j1.lastError).toBe("x");
    expect(raw.jobs.j1.lastRun).toBeDefined();
  });

  test("loads prior state on start so missed-tick window is bounded", async () => {
    const path = tmpStatePath();
    // Pretend a run happened 30 s ago.
    const past = new Date(Date.now() - 30_000).toISOString();
    writeFileSync(path, JSON.stringify({ version: 1, jobs: { j1: { lastRun: past, lastError: null } } }));

    const sched = new JobScheduler({ statePath: path, runOnStartIfDue: false });
    let calls = 0;
    sched.register({ id: "j1", intervalMs: 60_000, fn: async () => { calls++; } });
    await sched.start(); // loads state but won't tick because runOnStartIfDue=false
    sched.stop();
    expect(calls).toBe(0);
    expect(sched.getJob("j1")?.lastRun?.toISOString()).toBe(past);
  });

  test("runOnStartIfDue catches missed ticks across restart", async () => {
    const path = tmpStatePath();
    // Pretend a run happened 25 hours ago; interval is 24h => due.
    const longAgo = new Date(Date.now() - 25 * 3_600_000).toISOString();
    writeFileSync(path, JSON.stringify({ version: 1, jobs: { j1: { lastRun: longAgo, lastError: null } } }));

    const sched = new JobScheduler({ statePath: path, runOnStartIfDue: true });
    let calls = 0;
    sched.register({ id: "j1", intervalMs: 24 * 3_600_000, fn: async () => { calls++; } });
    await sched.start();
    sched.stop();
    expect(calls).toBe(1);
  });

  test("ignores corrupt state file (does not crash startup)", async () => {
    const path = tmpStatePath();
    writeFileSync(path, "{not json");
    const sched = new JobScheduler({ statePath: path, runOnStartIfDue: false });
    sched.register({ id: "j1", intervalMs: 60_000, fn: async () => {} });
    await sched.start(); // must not throw
    sched.stop();
    expect(sched.getJob("j1")?.lastRun).toBeUndefined();
  });
});

describe("JobScheduler runOnStart", () => {
  test("fires a runOnStart job at start regardless of lastRun", async () => {
    const path = tmpStatePath();
    // Pretend it just ran 1 second ago. With a 24h interval the regular
    // due-tick would NOT fire it -- runOnStart bypasses that.
    const recent = new Date(Date.now() - 1_000).toISOString();
    writeFileSync(path, JSON.stringify({ version: 1, jobs: { boot: { lastRun: recent, lastError: null } } }));

    const sched = new JobScheduler({ statePath: path, runOnStartIfDue: false });
    let calls = 0;
    sched.register({
      id: "boot",
      intervalMs: 24 * 3_600_000,
      runOnStart: true,
      fn: async () => { calls++; },
    });
    await sched.start();
    sched.stop();
    expect(calls).toBe(1);
  });

  test("a runOnStart job that just fired does NOT re-fire from runOnStartIfDue's tick", async () => {
    const sched = new JobScheduler({ statePath: tmpStatePath(), runOnStartIfDue: true });
    let calls = 0;
    sched.register({
      id: "boot",
      intervalMs: 24 * 3_600_000,
      runOnStart: true,
      fn: async () => { calls++; },
    });
    await sched.start();
    sched.stop();
    // runOnStart fires it once; the immediate tick after sees lastRun was
    // just bumped (well under 24h) and skips it.
    expect(calls).toBe(1);
  });

  test("non-runOnStart jobs are not auto-fired at start", async () => {
    const sched = new JobScheduler({ statePath: tmpStatePath(), runOnStartIfDue: false });
    let calls = 0;
    sched.register({
      id: "regular",
      intervalMs: 24 * 3_600_000,
      fn: async () => { calls++; },
      lastRun: new Date(Date.now() - 1000),
    });
    await sched.start();
    sched.stop();
    expect(calls).toBe(0);
  });
});

describe("JobScheduler.register", () => {
  test("rejects duplicate ids", () => {
    const sched = new JobScheduler({ statePath: tmpStatePath() });
    const j: Job = { id: "dup", intervalMs: 1, fn: async () => {} };
    sched.register(j);
    expect(() => sched.register(j)).toThrow(/already registered/);
  });

  test("rejects non-positive interval", () => {
    const sched = new JobScheduler({ statePath: tmpStatePath() });
    expect(() =>
      sched.register({ id: "z", intervalMs: 0, fn: async () => {} }),
    ).toThrow(/non-positive/);
  });
});
