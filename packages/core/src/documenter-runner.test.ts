/**
 * Tests for the documenter runner module.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, rm } from "fs/promises";
import {
  writeDocumenterInstructions,
} from "./documenter-runner.js";
import type { WorkspaceConfig } from "./types.js";

const TEST_DIR = join(import.meta.dir, "..", ".test-documenter-runner");

function makeProject(overrides?: Partial<WorkspaceConfig>): WorkspaceConfig {
  return {
    id: "test-proj",
    name: "test-project",
    repoPath: TEST_DIR,
    devAgent: { adapter: "claude-code" },
    judgeAgent: { adapter: "codex" },
    architectAgent: { adapter: "claude-code" },
    documenterAgent: { adapter: "claude-code" },
    maxIterations: 10,
    pauseEvery: 0,
    onStalled: "alert",
    mergeStrategy: "auto",
    processTemplate: "default",
    currentIteration: 0,
    ...overrides,
  };
}

beforeEach(async () => {
  await mkdir(join(TEST_DIR, "cfcf-docs"), { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("writeDocumenterInstructions", () => {
  test("writes instructions with project name", async () => {
    await writeDocumenterInstructions(TEST_DIR, makeProject({ name: "my-app" }));
    const { readFile } = await import("fs/promises");
    const content = await readFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-documenter-instructions.md"),
      "utf-8",
    );
    expect(content).toContain("my-app");
    expect(content).not.toContain("{{PROJECT_NAME}}");
    expect(content).toContain("Documenter");
    expect(content).toContain("architecture.md");
    expect(content).toContain("api-reference.md");
    expect(content).toContain("setup-guide.md");
    expect(content).toContain("README.md");
  });

  test("instructions emphasize no code modifications", async () => {
    await writeDocumenterInstructions(TEST_DIR, makeProject());
    const { readFile } = await import("fs/promises");
    const content = await readFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-documenter-instructions.md"),
      "utf-8",
    );
    expect(content).toContain("Do not modify source code");
  });
});
