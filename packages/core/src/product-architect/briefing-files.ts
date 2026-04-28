/**
 * Product-Architect briefing-file writers.
 *
 * Pattern B injection: PA's role briefing lives in
 * `<repo>/cfcf-docs/AGENTS.md` (codex auto-load) and
 * `<repo>/cfcf-docs/CLAUDE.md` (claude-code auto-load). Both agent
 * CLIs walk parent directories from cwd to find their respective
 * file -- the launcher spawns the agent with `--cd <repo>/cfcf-docs/`
 * so these are the deepest-scope files (PA's directives effectively
 * override anything inherited from parent dirs, like the iteration-
 * time AGENTS.md the dev role uses at repo root).
 *
 * Sentinel-marked: cf² owns the content INSIDE the
 * `<!-- cfcf:begin --> ... <!-- cfcf:end -->` markers; user content
 * outside the markers is preserved byte-for-byte across writes. Same
 * convention as the iteration-time CLAUDE.md/AGENTS.md merge in
 * `context-assembler.ts`.
 *
 * Plan item 5.14. See `docs/research/product-architect.md`
 * §"Pattern B: durable AGENTS.md/CLAUDE.md".
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mergeInstructionFile } from "../context-assembler.js";

/**
 * Files PA owns under `<repo>/cfcf-docs/`. AGENTS.md is what codex
 * auto-loads; CLAUDE.md is what claude-code auto-loads. We write both
 * regardless of which adapter is currently configured -- a user who
 * switches adapters mid-project shouldn't need to re-run anything,
 * and the file that the inactive adapter doesn't read is harmless.
 */
export const PA_BRIEFING_FILENAMES = ["AGENTS.md", "CLAUDE.md"] as const;

/**
 * Header injected at the top of the cf²-owned block so an unsuspecting
 * reader (the agent itself, the user inspecting the file) understands
 * what's going on + why it changes.
 */
const BRIEFING_HEADER = `# cf² Product Architect (PA) briefing

This file is auto-managed by cf² when you run \`cfcf help architect\`.
The block between the \`cfcf:begin\` / \`cfcf:end\` markers is owned
by cf² and is rewritten on every PA launch. **Do not edit inside
the markers** -- your edits will be overwritten. Anything OUTSIDE the
markers is yours and is preserved byte-for-byte.`;

export interface BriefingPayload {
  /**
   * The full system prompt assembled by `assembleProductArchitectPrompt`.
   * This is what the agent CLI reads as its system prompt at session
   * start (via the auto-load convention -- claude-code reads CLAUDE.md,
   * codex reads AGENTS.md from the deepest matching dir).
   */
  systemPrompt: string;
  /**
   * Version stamp recorded in the cf²-owned block. When the writer
   * notices a stale version, it rewrites the block (the merge logic
   * already replaces the inside of the markers unconditionally, so
   * the version stamp is mostly for human-readable diagnostics).
   */
  versionStamp: string;
}

/**
 * Build the cf²-owned body that goes between the sentinel markers.
 * Pure function: takes the assembled prompt + a version stamp, returns
 * the bytes to wrap in the sentinel block.
 */
export function buildBriefingBody(payload: BriefingPayload): string {
  return [
    BRIEFING_HEADER,
    "",
    `<!-- cfcf-pa-version: ${payload.versionStamp} -->`,
    "",
    payload.systemPrompt,
  ].join("\n");
}

/**
 * Write `<repo>/cfcf-docs/AGENTS.md` + `<repo>/cfcf-docs/CLAUDE.md`,
 * preserving any user content outside the cf² sentinel block. Creates
 * `<repo>/cfcf-docs/` if it doesn't exist.
 *
 * Returns the list of paths actually written.
 */
export async function writeBriefingFiles(
  cfcfDocsPath: string,
  payload: BriefingPayload,
): Promise<string[]> {
  await mkdir(cfcfDocsPath, { recursive: true });
  const body = buildBriefingBody(payload);

  const written: string[] = [];
  for (const filename of PA_BRIEFING_FILENAMES) {
    const dest = join(cfcfDocsPath, filename);
    let existing: string | null = null;
    try {
      existing = await readFile(dest, "utf-8");
    } catch {
      existing = null;
    }
    const next = mergeInstructionFile(existing, body);
    if (next !== existing) {
      await writeFile(dest, next, "utf-8");
    }
    written.push(dest);
  }
  return written;
}
