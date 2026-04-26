#!/usr/bin/env bun
/**
 * cfcf CLI -- the primary user interface for cf².
 *
 * Communicates with the cfcf server via HTTP.
 * On first run (no config), starts the interactive setup flow.
 */

import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

/**
 * `cfcf --version` output. Reads `<install-dir>/MANIFEST` when available
 * (5.5 installer drops it at the install root; the binary lives at
 * `<install-dir>/bin/cfcf` so we look one level up from process.execPath).
 * In dev mode (no installer), falls back to just the VERSION constant.
 */
function buildVersionString(): string {
  try {
    const manifestPath = join(dirname(process.execPath), "..", "MANIFEST");
    if (existsSync(manifestPath)) {
      // MANIFEST starts with `cfcf:   <version>` so the cfcf line is
      // already there. Return it as-is; commander prints it verbatim.
      return readFileSync(manifestPath, "utf8").trimEnd();
    }
  } catch { /* fall through to bare-VERSION default */ }
  return VERSION;
}

function runCli(): void {

const program = new Command();

program
  .name("cfcf")
  .description("Cerefox Code Factory (cf²) -- AI coding agent orchestration")
  .version(buildVersionString());

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
