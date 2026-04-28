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
      console.log(`Dev agent:        ${formatAgent(cfg.devAgent)}`);
      console.log(`Judge agent:      ${formatAgent(cfg.judgeAgent)}`);
      console.log(`Architect agent:  ${formatAgent(cfg.architectAgent)}`);
      console.log(`Documenter:       ${formatAgent(cfg.documenterAgent)}`);
      if (cfg.reflectionAgent) {
        console.log(`Reflection agent: ${formatAgent(cfg.reflectionAgent)}`);
      }
      if (cfg.helpAssistantAgent) {
        console.log(`Help Assistant:   ${formatAgent(cfg.helpAssistantAgent)}`);
      }
      console.log(`Max iterations:   ${cfg.maxIterations}`);
      console.log(`Pause every:      ${cfg.pauseEvery === 0 ? "never" : `${cfg.pauseEvery} iterations`}`);
      console.log(`Reflect safeguard: force after ${cfg.reflectSafeguardAfter ?? 3} consecutive opt-outs`);
      console.log(`Auto review specs: ${cfg.autoReviewSpecs ? "yes (Solution Architect runs before every loop)" : "no (Review is optional, user-invoked)"}`);
      if (cfg.autoReviewSpecs) {
        console.log(`Readiness gate:    ${cfg.readinessGate ?? "blocked"}`);
      }
      console.log(`Auto documenter:   ${cfg.autoDocumenter === false ? "no (user invokes cfcf document manually)" : "yes (runs on SUCCESS)"}`);
      console.log(`Cleanup merged:    ${cfg.cleanupMergedBranches ? "yes (delete iteration branches after merge)" : "no (keep for audit)"}`);
      console.log(`Permissions:       ${cfg.permissionsAcknowledged ? "acknowledged" : "not acknowledged"}`);
      console.log(`Available agents:  ${cfg.availableAgents.join(", ") || "none detected"}`);
      if (cfg.notifications) {
        console.log(`Notifications:    ${cfg.notifications.enabled ? "enabled" : "disabled"}`);
        if (cfg.notifications.enabled) {
          for (const [eventType, channels] of Object.entries(cfg.notifications.events)) {
            if (channels && channels.length > 0) {
              console.log(`  ${eventType}: ${channels.join(", ")}`);
            }
          }
        }
      }
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
