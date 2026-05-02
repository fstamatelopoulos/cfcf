/**
 * Resume command: continue a paused iteration loop with a structured
 * action + optional free-text feedback (item 6.25).
 *
 * The five `--action` values match the harness routing:
 *   continue            → next iteration; --feedback is dev prompt context
 *   finish_loop         → run documenter (if autoDocumenter=true) then end;
 *                         --feedback is documenter prompt context
 *   stop_loop_now       → terminate immediately; --feedback is audit note
 *                         appended to history.json + iteration-history.md
 *   refine_plan         → architect re-review (sync) then continue;
 *                         --feedback is architect prompt context
 *   consult_reflection  → reflection consults user feedback + state and
 *                         decides what the harness should do next
 *
 * Default `--action continue` preserves pre-6.25 behaviour for any
 * scripts/automation that don't pass the flag.
 */

import type { Command, Option } from "commander";
import { isServerReachable, post } from "../client.js";

const RESUME_ACTIONS = [
  "continue",
  "finish_loop",
  "stop_loop_now",
  "refine_plan",
  "consult_reflection",
] as const;

type ResumeAction = (typeof RESUME_ACTIONS)[number];

export function registerResumeCommand(program: Command): void {
  program
    .command("resume")
    .description("Resume a paused iteration loop")
    .requiredOption("--workspace <name>", "Workspace name or ID")
    .option("--feedback <text>", "Optional context for the next agent (or audit note for stop_loop_now)")
    .addOption(buildActionOption(program))
    .action(async (opts: { workspace: string; feedback?: string; action: ResumeAction }) => {
      if (!(await isServerReachable())) {
        console.error("cfcf server is not running. Start it with: cfcf server start");
        process.exit(1);
      }

      const body: Record<string, unknown> = {
        action: opts.action,
      };
      if (opts.feedback) {
        body.feedback = opts.feedback;
      }

      const res = await post<{ workspaceId: string; phase: string; currentIteration: number; message: string }>(
        `/api/workspaces/${encodeURIComponent(opts.workspace)}/loop/resume`,
        body,
      );

      if (!res.ok) {
        console.error(`Failed to resume: ${res.error}`);
        process.exit(1);
      }

      const data = res.data!;
      console.log(`Loop resumed for workspace (iteration ${data.currentIteration}, action: ${opts.action})`);
      if (opts.feedback) {
        console.log(`Feedback: "${opts.feedback}"`);
      }
      console.log();
      console.log("Monitor progress with: cfcf status --workspace " + opts.workspace);
    });
}

/**
 * Build the `--action` Option with proper `choices()` validation and a
 * "continue" default. Centralised so the help text + validation stay in
 * sync with the {@link RESUME_ACTIONS} list.
 */
function buildActionOption(program: Command): Option {
  // commander's createOption is on the program instance; fetch it lazily
  // so we don't have to import the Option class explicitly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opt = (program as any).createOption(
    "--action <name>",
    "Resume action: continue | finish_loop | stop_loop_now | refine_plan | consult_reflection",
  );
  opt.choices(RESUME_ACTIONS as readonly string[]);
  opt.default("continue");
  return opt;
}
