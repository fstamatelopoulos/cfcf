import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import {
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  findWorkspaceByName,
  updateWorkspace,
  deleteWorkspace,
  validateWorkspaceRepo,
  nextIteration,
} from "./workspaces.js";

describe("projects", () => {
  let tempDir: string;
  let repoDir: string;
  const originalEnv = process.env.CFCF_CONFIG_DIR;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cfcf-proj-test-"));
    process.env.CFCF_CONFIG_DIR = tempDir;

    // Create a fake git repo for tests
    repoDir = join(tempDir, "fake-repo");
    await mkdir(join(repoDir, ".git"), { recursive: true });
  });

  afterEach(async () => {
    process.env.CFCF_CONFIG_DIR = originalEnv;
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("createWorkspace", () => {
    it("creates a project with defaults", async () => {
      const project = await createWorkspace({
        name: "test-project",
        repoPath: repoDir,
      });

      expect(project.name).toBe("test-project");
      expect(project.repoPath).toBe(repoDir);
      expect(project.id).toMatch(/^test-project-[a-f0-9]{6}$/);
      expect(project.devAgent.adapter).toBeDefined();
      expect(project.judgeAgent.adapter).toBeDefined();
      expect(project.maxIterations).toBeGreaterThan(0);
      expect(project.currentIteration).toBe(0);
    });

    it("creates a project with custom config", async () => {
      const project = await createWorkspace({
        name: "custom",
        repoPath: repoDir,
        devAgent: { adapter: "codex" },
        maxIterations: 5,
      });

      expect(project.devAgent.adapter).toBe("codex");
      expect(project.maxIterations).toBe(5);
    });

    it("defaults cleanupMergedBranches to false (item 5.2)", async () => {
      const project = await createWorkspace({
        name: "cleanup-default",
        repoPath: repoDir,
      });
      // Default: false -- we preserve merged iteration branches for audit.
      expect(project.cleanupMergedBranches).toBe(false);
    });
  });

  describe("getWorkspace", () => {
    it("returns null for non-existent project", async () => {
      expect(await getWorkspace("nonexistent")).toBeNull();
    });

    it("returns the project after creation", async () => {
      const created = await createWorkspace({ name: "my-app", repoPath: repoDir });
      const fetched = await getWorkspace(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.name).toBe("my-app");
    });
  });

  describe("listWorkspaces", () => {
    it("returns empty array when no projects", async () => {
      expect(await listWorkspaces()).toEqual([]);
    });

    it("returns all projects sorted by name", async () => {
      await createWorkspace({ name: "bravo", repoPath: repoDir });
      await createWorkspace({ name: "alpha", repoPath: repoDir });

      const projects = await listWorkspaces();
      expect(projects.length).toBe(2);
      expect(projects[0].name).toBe("alpha");
      expect(projects[1].name).toBe("bravo");
    });
  });

  describe("findWorkspaceByName", () => {
    it("finds by exact name match", async () => {
      await createWorkspace({ name: "my-app", repoPath: repoDir });
      const found = await findWorkspaceByName("my-app");
      expect(found).not.toBeNull();
      expect(found!.name).toBe("my-app");
    });

    it("is case-insensitive", async () => {
      await createWorkspace({ name: "My-App", repoPath: repoDir });
      const found = await findWorkspaceByName("my-app");
      expect(found).not.toBeNull();
    });

    it("returns null when not found", async () => {
      expect(await findWorkspaceByName("nonexistent")).toBeNull();
    });
  });

  describe("updateWorkspace", () => {
    it("updates project fields", async () => {
      const created = await createWorkspace({ name: "updatable", repoPath: repoDir });
      const updated = await updateWorkspace(created.id, { maxIterations: 20 });
      expect(updated).not.toBeNull();
      expect(updated!.maxIterations).toBe(20);
      expect(updated!.name).toBe("updatable"); // unchanged
    });

    it("returns null for non-existent project", async () => {
      expect(await updateWorkspace("nonexistent", { maxIterations: 5 })).toBeNull();
    });
  });

  describe("deleteWorkspace", () => {
    it("deletes an existing project", async () => {
      const created = await createWorkspace({ name: "deletable", repoPath: repoDir });
      expect(await deleteWorkspace(created.id)).toBe(true);
      expect(await getWorkspace(created.id)).toBeNull();
    });

    it("returns false for non-existent project", async () => {
      expect(await deleteWorkspace("nonexistent")).toBe(true); // rm -rf is idempotent
    });
  });

  describe("nextIteration", () => {
    it("increments from 0 to 1", async () => {
      const project = await createWorkspace({ name: "iter-test", repoPath: repoDir });
      const next = await nextIteration(project.id);
      expect(next).toBe(1);

      const updated = await getWorkspace(project.id);
      expect(updated!.currentIteration).toBe(1);
    });

    it("increments monotonically", async () => {
      const project = await createWorkspace({ name: "mono-test", repoPath: repoDir });
      expect(await nextIteration(project.id)).toBe(1);
      expect(await nextIteration(project.id)).toBe(2);
      expect(await nextIteration(project.id)).toBe(3);
    });

    it("returns null for non-existent project", async () => {
      expect(await nextIteration("nonexistent")).toBeNull();
    });
  });

  describe("validateWorkspaceRepo", () => {
    it("validates a valid git repo", async () => {
      const result = await validateWorkspaceRepo(repoDir);
      expect(result.valid).toBe(true);
    });

    it("rejects a non-existent directory", async () => {
      const result = await validateWorkspaceRepo("/nonexistent/path");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("rejects a directory that is not a git repo", async () => {
      const nonGitDir = join(tempDir, "not-git");
      await mkdir(nonGitDir, { recursive: true });
      const result = await validateWorkspaceRepo(nonGitDir);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Not a git repository");
    });
  });
});
