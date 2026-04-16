/**
 * Git manager for cfcf.
 *
 * Manages feature branches, commits, diffs, and resets for iteration isolation.
 * All operations shell out to git CLI (requires git to be installed).
 */

export interface GitResult {
  success: boolean;
  output: string;
  error?: string;
}

/**
 * Run a git command in the specified directory.
 */
async function git(repoPath: string, args: string[]): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    return {
      success: false,
      output: stdout.trim(),
      error: stderr.trim() || `git exited with code ${exitCode}`,
    };
  }

  return { success: true, output: stdout.trim() };
}

/**
 * Check if a directory is a git repository.
 */
export async function isGitRepo(repoPath: string): Promise<boolean> {
  const result = await git(repoPath, ["rev-parse", "--is-inside-work-tree"]);
  return result.success && result.output === "true";
}

/**
 * Get the current branch name.
 */
export async function getCurrentBranch(repoPath: string): Promise<string | null> {
  const result = await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return result.success ? result.output : null;
}

/**
 * Create a new branch off the current HEAD and switch to it.
 */
export async function createBranch(repoPath: string, branchName: string): Promise<GitResult> {
  return git(repoPath, ["checkout", "-b", branchName]);
}

/**
 * Switch to an existing branch.
 */
export async function checkoutBranch(repoPath: string, branchName: string): Promise<GitResult> {
  return git(repoPath, ["checkout", branchName]);
}

/**
 * Check if there are uncommitted changes.
 */
export async function hasChanges(repoPath: string): Promise<boolean> {
  const result = await git(repoPath, ["status", "--porcelain"]);
  return result.success && result.output.length > 0;
}

/**
 * Stage all changes and commit.
 */
export async function commitAll(repoPath: string, message: string): Promise<GitResult> {
  const addResult = await git(repoPath, ["add", "-A"]);
  if (!addResult.success) return addResult;

  // Check if there's anything to commit
  if (!(await hasChanges(repoPath))) {
    // Check if there are staged changes
    const diffResult = await git(repoPath, ["diff", "--cached", "--quiet"]);
    if (diffResult.success) {
      return { success: true, output: "nothing to commit" };
    }
  }

  return git(repoPath, ["commit", "-m", message]);
}

/**
 * Get the diff of uncommitted changes.
 */
export async function getDiff(repoPath: string): Promise<string> {
  const result = await git(repoPath, ["diff"]);
  return result.output;
}

/**
 * Get the diff between two commits or a commit and HEAD.
 */
export async function getDiffBetween(
  repoPath: string,
  from: string,
  to: string = "HEAD",
): Promise<string> {
  const result = await git(repoPath, ["diff", from, to]);
  return result.output;
}

/**
 * Get the short hash of the current HEAD.
 */
export async function getHeadHash(repoPath: string): Promise<string | null> {
  const result = await git(repoPath, ["rev-parse", "--short", "HEAD"]);
  return result.success ? result.output : null;
}

/**
 * Reset to a specific commit, discarding all changes.
 */
export async function resetHard(repoPath: string, commitish: string): Promise<GitResult> {
  return git(repoPath, ["reset", "--hard", commitish]);
}

/**
 * Push a branch to the remote.
 */
export async function push(
  repoPath: string,
  remote: string = "origin",
  branch?: string,
): Promise<GitResult> {
  const args = ["push", remote];
  if (branch) args.push(branch);
  return git(repoPath, args);
}

/**
 * Check if a branch exists locally.
 */
export async function branchExists(repoPath: string, branchName: string): Promise<boolean> {
  const result = await git(repoPath, ["rev-parse", "--verify", branchName]);
  return result.success;
}

/**
 * Delete a local branch.
 */
export async function deleteBranch(repoPath: string, branchName: string): Promise<GitResult> {
  return git(repoPath, ["branch", "-D", branchName]);
}

/**
 * Get the log of commits on the current branch (short format).
 */
export async function getLog(
  repoPath: string,
  maxCount: number = 10,
): Promise<string> {
  const result = await git(repoPath, [
    "log",
    `--max-count=${maxCount}`,
    "--oneline",
    "--no-decorate",
  ]);
  return result.output;
}

/**
 * Merge a branch into the current branch.
 * Uses --no-ff to always create a merge commit, preserving iteration
 * boundaries in the git history (so `git log --graph` shows each
 * iteration as a distinct branch that got merged in).
 */
export async function merge(
  repoPath: string,
  branchName: string,
  message?: string,
): Promise<GitResult> {
  const args = ["merge", "--no-ff", branchName];
  if (message) args.push("-m", message);
  return git(repoPath, args);
}
