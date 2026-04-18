/**
 * Tests for the active processes registry.
 * Focus: the registry logic, not actual process spawning.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  registerProcess,
  getActiveProcess,
  getActiveProcessesForProject,
  getAllActiveProcesses,
  killProjectProcesses,
  killAllActiveProcesses,
  clearRegistry,
} from "./active-processes.js";
import type { ManagedProcess } from "./process-manager.js";

// Fake ManagedProcess that counts kill() calls
function makeFakeProcess(): ManagedProcess & { killCount: number } {
  const fake = {
    killCount: 0,
    proc: {} as any,
    result: Promise.resolve({ exitCode: 0, durationMs: 0, killed: false }),
    kill() {
      this.killCount++;
    },
  };
  return fake;
}

describe("active-processes registry", () => {
  beforeEach(() => {
    clearRegistry();
  });

  test("registerProcess + getActiveProcess round-trip", () => {
    const proc = makeFakeProcess();
    registerProcess({
      projectId: "p1",
      role: "dev",
      process: proc,
      startedAt: new Date().toISOString(),
    });
    const entry = getActiveProcess("p1", "dev");
    expect(entry).toBeDefined();
    expect(entry!.process).toBe(proc);
  });

  test("unregister cleanup function removes the entry", () => {
    const proc = makeFakeProcess();
    const unregister = registerProcess({
      projectId: "p1",
      role: "dev",
      process: proc,
      startedAt: new Date().toISOString(),
    });
    expect(getActiveProcess("p1", "dev")).toBeDefined();
    unregister();
    expect(getActiveProcess("p1", "dev")).toBeUndefined();
  });

  test("unregister does not remove a replaced entry", () => {
    const proc1 = makeFakeProcess();
    const proc2 = makeFakeProcess();
    const unregister1 = registerProcess({
      projectId: "p1",
      role: "dev",
      process: proc1,
      startedAt: new Date().toISOString(),
    });
    // Replace with new process
    registerProcess({
      projectId: "p1",
      role: "dev",
      process: proc2,
      startedAt: new Date().toISOString(),
    });
    // First process's unregister should be a no-op now
    unregister1();
    expect(getActiveProcess("p1", "dev")?.process).toBe(proc2);
  });

  test("getActiveProcessesForProject returns only matching project", () => {
    const p1Dev = makeFakeProcess();
    const p1Judge = makeFakeProcess();
    const p2Dev = makeFakeProcess();
    registerProcess({ projectId: "p1", role: "dev", process: p1Dev, startedAt: "" });
    registerProcess({ projectId: "p1", role: "judge", process: p1Judge, startedAt: "" });
    registerProcess({ projectId: "p2", role: "dev", process: p2Dev, startedAt: "" });

    const p1 = getActiveProcessesForProject("p1");
    expect(p1).toHaveLength(2);
    const p2 = getActiveProcessesForProject("p2");
    expect(p2).toHaveLength(1);
    expect(p2[0].process).toBe(p2Dev);
  });

  test("getAllActiveProcesses returns all", () => {
    const p1Dev = makeFakeProcess();
    const p2Judge = makeFakeProcess();
    registerProcess({ projectId: "p1", role: "dev", process: p1Dev, startedAt: "" });
    registerProcess({ projectId: "p2", role: "judge", process: p2Judge, startedAt: "" });
    expect(getAllActiveProcesses()).toHaveLength(2);
  });

  test("killProjectProcesses kills and removes only that project's entries", () => {
    const p1Dev = makeFakeProcess();
    const p1Judge = makeFakeProcess();
    const p2Dev = makeFakeProcess();
    registerProcess({ projectId: "p1", role: "dev", process: p1Dev, startedAt: "" });
    registerProcess({ projectId: "p1", role: "judge", process: p1Judge, startedAt: "" });
    registerProcess({ projectId: "p2", role: "dev", process: p2Dev, startedAt: "" });

    const killed = killProjectProcesses("p1");
    expect(killed).toBe(2);
    expect(p1Dev.killCount).toBe(1);
    expect(p1Judge.killCount).toBe(1);
    expect(p2Dev.killCount).toBe(0);
    expect(getActiveProcessesForProject("p1")).toHaveLength(0);
    expect(getActiveProcessesForProject("p2")).toHaveLength(1);
  });

  test("killAllActiveProcesses kills and empties the registry", () => {
    const a = makeFakeProcess();
    const b = makeFakeProcess();
    registerProcess({ projectId: "p1", role: "dev", process: a, startedAt: "" });
    registerProcess({ projectId: "p2", role: "judge", process: b, startedAt: "" });

    const killed = killAllActiveProcesses();
    expect(killed).toBe(2);
    expect(a.killCount).toBe(1);
    expect(b.killCount).toBe(1);
    expect(getAllActiveProcesses()).toHaveLength(0);
  });

  test("kill() that throws is swallowed so remaining processes still get killed", () => {
    const throwing: ManagedProcess = {
      proc: {} as any,
      result: Promise.resolve({ exitCode: 0, durationMs: 0, killed: false }),
      kill() {
        throw new Error("boom");
      },
    };
    const good = makeFakeProcess();
    registerProcess({ projectId: "p1", role: "dev", process: throwing, startedAt: "" });
    registerProcess({ projectId: "p1", role: "judge", process: good, startedAt: "" });

    const killed = killAllActiveProcesses();
    // Both counted as attempted; throwing process reports as failed via exception swallow
    expect(killed).toBeGreaterThanOrEqual(1);
    expect(good.killCount).toBe(1);
  });
});
