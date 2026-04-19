/// <reference path="./templates.d.ts" />
/**
 * Template resolver.
 *
 * cfcf ships a set of template files under `packages/core/src/templates/`.
 * In development and in compiled binaries, the contents are embedded into
 * the build via `import ... with { type: "text" }` -- no runtime filesystem
 * lookup is required, which is what makes `bun build --compile` self-
 * contained (item 5.3/5.4).
 *
 * On top of the embedded defaults, callers can override any template by
 * placing a file of the same name in one of:
 *
 *   1. `<repoPath>/cfcf-templates/<name>`     (project-local override)
 *   2. `<CFCF_CONFIG_DIR>/templates/<name>`   (user-global override)
 *
 * Resolution order is project -> user-global -> embedded. This is what
 * makes the system flexible without requiring the user to edit the binary.
 */

import { join } from "path";
import { readFile, writeFile, mkdir, access } from "fs/promises";
import { getConfigDir } from "./constants.js";

// --- Embedded templates ---
// Each import reads the file contents at build time and inlines them as a
// string constant. Bun supports the `with { type: "text" }` import attribute
// in both dev mode and `bun build --compile`.

import archInstructions from "./templates/cfcf-architect-instructions.md" with { type: "text" };
import archSignals from "./templates/cfcf-architect-signals.json" with { type: "text" };
import judgeInstructions from "./templates/cfcf-judge-instructions.md" with { type: "text" };
import judgeSignals from "./templates/cfcf-judge-signals.json" with { type: "text" };
import docInstructions from "./templates/cfcf-documenter-instructions.md" with { type: "text" };
import iterationSignals from "./templates/cfcf-iteration-signals.json" with { type: "text" };
import iterationHandoff from "./templates/iteration-handoff.md" with { type: "text" };
import iterationHistory from "./templates/iteration-history.md" with { type: "text" };
import judgeAssessment from "./templates/judge-assessment.md" with { type: "text" };
import userFeedback from "./templates/user-feedback.md" with { type: "text" };
import decisionLog from "./templates/decision-log.md" with { type: "text" };
import planTemplate from "./templates/plan.md" with { type: "text" };
import processTemplate from "./templates/process.md" with { type: "text" };
import iterationLog from "./templates/iteration-log.md" with { type: "text" };
import reflectionInstructions from "./templates/cfcf-reflection-instructions.md" with { type: "text" };
import reflectionSignals from "./templates/cfcf-reflection-signals.json" with { type: "text" };

// With `resolveJsonModule: true` in tsconfig, TS types the JSON imports
// as their parsed object shape even when we pass `with { type: "text" }`
// (which returns a string at runtime). Cast through `unknown` to treat
// them uniformly as strings.
const asString = (v: unknown): string => v as string;

const EMBEDDED: Record<string, string> = {
  "cfcf-architect-instructions.md": archInstructions,
  "cfcf-architect-signals.json": asString(archSignals),
  "cfcf-judge-instructions.md": judgeInstructions,
  "cfcf-judge-signals.json": asString(judgeSignals),
  "cfcf-documenter-instructions.md": docInstructions,
  "cfcf-iteration-signals.json": asString(iterationSignals),
  "iteration-handoff.md": iterationHandoff,
  "iteration-history.md": iterationHistory,
  "judge-assessment.md": judgeAssessment,
  "user-feedback.md": userFeedback,
  "decision-log.md": decisionLog,
  "plan.md": planTemplate,
  "process.md": processTemplate,
  "iteration-log.md": iterationLog,
  "cfcf-reflection-instructions.md": reflectionInstructions,
  "cfcf-reflection-signals.json": asString(reflectionSignals),
};

// --- Public API ---

export interface TemplateResolutionOptions {
  /** If provided, enables project-local override lookup under `<repoPath>/cfcf-templates/<name>`. */
  repoPath?: string;
}

/**
 * Resolve a template by name. Returns the first match from:
 *   1. `<repoPath>/cfcf-templates/<name>`      (if repoPath supplied)
 *   2. `<CFCF_CONFIG_DIR>/templates/<name>`
 *   3. embedded default
 *
 * Throws only if `name` is unknown (not in the embedded registry).
 */
export async function getTemplate(
  name: string,
  opts: TemplateResolutionOptions = {},
): Promise<string> {
  if (!(name in EMBEDDED)) {
    throw new Error(`Unknown template: ${name}. Known templates: ${Object.keys(EMBEDDED).join(", ")}`);
  }

  // 1. Project-local override
  if (opts.repoPath) {
    const local = join(opts.repoPath, "cfcf-templates", name);
    const hit = await tryRead(local);
    if (hit !== null) return hit;
  }

  // 2. User-global override
  const userOverride = join(getConfigDir(), "templates", name);
  const hit = await tryRead(userOverride);
  if (hit !== null) return hit;

  // 3. Embedded default
  return EMBEDDED[name];
}

/**
 * Write a template to `<destDir>/<name>`, resolving via the same lookup
 * order as `getTemplate`.
 */
export async function writeTemplate(
  destDir: string,
  name: string,
  opts: TemplateResolutionOptions = {},
): Promise<void> {
  const content = await getTemplate(name, opts);
  await mkdir(destDir, { recursive: true });
  await writeFile(join(destDir, name), content, "utf-8");
}

/**
 * Write a template only if the destination file doesn't already exist.
 * Matches the prior `copyTemplateIfMissing` semantics.
 */
export async function writeTemplateIfMissing(
  destDir: string,
  name: string,
  opts: TemplateResolutionOptions = {},
): Promise<void> {
  const dest = join(destDir, name);
  try {
    await access(dest);
    return; // exists
  } catch {
    await writeTemplate(destDir, name, opts);
  }
}

/**
 * List all known template names (embedded registry). Useful for tests and
 * introspection.
 */
export function listTemplates(): string[] {
  return Object.keys(EMBEDDED);
}

// --- Helpers ---

async function tryRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}
