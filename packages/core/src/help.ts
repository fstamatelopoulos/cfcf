/**
 * Help-content surface.
 *
 * Re-exports the generated help-content bundle (produced by
 * `scripts/embed-help-content.ts`) under a stable public API. Both the
 * CLI's `cfcf help` command and the server's `/api/help/*` routes
 * import from here, so neither has to reach into the .generated file
 * directly. If we ever swap the storage strategy (e.g. lazy-loaded
 * tarball assets in a future release), only this file changes; the
 * callers stay untouched.
 *
 * The generated file is gitignored; it must be produced before
 * `bun run typecheck` succeeds. The `bun run build` script wires this
 * in automatically. For development on a fresh clone:
 *
 *   bun run scripts/embed-help-content.ts
 *
 * Plan item 5.8 PR2/PR3.
 */

export type { HelpTopic } from "./help-content.generated.js";
export {
  HELP_TOPICS,
  getHelpContent,
  resolveHelpTopic,
  listHelpTopics,
} from "./help-content.generated.js";
