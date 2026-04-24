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
  EMBEDDER_CATALOGUE,
  DEFAULT_EMBEDDER_NAME,
  findEmbedderEntry,
  LocalClio,
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
      console.log("  - Agent instructions scope work to the workspace directory");
      console.log("  - cfcf verifies read-only files are not modified after each iteration");
      console.log();

      const ack = await prompt("Acknowledge and continue? (yes/no)", "yes");
      if (ack.toLowerCase() !== "yes" && ack.toLowerCase() !== "y") {
        console.log("Setup cancelled.");
        process.exit(0);
      }
      config.permissionsAcknowledged = true;

      // Step 4: Clio memory-layer onboarding (item 5.7, refined 2026-04-23).
      // Pick-equals-install: if the user selects an embedder, download
      // + activate it directly from the CLI (no server needed; the
      // install is a LocalClio + transformers.js operation). The
      // user's choice is also saved as `preferredEmbedder` so a failed
      // install can be retried with `cfcf clio embedder install` (no arg).
      console.log();
      console.log("Clio memory layer");
      console.log("=================");
      console.log("Clio is cfcf's cross-workspace memory: cf² agents ingest curated");
      console.log("lessons (reflection analyses, architect reviews, decision-log");
      console.log("entries) after each iteration so sibling workspaces can query");
      console.log("them. Two modes:");
      console.log();
      console.log("  * FTS keyword search -- works immediately, no setup.");
      console.log("  * Hybrid + semantic vector search -- requires an embedder model.");
      console.log("    Picking one below triggers a one-time download (~20-430 MB");
      console.log("    depending on choice) from HuggingFace into ~/.cfcf/models/.");
      console.log();
      console.log("Available embedders:");
      EMBEDDER_CATALOGUE.forEach((e, i) => {
        const mark = e.name === DEFAULT_EMBEDDER_NAME ? "★" : " ";
        console.log(`  ${mark} ${i + 1}) ${e.name.padEnd(26)}  dim=${e.dim.toString().padStart(4)}  ~${e.approxSizeMb.toString().padStart(4)} MB`);
        console.log(`       ${e.description}`);
      });
      console.log("     S) Skip -- Clio runs in FTS-only mode until you install one.");
      console.log();
      const embedderPick = await prompt(
        `Embedder choice (1-${EMBEDDER_CATALOGUE.length} / S)`,
        String(EMBEDDER_CATALOGUE.findIndex((e) => e.name === DEFAULT_EMBEDDER_NAME) + 1),
      );
      let embedderPicked: string | null = null;
      const pickTrim = embedderPick.trim().toUpperCase();
      if (pickTrim === "S" || pickTrim === "SKIP") {
        embedderPicked = null;
      } else {
        const idx = parseInt(pickTrim, 10);
        if (!isNaN(idx) && idx >= 1 && idx <= EMBEDDER_CATALOGUE.length) {
          embedderPicked = EMBEDDER_CATALOGUE[idx - 1].name;
        } else {
          console.log(`Unrecognised choice "${embedderPick}"; defaulting to skip. You can install an embedder later.`);
        }
      }

      // Record the user's pick on the global config so `cfcf clio
      // embedder install` (no arg) can default to it. Also cleared
      // when user explicitly picks Skip.
      if (embedderPicked) {
        config.clio = { ...(config.clio ?? {}), preferredEmbedder: embedderPicked };
      } else if (config.clio) {
        const next = { ...config.clio };
        delete (next as { preferredEmbedder?: string }).preferredEmbedder;
        config.clio = Object.keys(next).length ? next : undefined;
      }

      // Step 5: Save config (before install, so even if install fails
      // the user's pick is persisted).
      await writeConfig(config);
      console.log();
      console.log(`Configuration saved to: ${getConfigPath()}`);

      // Step 6: Install the embedder now (if picked). Happens AFTER
      // config write so the preferred-embedder record survives a
      // failed download (retryable via `cfcf clio embedder install`).
      let embedderInstalled = false;
      let installError: string | null = null;
      // Post-install verification snapshot from clio.db (item 6.19).
      // Populated only when install succeeds -- confirms the DB reflects
      // what we think we installed (catches the theoretical case where
      // installActiveEmbedder returns OK but the active-embedder row is
      // absent / mismatched).
      let verifiedActive: { name: string; dim: number; recommendedChunkMaxChars: number } | null = null;
      if (embedderPicked) {
        const entry = findEmbedderEntry(embedderPicked);
        if (!entry) {
          installError = `Unknown embedder "${embedderPicked}" (catalogue mismatch?)`;
        } else {
          console.log();
          console.log(`Installing embedder: ${entry.name} (~${entry.approxSizeMb} MB download)`);
          console.log("First run only; subsequent uses read from ~/.cfcf/models/.");
          console.log();
          // Open LocalClio directly -- no server needed. This creates
          // ~/.cfcf/clio.db + runs migrations + triggers the HF
          // download via the transformers.js pipeline.
          let clio: LocalClio | null = null;
          try {
            clio = new LocalClio();
            await clio.installActiveEmbedder(entry, { force: false, loadNow: true });
            const record = clio.getActiveEmbedderRecord();
            if (!record || record.name !== entry.name) {
              throw new Error(
                `post-install check: expected active embedder "${entry.name}", got "${record?.name ?? "(none)"}"`,
              );
            }
            verifiedActive = {
              name: record.name,
              dim: record.dim,
              recommendedChunkMaxChars: record.recommendedChunkMaxChars,
            };
            embedderInstalled = true;
            console.log();
            console.log(`✓ Clio ready: ${verifiedActive.name} (dim=${verifiedActive.dim}, chunk=${verifiedActive.recommendedChunkMaxChars} chars)`);
          } catch (err) {
            installError = err instanceof Error ? err.message : String(err);
          } finally {
            if (clio) {
              try { await clio.close(); } catch { /* best-effort */ }
            }
          }
        }
      }

      console.log();
      console.log("Next steps:");
      console.log("  1. Start the server:    cfcf server start");
      if (embedderInstalled && verifiedActive) {
        console.log(`       (Clio ready: ${verifiedActive.name}, dim=${verifiedActive.dim}, chunk=${verifiedActive.recommendedChunkMaxChars} chars)`);
      } else if (installError) {
        console.log(`  2. Retry embedder install (download failed above): cfcf clio embedder install`);
        console.log(`       (your pick "${embedderPicked}" is saved; rerun from a network-connected shell)`);
      } else {
        console.log(`       (Clio: FTS-only mode -- install an embedder later with: cfcf clio embedder install ${DEFAULT_EMBEDDER_NAME})`);
      }
      const nextStep = embedderInstalled || !installError ? 2 : 3;
      console.log(`  ${nextStep}. Create a workspace:   cfcf workspace init --repo <path> --name <name>`);
      console.log(`  ${nextStep + 1}. Populate problem-pack/problem.md and success.md with your problem definition`);
      console.log(`  ${nextStep + 2}. Review with:          cfcf review --workspace <name>  (optional)`);
      console.log(`  ${nextStep + 3}. Launch development:   cfcf run --workspace <name>`);
      if (installError) {
        console.log();
        console.log(`Install error (captured -- you can retry): ${installError}`);
      }
      console.log();
    });
}
