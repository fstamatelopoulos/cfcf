/**
 * First-run interactive configuration.
 *
 * Detects available agents, asks user for defaults,
 * explains permission flags, and stores config.
 */

import type { Command } from "commander";
import {
  configExists,
  readConfig,
  writeConfig,
  createDefaultConfig,
  getConfigPath,
  detectAvailableAgents,
  getAdapterNames,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_PAUSE_EVERY,
} from "@cfcf/core";
import type { CfcfGlobalConfig } from "@cfcf/core";
import { createInterface } from "readline";

/**
 * Prompt the user for input via stdin/stdout.
 */
function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Set up cfcf configuration (first-run setup)")
    .option("--force", "Re-run setup even if config exists")
    .action(async (opts) => {
      const exists = await configExists();
      if (exists && !opts.force) {
        console.log("cfcf is already configured.");
        console.log(`  Config file: ${getConfigPath()}`);
        console.log("  Use --force to reconfigure.");
        return;
      }

      console.log("Welcome to cfcf (cf²) -- Cerefox Code Factory");
      console.log("================================================");
      console.log();

      // Step 1: Detect agents
      console.log("Detecting installed AI coding agents...");
      console.log();

      const detectionResults = await detectAvailableAgents();
      const available: string[] = [];

      for (const result of detectionResults) {
        if (result.availability.available) {
          console.log(`  ✓ ${result.displayName} (${result.availability.version})`);
          available.push(result.name);
        } else {
          console.log(`  ✗ ${result.displayName} -- ${result.availability.error}`);
        }
      }

      // Check git
      console.log();
      try {
        const gitProc = Bun.spawn(["git", "--version"], { stdout: "pipe", stderr: "pipe" });
        const gitExit = await gitProc.exited;
        if (gitExit === 0) {
          const gitVersion = (await new Response(gitProc.stdout).text()).trim();
          console.log(`  ✓ git (${gitVersion})`);
        } else {
          console.log("  ✗ git -- not found. git is required for cfcf.");
          process.exit(1);
        }
      } catch {
        console.log("  ✗ git -- not found. git is required for cfcf.");
        process.exit(1);
      }

      console.log();

      if (available.length === 0) {
        console.log("No supported AI coding agents found.");
        console.log("cfcf requires at least one of: Claude Code, Codex CLI");
        console.log();
        console.log("Install Claude Code: https://docs.anthropic.com/en/docs/claude-code");
        console.log("Install Codex CLI:   https://github.com/openai/codex");
        process.exit(1);
      }

      // Step 2: Configure agents
      const config = createDefaultConfig(available);

      console.log("Configuration");
      console.log("-------------");

      if (available.length > 1) {
        console.log(`Available agents: ${available.join(", ")}`);
        console.log();

        const devChoice = await prompt(
          "Dev agent (writes code)",
          config.devAgent.adapter,
        );
        if (available.includes(devChoice)) {
          config.devAgent.adapter = devChoice;
        }

        const judgeChoice = await prompt(
          "Judge agent (reviews iterations)",
          config.judgeAgent.adapter,
        );
        if (available.includes(judgeChoice)) {
          config.judgeAgent.adapter = judgeChoice;
        }
      } else {
        console.log(`Using ${available[0]} for both dev and judge roles.`);
        config.devAgent.adapter = available[0];
        config.judgeAgent.adapter = available[0];
      }

      console.log();

      const maxIter = await prompt(
        "Max iterations per run",
        String(DEFAULT_MAX_ITERATIONS),
      );
      config.maxIterations = parseInt(maxIter, 10) || DEFAULT_MAX_ITERATIONS;

      const pauseEvery = await prompt(
        "Pause for review every N iterations (0 = never)",
        String(DEFAULT_PAUSE_EVERY),
      );
      config.pauseEvery = parseInt(pauseEvery, 10) || DEFAULT_PAUSE_EVERY;

      // Step 3: Permission acknowledgment
      console.log();
      console.log("Permission Notice");
      console.log("-----------------");
      console.log("cfcf runs AI agents in unattended mode. This requires:");
      console.log();

      for (const agentName of new Set([config.devAgent.adapter, config.judgeAgent.adapter])) {
        const adapter = detectionResults.find((r) => r.name === agentName);
        if (adapter) {
          // Get flags from the adapter registry
          const { getAdapter } = await import("@cfcf/core");
          const adapterImpl = getAdapter(agentName);
          if (adapterImpl) {
            const flags = adapterImpl.unattendedFlags();
            console.log(`  ${adapter.displayName}: ${flags.join(" ")}`);
          }
        }
      }

      console.log();
      console.log("Guardrails:");
      console.log("  - Agents work on a dedicated git branch (your main branch is untouched)");
      console.log("  - Agent instructions scope work to the project directory");
      console.log("  - cfcf verifies read-only files are not modified after each iteration");
      console.log();

      const ack = await prompt("Acknowledge and continue? (yes/no)", "yes");
      if (ack.toLowerCase() !== "yes" && ack.toLowerCase() !== "y") {
        console.log("Setup cancelled.");
        process.exit(0);
      }
      config.permissionsAcknowledged = true;

      // Step 4: Save config
      await writeConfig(config);
      console.log();
      console.log(`Configuration saved to: ${getConfigPath()}`);
      console.log();
      console.log("Next steps:");
      console.log("  1. Start the server:    cfcf server start");
      console.log("  2. Create a project:    cfcf project init --repo <path> --name <name>");
      console.log("  3. Populate problem-pack/problem.md and success.md with your problem definition");
      console.log("  4. Review with:         cfcf review --project <name>  (optional)");
      console.log("  5. Launch development:  cfcf run --project <name>");
      console.log();
    });
}
