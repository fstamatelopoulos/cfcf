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
import { registerProjectCommands } from "./commands/project.js";
import { registerConfigCommands } from "./commands/config.js";
import { registerRunCommand } from "./commands/run.js";
import { registerResumeCommand } from "./commands/resume.js";
import { registerStopCommand } from "./commands/stop.js";

const program = new Command();

program
  .name("cfcf")
  .description("Cerefox Code Factory (cf²) -- AI coding agent orchestration")
  .version(VERSION);

registerServerCommands(program);
registerInitCommand(program);
registerStatusCommand(program);
registerProjectCommands(program);
registerConfigCommands(program);
registerRunCommand(program);
registerResumeCommand(program);
registerStopCommand(program);

program.parse();
