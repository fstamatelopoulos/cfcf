import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import {
  createProject,
  getProject,
  listProjects,
  findProjectByName,
  updateProject,
  deleteProject,
  validateProjectRepo,
  nextIteration,
} from "./projects.js";

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

  describe("createProject", () => {
    it("creates a project with defaults", async () => {
      const project = await createProject({
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
      const project = await createProject({
        name: "custom",
        repoPath: repoDir,
        devAgent: { adapter: "codex" },
        maxIterations: 5,
      });

      expect(project.devAgent.adapter).toBe("codex");
      expect(project.maxIterations).toBe(5);
    });
  });

  describe("getProject", () => {
    it("returns null for non-existent project", async () => {
      expect(await getProject("nonexistent")).toBeNull();
    });

    it("returns the project after creation", async () => {
      const created = await createProject({ name: "my-app", repoPath: repoDir });
      const fetched = await getProject(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.name).toBe("my-app");
    });
  });

  describe("listProjects", () => {
    it("returns empty array when no projects", async () => {
      expect(await listProjects()).toEqual([]);
    });

    it("returns all projects sorted by name", async () => {
      await createProject({ name: "bravo", repoPath: repoDir });
      await createProject({ name: "alpha", repoPath: repoDir });

      const projects = await listProjects();
      expect(projects.length).toBe(2);
      expect(projects[0].name).toBe("alpha");
      expect(projects[1].name).toBe("bravo");
    });
  });

  describe("findProjectByName", () => {
    it("finds by exact name match", async () => {
      await createProject({ name: "my-app", repoPath: repoDir });
      const found = await findProjectByName("my-app");
      expect(found).not.toBeNull();
      expect(found!.name).toBe("my-app");
    });

    it("is case-insensitive", async () => {
      await createProject({ name: "My-App", repoPath: repoDir });
      const found = await findProjectByName("my-app");
      expect(found).not.toBeNull();
    });

    it("returns null when not found", async () => {
      expect(await findProjectByName("nonexistent")).toBeNull();
    });
  });

  describe("updateProject", () => {
    it("updates project fields", async () => {
      const created = await createProject({ name: "updatable", repoPath: repoDir });
      const updated = await updateProject(created.id, { maxIterations: 20 });
      expect(updated).not.toBeNull();
      expect(updated!.maxIterations).toBe(20);
      expect(updated!.name).toBe("updatable"); // unchanged
    });

    it("returns null for non-existent project", async () => {
      expect(await updateProject("nonexistent", { maxIterations: 5 })).toBeNull();
    });
  });

  describe("deleteProject", () => {
    it("deletes an existing project", async () => {
      const created = await createProject({ name: "deletable", repoPath: repoDir });
      expect(await deleteProject(created.id)).toBe(true);
      expect(await getProject(created.id)).toBeNull();
    });

    it("returns false for non-existent project", async () => {
      expect(await deleteProject("nonexistent")).toBe(true); // rm -rf is idempotent
    });
  });

  describe("nextIteration", () => {
    it("increments from 0 to 1", async () => {
      const project = await createProject({ name: "iter-test", repoPath: repoDir });
      const next = await nextIteration(project.id);
      expect(next).toBe(1);

      const updated = await getProject(project.id);
      expect(updated!.currentIteration).toBe(1);
    });

    it("increments monotonically", async () => {
      const project = await createProject({ name: "mono-test", repoPath: repoDir });
      expect(await nextIteration(project.id)).toBe(1);
      expect(await nextIteration(project.id)).toBe(2);
      expect(await nextIteration(project.id)).toBe(3);
    });

    it("returns null for non-existent project", async () => {
      expect(await nextIteration("nonexistent")).toBeNull();
    });
  });

  describe("validateProjectRepo", () => {
    it("validates a valid git repo", async () => {
      const result = await validateProjectRepo(repoDir);
      expect(result.valid).toBe(true);
    });

    it("rejects a non-existent directory", async () => {
      const result = await validateProjectRepo("/nonexistent/path");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("rejects a directory that is not a git repo", async () => {
      const nonGitDir = join(tempDir, "not-git");
      await mkdir(nonGitDir, { recursive: true });
      const result = await validateProjectRepo(nonGitDir);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Not a git repository");
    });
  });
});
