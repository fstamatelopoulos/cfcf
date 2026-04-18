import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import {
  isGitRepo,
  getCurrentBranch,
  createBranch,
  checkoutBranch,
  hasChanges,
  commitAll,
  getDiff,
  getHeadHash,
  branchExists,
  getLog,
  deleteBranch,
  merge,
} from "./git-manager.js";

describe("git manager", () => {
  let repoDir: string;

  beforeEach(async () => {
    // Create a real temporary git repo
    repoDir = await mkdtemp(join(tmpdir(), "cfcf-git-test-"));

    const spawn = (args: string[]) =>
      Bun.spawn(["git", ...args], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });

    await spawn(["init"]).exited;
    await spawn(["config", "user.email", "test@cfcf.dev"]).exited;
    await spawn(["config", "user.name", "cfcf test"]).exited;

    // Create initial commit
    await writeFile(join(repoDir, "README.md"), "# test\n");
    await spawn(["add", "-A"]).exited;
    await spawn(["commit", "-m", "initial"]).exited;
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  describe("isGitRepo", () => {
    it("returns true for a git repo", async () => {
      expect(await isGitRepo(repoDir)).toBe(true);
    });

    it("returns false for a non-repo directory", async () => {
      const nonRepo = await mkdtemp(join(tmpdir(), "cfcf-nongit-"));
      try {
        expect(await isGitRepo(nonRepo)).toBe(false);
      } finally {
        await rm(nonRepo, { recursive: true, force: true });
      }
    });
  });

  describe("getCurrentBranch", () => {
    it("returns the current branch name", async () => {
      const branch = await getCurrentBranch(repoDir);
      // Could be "main" or "master" depending on git config
      expect(branch).toBeTruthy();
    });
  });

  describe("createBranch / checkoutBranch / branchExists", () => {
    it("creates and switches to a new branch", async () => {
      const result = await createBranch(repoDir, "cfcf/test-branch");
      expect(result.success).toBe(true);

      const current = await getCurrentBranch(repoDir);
      expect(current).toBe("cfcf/test-branch");
    });

    it("can switch back to a previous branch", async () => {
      const originalBranch = await getCurrentBranch(repoDir);
      await createBranch(repoDir, "cfcf/temp");
      await checkoutBranch(repoDir, originalBranch!);

      expect(await getCurrentBranch(repoDir)).toBe(originalBranch);
    });

    it("reports branch existence", async () => {
      expect(await branchExists(repoDir, "cfcf/new-branch")).toBe(false);
      await createBranch(repoDir, "cfcf/new-branch");
      expect(await branchExists(repoDir, "cfcf/new-branch")).toBe(true);
    });
  });

  describe("hasChanges / commitAll", () => {
    it("detects no changes on clean repo", async () => {
      expect(await hasChanges(repoDir)).toBe(false);
    });

    it("detects changes after file modification", async () => {
      await writeFile(join(repoDir, "new-file.txt"), "hello\n");
      expect(await hasChanges(repoDir)).toBe(true);
    });

    it("commits all changes", async () => {
      await writeFile(join(repoDir, "new-file.txt"), "hello\n");
      const result = await commitAll(repoDir, "test commit");
      expect(result.success).toBe(true);
      expect(await hasChanges(repoDir)).toBe(false);
    });

    it("handles nothing to commit gracefully", async () => {
      const result = await commitAll(repoDir, "empty commit");
      expect(result.success).toBe(true);
      expect(result.output).toContain("nothing to commit");
    });
  });

  describe("getDiff", () => {
    it("returns empty for clean repo", async () => {
      const diff = await getDiff(repoDir);
      expect(diff).toBe("");
    });

    it("returns diff for modified files", async () => {
      await writeFile(join(repoDir, "README.md"), "# changed\n");
      const diff = await getDiff(repoDir);
      expect(diff).toContain("changed");
    });
  });

  describe("getHeadHash", () => {
    it("returns a short hash", async () => {
      const hash = await getHeadHash(repoDir);
      expect(hash).toBeTruthy();
      expect(hash!.length).toBeGreaterThanOrEqual(7);
    });
  });

  describe("getLog", () => {
    it("returns commit log", async () => {
      const log = await getLog(repoDir);
      expect(log).toContain("initial");
    });
  });

  describe("deleteBranch + merge (item 5.2 cleanup flow)", () => {
    it("deletes a fully-merged iteration branch after merge", async () => {
      // Create a cfcf-style iteration branch, commit on it, merge to main, delete it.
      const mainBranch = await getCurrentBranch(repoDir);
      await createBranch(repoDir, "cfcf/iteration-1");
      await writeFile(join(repoDir, "feature.txt"), "iteration work\n");
      await commitAll(repoDir, "iteration 1 work");

      // Merge back
      await checkoutBranch(repoDir, mainBranch!);
      const mergeResult = await merge(repoDir, "cfcf/iteration-1", "merge iter 1");
      expect(mergeResult.success).toBe(true);

      // Branch still exists before cleanup
      expect(await branchExists(repoDir, "cfcf/iteration-1")).toBe(true);

      // Delete it (this is what iteration-loop does when cleanupMergedBranches is true)
      const delResult = await deleteBranch(repoDir, "cfcf/iteration-1");
      expect(delResult.success).toBe(true);
      expect(await branchExists(repoDir, "cfcf/iteration-1")).toBe(false);
    });

    it("deleteBranch reports failure without crashing when branch doesn't exist", async () => {
      const result = await deleteBranch(repoDir, "cfcf/iteration-never-existed");
      // Git exits non-zero; our helper surfaces that as success=false + an error string
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });
});
