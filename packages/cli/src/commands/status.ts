/**
 * Quick status command (shortcut for 'cfcf server status').
 */

import type { Command } from "commander";
import { get } from "../client.js";
import { configExists, readConfig } from "@cfcf/core";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show cfcf status (server, config, agents)")
    .action(async () => {
      // Check config
      const hasConfig = await configExists();
      if (!hasConfig) {
        console.log("cfcf is not configured. Run 'cfcf init' to set up.");
        console.log();
      } else {
        const config = await readConfig();
        if (config) {
          console.log("Configuration:");
          console.log(`  Dev agent:   ${config.devAgent.adapter}${config.devAgent.model ? ` (${config.devAgent.model})` : ""}`);
          console.log(`  Judge agent: ${config.judgeAgent.adapter}${config.judgeAgent.model ? ` (${config.judgeAgent.model})` : ""}`);
          console.log(`  Max iters:   ${config.maxIterations}`);
          console.log(`  Pause every: ${config.pauseEvery === 0 ? "never" : `${config.pauseEvery} iterations`}`);
          console.log();
        }
      }

      // Check server
      const res = await get("/api/health");
      if (res.ok) {
        console.log("Server: running");
      } else {
        console.log("Server: not running");
        console.log("  Start with: cfcf server start");
      }
    });
}
