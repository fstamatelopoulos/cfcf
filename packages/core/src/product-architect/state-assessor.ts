/**
 * Product Architect — full state assessment at launch.
 *
 * cfcf computes this BEFORE spawning the agent and injects the
 * formatted result into the system prompt as the "State assessment"
 * section. The agent's first response is informed by this snapshot
 * (e.g. "I see this isn't a git repo yet — want me to run `git
 * init`?" / "I see we drafted problem.md last session, ready to
 * refine success.md?").
 *
 * State sources:
 *   - Repo path (from --repo or cwd)
 *   - Git: is `<repo>/.git/` present? Latest commit?
 *   - cfcf workspace registration: is there a registered workspace
 *     for this repoPath? If so, workspace_id + name + clio_project.
 *   - cfcf server: is it running (pid file)? PID + port?
 *   - Iteration history: cfcf-docs/iteration-history.md (read if any)
 *   - Problem Pack files: <repo>/problem-pack/*.md
 *   - PA cache: <repo>/.cfcf-pa/* (existing files from prior sessions)
 *
 * All readers are best-effort. Missing files / failed lookups produce
 * `null` / empty fields; the formatter renders the "missing" branches
 * explicitly so the agent knows what to do.
 *
 * Plan item 5.14 (v2). Design: docs/research/product-architect-design.md
 * §"Pre-injection at launch".
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { listWorkspaces } from "../workspaces.js";
import { readPidFile, isProcessRunning } from "../pid-file.js";

// ── State shapes ─────────────────────────────────────────────────────

export interface GitState {
  /** Is `<repo>/.git/` present? */
  isGitRepo: boolean;
  /** Latest commit one-liner (e.g. "abc1234 feat: add login"). Null when no commits or not a repo. */
  latestCommit: string | null;
}

export interface WorkspaceRegistration {
  /** Whether a cfcf workspace is registered for this repo path. */
  registered: boolean;
  /** cfcf workspace UUID if registered. */
  workspaceId: string | null;
  /** Workspace name if registered. */
  name: string | null;
  /** Clio Project the workspace is bound to (may be null). */
  clioProject: string | null;
  /** Iteration counter on the workspace, if registered. */
  currentIteration: number | null;
}

export interface ServerState {
  /** Whether cfcf server is running (pid file present + process alive). */
  running: boolean;
  pid: number | null;
  port: number | null;
}

export interface IterationHistory {
  /** Whether cfcf-docs/iteration-history.md exists. */
  exists: boolean;
  /** Heuristic count of iterations from the doc (number of "## Iteration N" headers). 0 if doc absent or empty. */
  iterationCount: number;
  /** Last 2000 chars of the history doc (for context). Null if absent. */
  tail: string | null;
}

export interface ProblemPackFile {
  filename: string;
  /** Whether the file exists on disk. */
  exists: boolean;
  /** Full content when small (≤ 4000 chars); first 4000 chars when larger; null when absent. */
  content: string | null;
  /** Total size in chars (when exists). */
  size: number;
}

export interface ProblemPackState {
  /** Full path to <repo>/problem-pack/. */
  packPath: string;
  /** Whether the directory exists. */
  exists: boolean;
  /** Per-file state for the canonical Problem Pack files. */
  files: ProblemPackFile[];
  /** Files PA found in problem-pack/context/ (if any). */
  contextFiles: string[];
}

export interface PaCacheState {
  /** Full path to <repo>/.cfcf-pa/. */
  cachePath: string;
  /** Whether the directory exists. */
  exists: boolean;
  /** Latest workspace-summary.md content if any. */
  workspaceSummary: string | null;
  /** Last sync metadata from .cfcf-pa/meta.json (parsed JSON). */
  meta: Record<string, unknown> | null;
  /** List of session-*.md files (filenames only, newest first). */
  sessionFiles: string[];
}

export interface AssessedState {
  /** Absolute, resolved repo path. */
  repoPath: string;
  /** Generated session_id for this PA invocation. */
  sessionId: string;
  /** ISO timestamp of when assessment ran. */
  assessedAt: string;
  git: GitState;
  workspace: WorkspaceRegistration;
  server: ServerState;
  iterations: IterationHistory;
  problemPack: ProblemPackState;
  paCache: PaCacheState;
}

// ── Cheap readers ────────────────────────────────────────────────────

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function readGitState(repoPath: string): Promise<GitState> {
  const isGitRepo = await isDirectory(join(repoPath, ".git"));
  if (!isGitRepo) return { isGitRepo: false, latestCommit: null };
  try {
    const r = spawnSync("git", ["log", "-1", "--oneline"], {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 2000,
    });
    if (r.status === 0 && r.stdout.trim()) {
      return { isGitRepo: true, latestCommit: r.stdout.trim() };
    }
    // Repo has no commits yet
    return { isGitRepo: true, latestCommit: null };
  } catch {
    return { isGitRepo: true, latestCommit: null };
  }
}

async function readWorkspaceRegistration(repoPath: string): Promise<WorkspaceRegistration> {
  try {
    const all = await listWorkspaces();
    const match = all.find((w) => resolve(w.repoPath) === resolve(repoPath));
    if (!match) {
      return { registered: false, workspaceId: null, name: null, clioProject: null, currentIteration: null };
    }
    return {
      registered: true,
      workspaceId: match.id,
      name: match.name,
      clioProject: match.clioProject ?? null,
      currentIteration: match.currentIteration,
    };
  } catch {
    return { registered: false, workspaceId: null, name: null, clioProject: null, currentIteration: null };
  }
}

async function readServerState(): Promise<ServerState> {
  try {
    const pid = await readPidFile();
    if (!pid) return { running: false, pid: null, port: null };
    const alive = isProcessRunning(pid.pid);
    if (!alive) return { running: false, pid: null, port: null };
    return { running: true, pid: pid.pid, port: pid.port };
  } catch {
    return { running: false, pid: null, port: null };
  }
}

async function readIterationHistory(repoPath: string): Promise<IterationHistory> {
  const path = join(repoPath, "cfcf-docs", "iteration-history.md");
  try {
    const content = await readFile(path, "utf-8");
    const matches = content.match(/^##\s+Iteration\s+\d+/gm);
    const tail = content.length > 2000 ? content.slice(-2000) : content;
    return {
      exists: true,
      iterationCount: matches?.length ?? 0,
      tail,
    };
  } catch {
    return { exists: false, iterationCount: 0, tail: null };
  }
}

const PROBLEM_PACK_FILES = ["problem.md", "success.md", "constraints.md", "hints.md", "style-guide.md"];
const FILE_PREVIEW_LIMIT = 4000;

async function readProblemPackState(repoPath: string): Promise<ProblemPackState> {
  const packPath = join(repoPath, "problem-pack");
  const dirExists = await isDirectory(packPath);
  if (!dirExists) {
    return {
      packPath,
      exists: false,
      files: PROBLEM_PACK_FILES.map((filename) => ({ filename, exists: false, content: null, size: 0 })),
      contextFiles: [],
    };
  }

  const files: ProblemPackFile[] = [];
  for (const filename of PROBLEM_PACK_FILES) {
    const path = join(packPath, filename);
    try {
      const raw = await readFile(path, "utf-8");
      files.push({
        filename,
        exists: true,
        content: raw.length > FILE_PREVIEW_LIMIT ? raw.slice(0, FILE_PREVIEW_LIMIT) : raw,
        size: raw.length,
      });
    } catch {
      files.push({ filename, exists: false, content: null, size: 0 });
    }
  }

  let contextFiles: string[] = [];
  const contextDir = join(packPath, "context");
  try {
    if (await isDirectory(contextDir)) {
      const entries = await readdir(contextDir);
      contextFiles = entries.filter((e) => e.endsWith(".md")).sort();
    }
  } catch { /* best-effort */ }

  return { packPath, exists: true, files, contextFiles };
}

async function readPaCacheState(repoPath: string): Promise<PaCacheState> {
  const cachePath = join(repoPath, ".cfcf-pa");
  const dirExists = await isDirectory(cachePath);
  if (!dirExists) {
    return { cachePath, exists: false, workspaceSummary: null, meta: null, sessionFiles: [] };
  }

  let workspaceSummary: string | null = null;
  try {
    workspaceSummary = await readFile(join(cachePath, "workspace-summary.md"), "utf-8");
  } catch { /* may not exist */ }

  let meta: Record<string, unknown> | null = null;
  try {
    const raw = await readFile(join(cachePath, "meta.json"), "utf-8");
    meta = JSON.parse(raw);
  } catch { /* may not exist */ }

  let sessionFiles: string[] = [];
  try {
    const entries = await readdir(cachePath);
    sessionFiles = entries.filter((e) => /^session-.*\.md$/.test(e)).sort().reverse(); // newest first by ID convention
  } catch { /* best-effort */ }

  return { cachePath, exists: true, workspaceSummary, meta, sessionFiles };
}

// ── session_id generator ─────────────────────────────────────────────

/**
 * Generate a `pa-<UTC ISO timestamp>-<random>` session ID. Format
 * chosen so it sorts chronologically AND embeds the timestamp for
 * human inspection (e.g. in webapp history, .cfcf-pa/session-*.md
 * filenames).
 *
 * Example: `pa-2026-04-28T15-49-10-abc123`
 */
export function generateSessionId(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[:.]/g, "-").replace("Z", "");
  const random = Math.random().toString(36).slice(2, 8);
  return `pa-${iso}-${random}`;
}

// ── Main entry point ─────────────────────────────────────────────────

/**
 * Run all state readers and compose into a single AssessedState
 * object. Every reader is best-effort; missing data → empty/null
 * fields rather than throws.
 */
export async function assessState(opts: {
  repoPath: string;
  sessionId?: string;
}): Promise<AssessedState> {
  const repoPath = isAbsolute(opts.repoPath) ? opts.repoPath : resolve(opts.repoPath);
  const sessionId = opts.sessionId ?? generateSessionId();
  const assessedAt = new Date().toISOString();

  const [git, workspace, server, iterations, problemPack, paCache] = await Promise.all([
    readGitState(repoPath),
    readWorkspaceRegistration(repoPath),
    readServerState(),
    readIterationHistory(repoPath),
    readProblemPackState(repoPath),
    readPaCacheState(repoPath),
  ]);

  return {
    repoPath,
    sessionId,
    assessedAt,
    git,
    workspace,
    server,
    iterations,
    problemPack,
    paCache,
  };
}

// ── Formatter for the system prompt ──────────────────────────────────

/**
 * Format the AssessedState into a Markdown section embedded in PA's
 * system prompt. Pure function. The agent reads this at session start
 * and uses it to inform its first response.
 */
export function formatAssessedState(s: AssessedState): string {
  const out: string[] = [];

  out.push("# State assessment (at session start)");
  out.push("");
  out.push(`**Session ID**: \`${s.sessionId}\`  `);
  out.push(`**Assessed**: ${s.assessedAt}  `);
  out.push(`**Repo path**: \`${s.repoPath}\``);
  out.push("");

  // Git
  out.push("## Git");
  if (!s.git.isGitRepo) {
    out.push("- **Not a git repo.** This is a prerequisite for cfcf. Offer to run `git init`.");
  } else if (!s.git.latestCommit) {
    out.push("- Git repo present, but no commits yet.");
  } else {
    out.push(`- Git repo present. Latest commit: \`${s.git.latestCommit}\``);
  }
  out.push("");

  // Workspace registration
  out.push("## cfcf workspace registration");
  if (!s.workspace.registered) {
    out.push("- **No cfcf workspace registered for this repo path.**");
    out.push("- This is your FIRST priority (after git init if needed). Until the workspace is");
    out.push("  registered we cannot save memory (`workspace_id` is the canonical scope key).");
    out.push("- Collect a workspace name from the user, then run:");
    out.push(`  \`cfcf workspace init --repo "${s.repoPath}" --name <name>\``);
    out.push("  Optional: `--project <clio-project>` to bind the workspace to a Clio Project.");
  } else {
    out.push(`- **Registered**.`);
    out.push(`  - Workspace ID: \`${s.workspace.workspaceId}\``);
    out.push(`  - Name: \`${s.workspace.name}\``);
    out.push(`  - Clio Project: ${s.workspace.clioProject ? `\`${s.workspace.clioProject}\`` : "_(none — auto-routes to 'default')_"}`);
    out.push(`  - Current iteration counter: ${s.workspace.currentIteration ?? 0}`);
  }
  out.push("");

  // Server
  out.push("## cfcf server");
  if (s.server.running) {
    out.push(`- Running (pid ${s.server.pid}, port ${s.server.port}).`);
  } else {
    out.push("- Not running. If we need it later, run `cfcf server start`.");
  }
  out.push("");

  // Iteration history
  out.push("## Iteration history");
  if (!s.iterations.exists) {
    out.push("- No iteration history yet. The loop has not run on this workspace.");
  } else {
    out.push(`- ${s.iterations.iterationCount} iteration${s.iterations.iterationCount === 1 ? "" : "s"} on record.`);
    if (s.iterations.tail) {
      out.push("");
      out.push("### Last 2000 chars of `cfcf-docs/iteration-history.md`");
      out.push("");
      out.push("```markdown");
      out.push(s.iterations.tail);
      out.push("```");
    }
  }
  out.push("");

  // Problem Pack
  out.push("## Problem Pack (`<repo>/problem-pack/`)");
  if (!s.problemPack.exists) {
    out.push("- Directory doesn't exist yet. `cfcf workspace init` will scaffold it.");
  } else {
    for (const f of s.problemPack.files) {
      if (!f.exists) {
        out.push(`- \`${f.filename}\` — _(missing)_`);
      } else if (f.size === 0) {
        out.push(`- \`${f.filename}\` — _(empty)_`);
      } else {
        out.push(`- \`${f.filename}\` — ${f.size} chars`);
      }
    }
    if (s.problemPack.contextFiles.length > 0) {
      out.push(`- \`context/\` — ${s.problemPack.contextFiles.length} markdown file${s.problemPack.contextFiles.length === 1 ? "" : "s"}: ${s.problemPack.contextFiles.map((c) => `\`${c}\``).join(", ")}`);
    }
    out.push("");
    out.push("### Current contents (preview)");
    out.push("");
    for (const f of s.problemPack.files) {
      if (!f.exists || !f.content) continue;
      out.push(`#### \`${f.filename}\``);
      out.push("");
      out.push("```markdown");
      out.push(f.content);
      out.push("```");
      out.push("");
    }
  }
  out.push("");

  // PA cache
  out.push("## PA local cache (`<repo>/.cfcf-pa/`)");
  if (!s.paCache.exists) {
    out.push("- Directory doesn't exist yet. cfcf will create it on launch.");
  } else {
    out.push(`- Path: \`${s.paCache.cachePath}\``);
    if (s.paCache.meta) {
      out.push("- `meta.json` present:");
      out.push("");
      out.push("  ```json");
      out.push("  " + JSON.stringify(s.paCache.meta, null, 2).replace(/\n/g, "\n  "));
      out.push("  ```");
    } else {
      out.push("- `meta.json` not present (no prior sync).");
    }
    if (s.paCache.workspaceSummary) {
      out.push("");
      out.push("- `workspace-summary.md` present:");
      out.push("");
      out.push("  ```markdown");
      out.push("  " + s.paCache.workspaceSummary.replace(/\n/g, "\n  "));
      out.push("  ```");
    } else {
      out.push("- `workspace-summary.md` not present.");
    }
    if (s.paCache.sessionFiles.length > 0) {
      out.push(`- ${s.paCache.sessionFiles.length} session file${s.paCache.sessionFiles.length === 1 ? "" : "s"}: ${s.paCache.sessionFiles.slice(0, 5).map((f) => `\`${f}\``).join(", ")}${s.paCache.sessionFiles.length > 5 ? ", …" : ""}`);
    } else {
      out.push("- No prior session files.");
    }
  }

  return out.join("\n");
}
