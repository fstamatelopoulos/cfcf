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

      console.log(`Available agents: ${available.join(", ")}`);
      console.log();
      console.log("Four agent roles (each independently configurable):");
      console.log("  - Dev agent: writes code, runs tests");
      console.log("  - Judge agent: reviews iterations (encouraged to differ from dev)");
      console.log("  - Architect agent: reviews Problem Pack, creates plan outline");
      console.log("  - Documenter agent: produces final polished documentation");
      console.log();

      if (available.length > 1) {
        const devChoice = await prompt(
          "Dev agent",
          config.devAgent.adapter,
        );
        if (available.includes(devChoice)) {
          config.devAgent.adapter = devChoice;
        }

        const judgeChoice = await prompt(
          "Judge agent",
          config.judgeAgent.adapter,
        );
        if (available.includes(judgeChoice)) {
          config.judgeAgent.adapter = judgeChoice;
        }

        const architectChoice = await prompt(
          "Architect agent",
          config.architectAgent.adapter,
        );
        if (available.includes(architectChoice)) {
          config.architectAgent.adapter = architectChoice;
        }

        const documenterChoice = await prompt(
          "Documenter agent",
          config.documenterAgent.adapter,
        );
        if (available.includes(documenterChoice)) {
          config.documenterAgent.adapter = documenterChoice;
        }
      } else {
        console.log(`Using ${available[0]} for all roles.`);
        config.devAgent.adapter = available[0];
        config.judgeAgent.adapter = available[0];
        config.architectAgent.adapter = available[0];
        config.documenterAgent.adapter = available[0];
      }

      // Model selection per role
      console.log();
      console.log("Model selection (optional -- leave empty for agent default):");
      console.log("  Examples: opus, sonnet, o3, gpt-4o");
      console.log();

      const devModel = await prompt("Dev agent model", "");
      if (devModel) config.devAgent.model = devModel;

      const judgeModel = await prompt("Judge agent model", "");
      if (judgeModel) config.judgeAgent.model = judgeModel;

      const architectModel = await prompt("Architect agent model", "");
      if (architectModel) config.architectAgent.model = architectModel;

      const documenterModel = await prompt("Documenter agent model", "");
      if (documenterModel) config.documenterAgent.model = documenterModel;

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

      // Reflection safeguard (item 5.6)
      const safeguard = await prompt(
        "Force reflection after N consecutive judge opt-outs",
        String(config.reflectSafeguardAfter ?? 3),
      );
      const safeguardN = parseInt(safeguard, 10);
      config.reflectSafeguardAfter = Number.isFinite(safeguardN) && safeguardN >= 1 ? safeguardN : 3;

      // Pre-loop review + post-success documenter (item 5.1)
      console.log();
      console.log("Pre-loop Review and Post-SUCCESS Documenter");
      console.log("-------------------------------------------");
      console.log("autoReviewSpecs: when 'yes', Start Loop first runs the Solution");
      console.log("  Architect; if readiness is unacceptable the loop pauses so you");
      console.log("  can refine the Problem Pack. When 'no', Review remains an");
      console.log("  optional user-invoked step (the 'Review' button / cfcf review).");
      const autoRev = await prompt(
        "autoReviewSpecs -- run Solution Architect before every loop? (yes/no)",
        config.autoReviewSpecs ? "yes" : "no",
      );
      config.autoReviewSpecs = autoRev.toLowerCase() === "yes" || autoRev.toLowerCase() === "y";

      if (config.autoReviewSpecs) {
        console.log();
        console.log("readinessGate: how strict is the pre-loop block?");
        console.log("  never: review informational; loop always proceeds");
        console.log("  blocked (default): stop only on BLOCKED; proceed on NEEDS_REFINEMENT with warning");
        console.log("  needs_refinement_or_blocked: strictest; stop on anything but READY");
        const gate = await prompt(
          "readinessGate (never | blocked | needs_refinement_or_blocked)",
          config.readinessGate ?? "blocked",
        );
        if (gate === "never" || gate === "blocked" || gate === "needs_refinement_or_blocked") {
          config.readinessGate = gate;
        } else {
          console.log(`  (unrecognised value, keeping "${config.readinessGate ?? "blocked"}")`);
        }
      }

      console.log();
      console.log("autoDocumenter: when 'yes', the loop automatically runs the");
      console.log("  Documenter after judging SUCCESS and before the terminal state.");
      console.log("  When 'no', the loop skips that phase; run 'cfcf document' manually.");
      const autoDoc = await prompt(
        "autoDocumenter -- run Documenter on SUCCESS? (yes/no)",
        (config.autoDocumenter ?? true) ? "yes" : "no",
      );
      config.autoDocumenter = autoDoc.toLowerCase() === "yes" || autoDoc.toLowerCase() === "y";

      // Notifications
      console.log();
      console.log("Notifications");
      console.log("-------------");
      const osChannel = process.platform === "darwin" ? "macOS notification center"
        : process.platform === "linux" ? "Linux notify-send"
        : "terminal bell only";
      console.log(`cfcf can ping you when a loop pauses, completes, or an agent fails.`);
      console.log(`Channels on your system: terminal bell + ${osChannel} + notifications.log`);
      console.log();
      const notifEnabled = await prompt(
        "Enable notifications? (yes/no)",
        config.notifications?.enabled ? "yes" : "no",
      );
      if (config.notifications) {
        config.notifications.enabled =
          notifEnabled.toLowerCase() === "yes" || notifEnabled.toLowerCase() === "y";
      }

      // Step 3: Permission acknowledgment
      console.log();
      console.log("Permission Notice");
      console.log("-----------------");
      console.log("cfcf runs AI agents in unattended mode. This requires:");
      console.log();

      for (const agentName of new Set([config.devAgent.adapter, config.judgeAgent.adapter, config.architectAgent.adapter, config.documenterAgent.adapter])) {
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
