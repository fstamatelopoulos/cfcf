/**
 * Tests for the disk-backed agent state store helpers (item F.23, v0.24).
 *
 * The runners (architect-runner, documenter-runner, reflection-runner)
 * each use their own filename + active-status set; these tests exercise
 * the underlying primitives directly to keep them stable as the
 * runners' state shapes evolve.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import {
  persistAgentState,
  loadAgentState,
  cleanupStaleAgentStates,
  type PersistableAgentState,
} from "./agent-state-store.js";

const TEST_CONFIG_DIR = join(tmpdir(), `cfcf-state-store-test-${process.pid}`);

beforeEach(async () => {
  process.env.CFCF_CONFIG_DIR = TEST_CONFIG_DIR;
  await rm(TEST_CONFIG_DIR, { recursive: true, force: true });
  await mkdir(TEST_CONFIG_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_CONFIG_DIR, { recursive: true, force: true });
  delete process.env.CFCF_CONFIG_DIR;
});

interface TestState extends PersistableAgentState {
  custom?: string;
}

async function seedWorkspace(id: string): Promise<void> {
  await mkdir(join(TEST_CONFIG_DIR, "workspaces", id), { recursive: true });
}

describe("agent-state-store", () => {
  test("persistAgentState + loadAgentState round-trip", async () => {
    await seedWorkspace("ws-1");
    const state: TestState = {
      workspaceId: "ws-1",
      status: "executing",
      startedAt: new Date().toISOString(),
      custom: "extra",
    };
    await persistAgentState("test-state.json", state);
    const loaded = await loadAgentState<TestState>("test-state.json", "ws-1");
    expect(loaded).toEqual(state);
  });

  test("loadAgentState returns null when the file doesn't exist", async () => {
    await seedWorkspace("ws-2");
    const loaded = await loadAgentState<TestState>("test-state.json", "ws-2");
    expect(loaded).toBeNull();
  });

  test("loadAgentState returns null when the file is malformed JSON", async () => {
    await seedWorkspace("ws-3");
    // Write garbage directly to the path the helper reads.
    const path = join(TEST_CONFIG_DIR, "workspaces", "ws-3", "test-state.json");
    const { writeFile } = await import("fs/promises");
    await writeFile(path, "not valid json {", "utf-8");
    const loaded = await loadAgentState<TestState>("test-state.json", "ws-3");
    expect(loaded).toBeNull();
  });

  test("persistAgentState creates the workspace dir if missing", async () => {
    // Don't seed — persist should mkdir.
    const state: TestState = {
      workspaceId: "ws-fresh",
      status: "preparing",
      startedAt: new Date().toISOString(),
    };
    await persistAgentState("test-state.json", state);
    const path = join(TEST_CONFIG_DIR, "workspaces", "ws-fresh", "test-state.json");
    const raw = await readFile(path, "utf-8");
    expect(JSON.parse(raw)).toEqual(state);
  });
});

// We need a real Workspace registered in cfcf to test cleanupStaleAgentStates,
// because it imports listWorkspaces under the hood. Use an end-to-end style
// here with a minimal workspace config seeded on disk.
async function seedRegisteredWorkspace(id: string, name: string): Promise<void> {
  const dir = join(TEST_CONFIG_DIR, "workspaces", id);
  await mkdir(dir, { recursive: true });
  const config = {
    id,
    name,
    repoPath: "/tmp/repo",
    devAgent: { adapter: "codex" },
    judgeAgent: { adapter: "codex" },
    architectAgent: { adapter: "codex" },
    documenterAgent: { adapter: "codex" },
    maxIterations: 10,
    pauseEvery: 0,
    onStalled: "alert",
    mergeStrategy: "auto",
    processTemplate: "default",
    currentIteration: 0,
  };
  const { writeFile } = await import("fs/promises");
  await writeFile(join(dir, "config.json"), JSON.stringify(config, null, 2), "utf-8");
}

describe("cleanupStaleAgentStates", () => {
  test("flips active states to failed; leaves terminal states alone", async () => {
    await seedRegisteredWorkspace("ws-active", "active-ws");
    await seedRegisteredWorkspace("ws-terminal", "terminal-ws");
    await seedRegisteredWorkspace("ws-no-state", "no-state-ws");

    await persistAgentState("test-state.json", {
      workspaceId: "ws-active",
      status: "executing",
      startedAt: new Date().toISOString(),
    });
    await persistAgentState("test-state.json", {
      workspaceId: "ws-terminal",
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    const cleaned = await cleanupStaleAgentStates(
      "test-state.json",
      new Set(["preparing", "executing"]),
      "Server restarted",
    );
    expect(cleaned).toBe(1); // only ws-active

    const active = await loadAgentState<TestState>("test-state.json", "ws-active");
    expect(active?.status).toBe("failed");
    expect(active?.error).toBe("Server restarted");
    expect(active?.completedAt).toBeDefined();

    const terminal = await loadAgentState<TestState>("test-state.json", "ws-terminal");
    expect(terminal?.status).toBe("completed"); // untouched
    expect(terminal?.error).toBeUndefined();
  });

  test("returns 0 when no workspace has a state file", async () => {
    await seedRegisteredWorkspace("ws-empty", "empty-ws");
    const cleaned = await cleanupStaleAgentStates(
      "test-state.json",
      new Set(["executing"]),
      "Server restarted",
    );
    expect(cleaned).toBe(0);
  });
});
