/**
 * Regression test for the parent-vs-child option-shadowing bug fixed
 * 2026-05-08. Surfaced when a Product Architect session reported that
 * `cfcf clio docs ingest --project cf-system-pa-memory` ingested into
 * `cf-system-default` instead, AND that `cfcf clio docs edit <id>
 * --project X` silently no-op-ed the project move.
 *
 * Root cause: commander.js attributes a long-named option to the
 * **parent** command when both the parent and a child define the same
 * long name. The parent `docsCmd` had `-p, --project` defined for its
 * default-list action, AND the child subcommands `ingest` / `edit`
 * also had `--project`. When the user ran
 * `cfcf clio docs edit <id> --project X`, commander stored `X` on the
 * parent's opts, leaving the child's action handler with
 * `opts.project === undefined`.
 *
 * Fix: removed the parent-level `--project` (and the other
 * default-list options) from `docsCmd`. Users invoke list explicitly
 * via `cfcf clio docs list ...` instead of relying on the default
 * action. See the 2026-05-08 entry in `docs/decisions-log.md`.
 *
 * This test pins the option-parsing behaviour we depend on so any
 * future re-introduction of a parent-level `--project` (or similar
 * shadow-prone option) breaks the suite.
 */

import { describe, it, expect } from "bun:test";
import { Command } from "commander";
import { registerClioCommands } from "./clio.js";

/**
 * Build the cfcf CLI tree (clio commands only) and parse the given argv,
 * intercepting the `clio docs edit` and `clio docs ingest` action
 * handlers so we can capture the parsed `opts` they would have received
 * at runtime. Returns the captured opts (or null if the action wasn't
 * reached, e.g. because commander rejected the args).
 *
 * `argv` is in commander's expected shape: `["node", "cfcf", ...]`.
 */
async function captureSubcommandOpts(
  subcommandPath: ("docs" | "ingest" | "edit")[],
  argv: string[],
): Promise<Record<string, unknown> | null> {
  const program = new Command();
  registerClioCommands(program);

  // Walk the tree to find the target subcommand.
  let cmd: Command = program;
  for (const name of ["clio", ...subcommandPath]) {
    const next = cmd.commands.find((c) => c.name() === name);
    if (!next) throw new Error(`subcommand path not found: ${["clio", ...subcommandPath].join(" / ")}`);
    cmd = next;
  }

  // Replace the action handler with a capturing one. Note that the
  // signature varies — `edit` is `(id, opts)`, `ingest` is `(file, opts)`.
  let captured: Record<string, unknown> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cmd.action((..._args: any[]) => {
    // commander's action signature is `(arg1, arg2, ..., command)` where
    // `command` is the last element. The penultimate-or-last is opts.
    // Easier: read opts() off the command.
    captured = cmd.opts();
  });

  // commander treats unknown options strictly by default; we want
  // strictness so the test fails noisily if argv is malformed.
  cmd.exitOverride();

  try {
    await program.parseAsync(argv);
  } catch (err) {
    // commander throws CommanderError on parse problems (unknown opt,
    // missing required arg, etc.). Surface for diagnosis.
    throw new Error(`commander.parseAsync failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return captured;
}

describe("clio CLI option-parsing (parent/child shadow regression — 2026-05-08)", () => {
  it("`cfcf clio docs edit <id> --project X` puts X on edit's opts.project, not on a parent", async () => {
    const opts = await captureSubcommandOpts(
      ["docs", "edit"],
      ["node", "cfcf", "clio", "docs", "edit", "doc-id-fake", "--project", "cf-system-pa-memory"],
    );
    expect(opts).not.toBeNull();
    // The fix's invariant: opts.project on the edit subcommand IS the
    // value the user passed. Pre-fix this was undefined because the
    // parent's --project absorbed the value.
    expect(opts!.project).toBe("cf-system-pa-memory");
  });

  it("`cfcf clio docs ingest <file> --project X` puts X on ingest's opts.project, not on a parent", async () => {
    const opts = await captureSubcommandOpts(
      ["docs", "ingest"],
      [
        "node", "cfcf", "clio", "docs", "ingest",
        "/tmp/cfcf-fake.md",
        "--project", "cf-system-pa-memory",
      ],
    );
    expect(opts).not.toBeNull();
    // Pre-fix: opts.project would have been the ingest's child default
    // ("cf-system-default") because the parent absorbed the user's
    // explicit value. Post-fix: the user's value reaches the action.
    expect(opts!.project).toBe("cf-system-pa-memory");
  });

  it("`cfcf clio docs ingest <file>` (no --project) falls back to ingest's default", async () => {
    // Sanity check: the child's default still kicks in when the user
    // doesn't pass --project. Guards against an over-aggressive fix
    // that would have removed the default along with the parent option.
    const opts = await captureSubcommandOpts(
      ["docs", "ingest"],
      ["node", "cfcf", "clio", "docs", "ingest", "/tmp/cfcf-fake.md"],
    );
    expect(opts).not.toBeNull();
    expect(opts!.project).toBe("cf-system-default");
  });

  it("`cfcf clio docs edit <id>` (no --project) leaves opts.project undefined", async () => {
    // Edit's --project has no default (unlike ingest). Sanity-check
    // that not passing it leaves opts.project undefined so the action
    // handler's "Nothing to edit" guard works as intended.
    const opts = await captureSubcommandOpts(
      ["docs", "edit"],
      ["node", "cfcf", "clio", "docs", "edit", "doc-id-fake", "--title", "renamed"],
    );
    expect(opts).not.toBeNull();
    expect(opts!.project).toBeUndefined();
    expect(opts!.title).toBe("renamed");
  });
});
