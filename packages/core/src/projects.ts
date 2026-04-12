/**
 * Project management for cfcf.
 *
 * Projects are stored under ~/.cfcf/projects/<project-id>/config.json.
 * Each project links to a local git repo and has its own agent/iteration config.
 */

import { join } from "path";
import { mkdir, readFile, writeFile, readdir, access, rm } from "fs/promises";
import { getConfigDir, DEFAULT_MAX_ITERATIONS, DEFAULT_PAUSE_EVERY } from "./constants.js";
import { readConfig } from "./config.js";
import type { ProjectConfig, CfcfGlobalConfig } from "./types.js";
import { randomBytes } from "crypto";

/**
 * Get the projects root directory.
 */
export function getProjectsDir(): string {
  return join(getConfigDir(), "projects");
}

/**
 * Get the directory for a specific project.
 */
export function getProjectDir(projectId: string): string {
  return join(getProjectsDir(), projectId);
}

/**
 * Generate a short unique project ID from the name.
 */
function generateProjectId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  const suffix = randomBytes(3).toString("hex");
  return `${slug}-${suffix}`;
}

/**
 * Create a new project.
 */
export async function createProject(opts: {
  name: string;
  repoPath: string;
  repoUrl?: string;
  devAgent?: { adapter: string; model?: string };
  judgeAgent?: { adapter: string; model?: string };
  maxIterations?: number;
  pauseEvery?: number;
}): Promise<ProjectConfig> {
  // Load global config for defaults
  const globalConfig = await readConfig();

  const id = generateProjectId(opts.name);
  const config: ProjectConfig = {
    id,
    name: opts.name,
    repoPath: opts.repoPath,
    repoUrl: opts.repoUrl,
    devAgent: opts.devAgent ?? globalConfig?.devAgent ?? { adapter: "claude-code" },
    judgeAgent: opts.judgeAgent ?? globalConfig?.judgeAgent ?? { adapter: "codex" },
    maxIterations: opts.maxIterations ?? globalConfig?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    pauseEvery: opts.pauseEvery ?? globalConfig?.pauseEvery ?? DEFAULT_PAUSE_EVERY,
    onStalled: "alert",
    mergeStrategy: "auto",
    processTemplate: "default",
  };

  const dir = getProjectDir(id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf-8");

  return config;
}

/**
 * Get a project by ID.
 */
export async function getProject(projectId: string): Promise<ProjectConfig | null> {
  try {
    const raw = await readFile(join(getProjectDir(projectId), "config.json"), "utf-8");
    return JSON.parse(raw) as ProjectConfig;
  } catch {
    return null;
  }
}

/**
 * Find a project by name (partial match, case-insensitive).
 * Returns the first match.
 */
export async function findProjectByName(name: string): Promise<ProjectConfig | null> {
  const projects = await listProjects();
  const lower = name.toLowerCase();
  return projects.find((p) => p.name.toLowerCase() === lower) ??
    projects.find((p) => p.id.toLowerCase().startsWith(lower)) ??
    null;
}

/**
 * List all projects.
 */
export async function listProjects(): Promise<ProjectConfig[]> {
  const dir = getProjectsDir();
  try {
    const entries = await readdir(dir);
    const projects: ProjectConfig[] = [];
    for (const entry of entries) {
      const config = await getProject(entry);
      if (config) projects.push(config);
    }
    return projects.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Update a project config.
 */
export async function updateProject(
  projectId: string,
  updates: Partial<Omit<ProjectConfig, "id">>,
): Promise<ProjectConfig | null> {
  const existing = await getProject(projectId);
  if (!existing) return null;

  const updated = { ...existing, ...updates };
  await writeFile(
    join(getProjectDir(projectId), "config.json"),
    JSON.stringify(updated, null, 2) + "\n",
    "utf-8",
  );
  return updated;
}

/**
 * Delete a project.
 */
export async function deleteProject(projectId: string): Promise<boolean> {
  try {
    await rm(getProjectDir(projectId), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify a project's repo path exists and is a git repo.
 */
export async function validateProjectRepo(repoPath: string): Promise<{ valid: boolean; error?: string }> {
  try {
    await access(repoPath);
  } catch {
    return { valid: false, error: `Directory not found: ${repoPath}` };
  }

  try {
    await access(join(repoPath, ".git"));
    return { valid: true };
  } catch {
    return { valid: false, error: `Not a git repository: ${repoPath}` };
  }
}
