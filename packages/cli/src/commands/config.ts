/**
 * Global config commands: show, edit.
 */

import type { Command } from "commander";
import { configExists, readConfig, getConfigPath } from "@cfcf/core";
import { formatAgent } from "../format.js";

export function registerConfigCommands(program: Command): void {
  const config = program
    .command("config")
    .description("View and manage cfcf global configuration");

  config
    .command("show")
    .description("Display current global configuration")
    .action(async () => {
      if (!(await configExists())) {
        console.log("cfcf is not configured. Run 'cfcf init' to set up.");
        return;
      }

      const cfg = await readConfig();
      if (!cfg) {
        console.error("Failed to read config.");
        process.exit(1);
      }

      console.log(`Config file: ${getConfigPath()}`);
      console.log();
      console.log(`Dev agent:       ${formatAgent(cfg.devAgent)}`);
      console.log(`Judge agent:     ${formatAgent(cfg.judgeAgent)}`);
      console.log(`Architect agent: ${formatAgent(cfg.architectAgent)}`);
      console.log(`Documenter:      ${formatAgent(cfg.documenterAgent)}`);
      console.log(`Max iterations:  ${cfg.maxIterations}`);
      console.log(`Pause every:     ${cfg.pauseEvery === 0 ? "never" : `${cfg.pauseEvery} iterations`}`);
      console.log(`Permissions:     ${cfg.permissionsAcknowledged ? "acknowledged" : "not acknowledged"}`);
      console.log(`Available agents: ${cfg.availableAgents.join(", ") || "none detected"}`);
    });

  config
    .command("edit")
    .description("Re-run the interactive setup (same as 'cfcf init --force')")
    .action(async () => {
      // Delegate to init --force
      const { registerInitCommand } = await import("./init.js");
      const tempProgram = new (await import("commander")).Command();
      registerInitCommand(tempProgram);
      await tempProgram.parseAsync(["node", "cfcf", "init", "--force"]);
    });
}
