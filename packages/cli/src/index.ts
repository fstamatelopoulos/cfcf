#!/usr/bin/env bun
/**
 * cfcf CLI -- the primary user interface for cf².
 *
 * Communicates with the cfcf server via HTTP.
 * On first run (no config), starts the interactive setup flow.
 */

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

function runCli(): void {

const program = new Command();

program
  .name("cfcf")
  .description("Cerefox Code Factory (cf²) -- AI coding agent orchestration")
  .version(VERSION);

registerServerCommands(program);
registerInitCommand(program);
registerStatusCommand(program);
registerWorkspaceCommands(program);
registerConfigCommands(program);
registerRunCommand(program);
registerResumeCommand(program);
registerStopCommand(program);
registerReviewCommand(program);
registerDocumentCommand(program);
registerReflectCommand(program);
registerClioCommands(program);

program.parse();
}
