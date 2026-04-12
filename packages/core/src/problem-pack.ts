/**
 * Problem Pack parser for cfcf.
 *
 * A Problem Pack is a directory of Markdown files that define the problem.
 * This module reads and validates the contents of a Problem Pack.
 */

import { join } from "path";
import { readFile, readdir, access } from "fs/promises";

export interface ProblemPack {
  /** Problem/goal definition */
  problem: string;
  /** Success criteria and test scenarios */
  success: string;
  /** Guardrails, limitations, boundaries (optional) */
  constraints?: string;
  /** Technical hints, preferred approaches (optional) */
  hints?: string;
  /** Code style guidelines (optional) */
  styleGuide?: string;
  /** Additional context files (architecture docs, API specs, etc.) */
  context: { filename: string; content: string }[];
  /** The directory the pack was loaded from */
  sourcePath: string;
}

/**
 * Read and parse a Problem Pack from a directory.
 *
 * Required files: problem.md, success.md
 * Optional files: constraints.md, hints.md, style-guide.md, context/*.md
 */
export async function readProblemPack(packPath: string): Promise<ProblemPack> {
  // Validate directory exists
  try {
    await access(packPath);
  } catch {
    throw new Error(`Problem Pack directory not found: ${packPath}`);
  }

  // Read required files
  const problem = await readRequiredFile(packPath, "problem.md");
  const success = await readRequiredFile(packPath, "success.md");

  // Read optional files
  const constraints = await readOptionalFile(packPath, "constraints.md");
  const hints = await readOptionalFile(packPath, "hints.md");
  const styleGuide = await readOptionalFile(packPath, "style-guide.md");

  // Read context/ directory
  const context = await readContextDir(join(packPath, "context"));

  return {
    problem,
    success,
    constraints,
    hints,
    styleGuide,
    context,
    sourcePath: packPath,
  };
}

/**
 * Validate that a Problem Pack has the minimum required files.
 */
export async function validateProblemPack(
  packPath: string,
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  try {
    await access(packPath);
  } catch {
    return { valid: false, errors: [`Directory not found: ${packPath}`] };
  }

  try {
    await access(join(packPath, "problem.md"));
  } catch {
    errors.push("Missing required file: problem.md");
  }

  try {
    await access(join(packPath, "success.md"));
  } catch {
    errors.push("Missing required file: success.md");
  }

  return { valid: errors.length === 0, errors };
}

async function readRequiredFile(dir: string, filename: string): Promise<string> {
  try {
    return await readFile(join(dir, filename), "utf-8");
  } catch {
    throw new Error(`Missing required file in Problem Pack: ${filename}`);
  }
}

async function readOptionalFile(dir: string, filename: string): Promise<string | undefined> {
  try {
    return await readFile(join(dir, filename), "utf-8");
  } catch {
    return undefined;
  }
}

async function readContextDir(
  contextPath: string,
): Promise<{ filename: string; content: string }[]> {
  try {
    const entries = await readdir(contextPath);
    const files: { filename: string; content: string }[] = [];
    for (const entry of entries.sort()) {
      if (entry.endsWith(".md")) {
        const content = await readFile(join(contextPath, entry), "utf-8");
        files.push({ filename: entry, content });
      }
    }
    return files;
  } catch {
    return [];
  }
}
