/**
 * Global config commands: show, edit.
 */

import type { Command } from "commander";
import {
  configExists,
  readConfig,
  getConfigPath,
  isClaudeCodeHarnessRisk,
} from "@cfcf/core";
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
      if (cfg.productArchitectAgent) {
        console.log(`Product Architect: ${formatAgent(cfg.productArchitectAgent)}`);
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
      if (cfg.availableOllamaModels && cfg.availableOllamaModels.length > 0) {
        const summary = cfg.availableOllamaModels.length <= 5
          ? cfg.availableOllamaModels.join(", ")
          : `${cfg.availableOllamaModels.slice(0, 5).join(", ")}, +${cfg.availableOllamaModels.length - 5} more`;
        console.log(`Ollama models:     ${summary}`);
      }

      // item 6.28 — surface a one-line harness-policy warning when
      // claude-code is configured for any unattended role. Mirrors
      // the longer block in `cfcf init`'s post-pick output but kept
      // terse here because `config show` is informational not setup.
      const risky: string[] = [];
      if (isClaudeCodeHarnessRisk(cfg.devAgent.adapter)) risky.push("dev");
      if (isClaudeCodeHarnessRisk(cfg.judgeAgent.adapter)) risky.push("judge");
      if (isClaudeCodeHarnessRisk(cfg.documenterAgent.adapter)) risky.push("documenter");
      if (cfg.reflectionAgent && isClaudeCodeHarnessRisk(cfg.reflectionAgent.adapter)) risky.push("reflection");
      if (cfg.autoReviewSpecs && isClaudeCodeHarnessRisk(cfg.architectAgent.adapter)) risky.push("architect (autoReviewSpecs=true)");
      if (risky.length > 0) {
        console.log();
        console.log(`⚠  Anthropic harness-policy notice: claude-code in use for ${risky.join(", ")}.`);
        console.log(`   See \`cfcf help anthropic-policy\` for compliant alternatives.`);
      }

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
