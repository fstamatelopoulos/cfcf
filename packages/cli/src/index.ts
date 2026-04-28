#!/usr/bin/env bun
/**
 * cfcf CLI -- the primary user interface for cf².
 *
 * Communicates with the cfcf server via HTTP.
 * On first run (no config), starts the interactive setup flow.
 */

// Bun-runtime guard. cfcf uses bun:sqlite, Bun.spawn, Bun.file, Bun.serve
// directly throughout the codebase. The shebang above selects bun, but a
// user could also invoke us under Node (e.g. `node ./bin/cfcf.js`) and
// hit a confusing failure deep in module loading. Surface the constraint
// here with a clear message.
//
// See `docs/research/installer-design.md` §1 + the 2026-04-26 entry in
// `docs/decisions-log.md` for why Bun is a runtime requirement.
if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
  process.stderr.write(
    "[cfcf] error: cfcf requires the Bun runtime (≥ 1.3) but is being executed by something else.\n" +
    "[cfcf] Install Bun: curl -fsSL https://bun.sh/install | bash\n" +
    "[cfcf] Then re-run: bun install -g cfcf  (or bun install -g <tarball-URL>)\n",
  );
  process.exit(1);
}

import { Command } from "commander";
import { VERSION } from "@cfcf/core";
import { registerServerCommands } from "./commands/server.js";
import { registerInitCommand } from "./commands/init.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerWorkspaceCommands } from "./commands/workspace.js";
import { registerConfigCommands } from "./commands/config.js";
import { registerRunCommand } from "./commands/run.js";
import { registerResumeCommand } from "./commands/resume.js";
import { registerStopCommand } from "./commands/stop.js";
import { registerReviewCommand } from "./commands/review.js";
import { registerDocumentCommand } from "./commands/document.js";
import { registerReflectCommand } from "./commands/reflect.js";
import { registerClioCommands } from "./commands/clio.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerSelfUpdateCommand } from "./commands/self-update.js";
import { registerCompletionCommand } from "./commands/completion.js";
import { registerHelpCommand } from "./commands/help.js";
import { registerSpecCommand } from "./commands/spec.js";

// --- Internal: run the server in-process ---
// When the CLI is a compiled binary, `cfcf server start` re-spawns the same
// binary with `CFCF_INTERNAL_SERVE=1` so a single artifact hosts both the
// CLI and the server (item 5.3). We intercept here before commander parses.
if (process.env.CFCF_INTERNAL_SERVE === "1") {
  const { DEFAULT_PORT } = await import("@cfcf/core");
  const { startServer } = await import("@cfcf/server/start.js");
  const port = parseInt(process.env.CFCF_PORT || "", 10) || DEFAULT_PORT;
  await startServer(port);
  // The server keeps the event loop alive; do not fall through to CLI parsing.
} else {
  runCli();
}

/**
 * `cfcf --version` output. Since 2026-04-27 the resolution lives in
 * `@cfcf/core`'s VERSION constant (single source of truth — installed
 * package.json → workspace package.json → "0.0.0-unknown"). Both
 * `cfcf --version` and `cfcf server start` end up showing the same
 * string.
 */
function buildVersionString(): string {
  return VERSION;
}

function runCli(): void {

const program = new Command();

program
  .name("cfcf")
  .description("Cerefox Code Factory (cf²) -- AI coding agent orchestration")
  .version(buildVersionString());

// Override commander's auto-generated `help [command]` subcommand. We
// register our own `cfcf help [topic]` further down, which prints user
// manual / focused guides from the embedded help content. The default
// commander behaviour (list all subcommands) is still available via
// the `--help` flag at every level.
program.addHelpCommand(false);

registerServerCommands(program);
registerInitCommand(program);
registerStatusCommand(program);
registerWorkspaceCommands(program);
registerConfigCommands(program);
registerRunCommand(program);
registerResumeCommand(program);
registerStopCommand(program);
registerSpecCommand(program);
registerReviewCommand(program);
registerDocumentCommand(program);
registerReflectCommand(program);
registerClioCommands(program);
registerDoctorCommand(program);
registerSelfUpdateCommand(program);
registerHelpCommand(program);
// `completion` registers LAST so the walked tree includes every other
// verb already attached above. See packages/cli/src/commands/completion.ts.
registerCompletionCommand(program);

program.parse();
}
