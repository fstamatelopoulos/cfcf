/**
 * Tests for the template resolver (item 5.4).
 *
 * Verifies:
 *   - Embedded defaults are loaded
 *   - Project-local overrides win over user-global and embedded
 *   - User-global overrides win over embedded
 *   - writeTemplateIfMissing does not clobber an existing file
 *   - Unknown template names raise a clear error
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, writeFile, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import {
  getTemplate,
  writeTemplate,
  writeTemplateIfMissing,
  listTemplates,
} from "./templates.js";

const TEST_CONFIG_DIR = join(tmpdir(), `cfcf-templates-test-${process.pid}`);
const TEST_REPO = join(tmpdir(), `cfcf-templates-repo-${process.pid}`);

beforeEach(async () => {
  process.env.CFCF_CONFIG_DIR = TEST_CONFIG_DIR;
  await mkdir(TEST_CONFIG_DIR, { recursive: true });
  await mkdir(TEST_REPO, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_CONFIG_DIR, { recursive: true, force: true });
  await rm(TEST_REPO, { recursive: true, force: true });
  delete process.env.CFCF_CONFIG_DIR;
});

describe("listTemplates", () => {
  test("exposes the full set of embedded templates", () => {
    const names = listTemplates();
    expect(names.length).toBe(14);
    // Spot-check a few critical names
    expect(names).toContain("process.md");
    expect(names).toContain("cfcf-architect-instructions.md");
    expect(names).toContain("cfcf-iteration-signals.json");
    expect(names).toContain("iteration-log.md");
  });
});

describe("getTemplate: embedded defaults", () => {
  test("returns the embedded content for a known template", async () => {
    const content = await getTemplate("process.md");
    expect(content).toContain("cfcf Process Definition");
    expect(content).toContain("Iteration Model");
  });

  test("throws a helpful error for unknown templates", async () => {
    await expect(getTemplate("nope.md")).rejects.toThrow(/Unknown template/);
  });
});

describe("getTemplate: user-global overrides", () => {
  test("returns the user-global file when present", async () => {
    const userDir = join(TEST_CONFIG_DIR, "templates");
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, "process.md"), "USER OVERRIDE\n", "utf-8");

    const content = await getTemplate("process.md");
    expect(content).toBe("USER OVERRIDE\n");
  });

  test("falls back to embedded if the user override is missing", async () => {
    // No override present
    const content = await getTemplate("process.md");
    expect(content).toContain("cfcf Process Definition");
  });
});

describe("getTemplate: project-local overrides", () => {
  test("project-local file takes precedence over user-global and embedded", async () => {
    // Set up BOTH a user-global and a project-local override
    const userDir = join(TEST_CONFIG_DIR, "templates");
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, "plan.md"), "USER plan\n", "utf-8");

    const projectDir = join(TEST_REPO, "cfcf-templates");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "plan.md"), "PROJECT plan\n", "utf-8");

    const content = await getTemplate("plan.md", { repoPath: TEST_REPO });
    expect(content).toBe("PROJECT plan\n");
  });

  test("falls through to user-global when project-local is absent", async () => {
    const userDir = join(TEST_CONFIG_DIR, "templates");
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, "plan.md"), "USER plan\n", "utf-8");

    const content = await getTemplate("plan.md", { repoPath: TEST_REPO });
    expect(content).toBe("USER plan\n");
  });

  test("repoPath is optional; omitting it skips project-local lookup", async () => {
    const projectDir = join(TEST_REPO, "cfcf-templates");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "plan.md"), "PROJECT plan\n", "utf-8");

    // No repoPath option -> project override is invisible
    const content = await getTemplate("plan.md");
    expect(content).not.toBe("PROJECT plan\n");
  });
});

describe("writeTemplate / writeTemplateIfMissing", () => {
  test("writeTemplate overwrites whatever is at the destination", async () => {
    const dest = join(TEST_REPO, "cfcf-docs");
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "plan.md"), "stale\n", "utf-8");

    await writeTemplate(dest, "plan.md");
    const out = await readFile(join(dest, "plan.md"), "utf-8");
    expect(out).toContain("Implementation Plan");
    expect(out).not.toBe("stale\n");
  });

  test("writeTemplateIfMissing does not clobber an existing file", async () => {
    const dest = join(TEST_REPO, "cfcf-docs");
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "plan.md"), "user-authored\n", "utf-8");

    await writeTemplateIfMissing(dest, "plan.md");
    const out = await readFile(join(dest, "plan.md"), "utf-8");
    expect(out).toBe("user-authored\n");
  });

  test("writeTemplateIfMissing creates the file if it doesn't exist", async () => {
    const dest = join(TEST_REPO, "cfcf-docs");
    await mkdir(dest, { recursive: true });

    await writeTemplateIfMissing(dest, "plan.md");
    const out = await readFile(join(dest, "plan.md"), "utf-8");
    expect(out).toContain("Implementation Plan");
  });

  test("writeTemplate honors project-local overrides", async () => {
    const projectDir = join(TEST_REPO, "cfcf-templates");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "plan.md"), "CUSTOM PLAN\n", "utf-8");

    const dest = join(TEST_REPO, "cfcf-docs");
    await mkdir(dest, { recursive: true });

    await writeTemplate(dest, "plan.md", { repoPath: TEST_REPO });
    const out = await readFile(join(dest, "plan.md"), "utf-8");
    expect(out).toBe("CUSTOM PLAN\n");
  });
});
