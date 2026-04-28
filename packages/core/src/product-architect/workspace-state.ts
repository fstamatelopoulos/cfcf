/**
 * Product-Architect workspace-state reader.
 *
 * Reads the four Problem Pack files (problem.md / success.md /
 * process.md / constraints.md) from `<repo>/cfcf-docs/` so the PA's
 * system prompt can include their CURRENT contents at session start.
 * Gracefully handles missing files -- PA's whole job is authoring +
 * iterating these files, so on a fresh project most or all of them
 * won't exist yet.
 *
 * Read-only. The agent itself writes to these files (with permission)
 * during the session via the agent CLI's bash/edit tools. PA's
 * launcher only reads them to seed the prompt.
 *
 * Plan item 5.14. See `docs/research/product-architect.md` §"What PA
 * writes" + §"Phase 2: Spec iteration".
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ProblemPackState {
  /** `<repo>/cfcf-docs/` path that was inspected. */
  cfcfDocsPath: string;
  /** Whether `<repo>/cfcf-docs/` exists. False on a fresh project. */
  exists: boolean;
  /** problem.md contents, or null if absent. */
  problem: string | null;
  /** success.md contents, or null if absent. */
  success: string | null;
  /** process.md contents, or null if absent. */
  process: string | null;
  /** constraints.md contents, or null if absent. */
  constraints: string | null;
  /** decision-log.md contents, or null if absent. */
  decisionLog: string | null;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Snapshot the current state of the four Problem Pack files (plus the
 * decision log) under `<repo>/cfcf-docs/`. All four files are
 * INDIVIDUALLY optional so the reader works on every project state
 * from "fresh repo, nothing exists" to "fully-iterated Problem Pack".
 *
 * `exists` reports whether the directory itself is present; helpful
 * for the launcher to decide whether to suggest `cfcf workspace init`
 * before launching PA.
 */
export async function readProblemPackState(repoPath: string): Promise<ProblemPackState> {
  const cfcfDocsPath = join(repoPath, "cfcf-docs");

  // Probe directory existence by trying to read one of the files. If
  // the directory doesn't exist, all reads will fail -- which is the
  // correct fall-through for `exists: false`.
  let exists = false;
  try {
    const { stat } = await import("node:fs/promises");
    const s = await stat(cfcfDocsPath);
    exists = s.isDirectory();
  } catch {
    exists = false;
  }

  if (!exists) {
    return {
      cfcfDocsPath,
      exists: false,
      problem: null,
      success: null,
      process: null,
      constraints: null,
      decisionLog: null,
    };
  }

  const [problem, success, process_, constraints, decisionLog] = await Promise.all([
    readIfPresent(join(cfcfDocsPath, "problem.md")),
    readIfPresent(join(cfcfDocsPath, "success.md")),
    readIfPresent(join(cfcfDocsPath, "process.md")),
    readIfPresent(join(cfcfDocsPath, "constraints.md")),
    readIfPresent(join(cfcfDocsPath, "decision-log.md")),
  ]);

  return {
    cfcfDocsPath,
    exists: true,
    problem,
    success,
    process: process_,
    constraints,
    decisionLog,
  };
}

/**
 * Format the workspace state into a Markdown section ready to embed in
 * the PA system prompt. Empty files render as `(not yet created --
 * this is one of your first tasks)` so the agent knows it's expected
 * to author them.
 */
export function formatProblemPackState(state: ProblemPackState): string {
  if (!state.exists) {
    return [
      "# Workspace state",
      "",
      `\`${state.cfcfDocsPath}\` does NOT exist. Either:`,
      "  - Ask the user to run \`cfcf workspace init\` first, OR",
      "  - With user approval, run \`cfcf workspace init\` yourself, OR",
      "  - If the user wants to bootstrap from a brand-new repo, ask them",
      "    to confirm the repo path + then create the workspace.",
      "",
      "Once \`cfcf-docs/\` exists, the four Problem Pack files (problem.md,",
      "success.md, process.md, constraints.md) will be empty -- that's",
      "where most of your work happens.",
    ].join("\n");
  }

  const fmt = (label: string, body: string | null, hint: string): string => {
    if (body === null) {
      return `## ${label}\n\n_(not yet created -- ${hint})_`;
    }
    if (body.trim() === "") {
      return `## ${label}\n\n_(file exists but is empty -- ${hint})_`;
    }
    return `## ${label}\n\n${body}`;
  };

  const sections: string[] = [
    "# Workspace state",
    "",
    `Snapshot of \`${state.cfcfDocsPath}\` at session start. The user may`,
    "have edited some of these files between sessions; cross-reference",
    "with live state when relevant.",
    "",
    fmt("`problem.md`", state.problem, "describes what the user is trying to build + why"),
    fmt("`success.md`", state.success, "describes how we'll know we're done -- test cases + acceptance criteria"),
    fmt("`process.md`", state.process, "non-negotiables about HOW the work happens (test framework, language, conventions)"),
    fmt("`constraints.md`", state.constraints, "what NOT to do (forbidden libraries, architectures, scopes)"),
  ];

  if (state.decisionLog !== null && state.decisionLog.trim() !== "") {
    sections.push(`## \`decision-log.md\` (optional)\n\n${state.decisionLog}`);
  }

  return sections.join("\n\n");
}
