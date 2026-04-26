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
  isEmbedderCached,
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

      // Step 2: Configure agents.
      //
      // Re-running `cfcf init --force` (and `cfcf config edit`, which
      // delegates here) on an already-configured machine should offer
      // the user's current values as defaults rather than the hardcoded
      // bootstrap defaults — see plan item 6.21. We load the existing
      // config and use it as the base; validate that each role's adapter
      // is still detected on this machine (a previously-installed agent
      // may have been removed) and fall back to the bootstrap default
      // for any role pointing at an unavailable agent.
      let config: CfcfGlobalConfig = createDefaultConfig(available);
      const fresh = createDefaultConfig(available); // kept for fallback
      if (exists && opts.force) {
        const existing = await readConfig();
        if (existing) {
          config = existing;
          // Refresh the detected-agents list (may have changed since
          // last init).
          config.availableAgents = available;
          // Sanity-check each role's adapter against current detection.
          // If the user's previously-picked dev agent is gone, fall
          // back to the bootstrap default rather than carrying a stale
          // pick the prompts would then re-offer.
          const heal = (current: string, fallback: string): string =>
            available.includes(current) ? current : fallback;
          config.devAgent.adapter        = heal(config.devAgent.adapter,        fresh.devAgent.adapter);
          config.judgeAgent.adapter      = heal(config.judgeAgent.adapter,      fresh.judgeAgent.adapter);
          config.architectAgent.adapter  = heal(config.architectAgent.adapter,  fresh.architectAgent.adapter);
          config.documenterAgent.adapter = heal(config.documenterAgent.adapter, fresh.documenterAgent.adapter);
        }
      }

      console.log("Configuration");
      console.log("-------------");

      console.log("Detected agents:");
      available.forEach((a, i) => console.log(`  ${i + 1}) ${a}`));
      console.log();
      console.log("Four agent roles (each independently configurable):");
      console.log("  - Dev agent: writes code, runs tests");
      console.log("  - Judge agent: reviews iterations (encouraged to differ from dev)");
      console.log("  - Architect agent: reviews Problem Pack, creates plan outline");
      console.log("  - Documenter agent: produces final polished documentation");
      console.log();

      // Pick an agent by number against the detected list. Returns the
      // chosen adapter name; never returns an unsupported value (loops
      // until the user types something valid OR accepts the default).
      // Default index = position of `defaultName` in `available`, or 1.
      // `defaultName` is the value that came from createDefaultConfig --
      // e.g. claude-code if both are detected -- so pressing Enter keeps
      // the conventional pick.
      async function pickAgent(role: string, defaultName: string): Promise<string> {
        if (available.length === 1) return available[0];
        const defaultIdx = Math.max(available.indexOf(defaultName), 0) + 1;
        while (true) {
          const raw = await prompt(`${role} agent (1-${available.length})`, String(defaultIdx));
          const n = parseInt(raw, 10);
          if (!Number.isNaN(n) && n >= 1 && n <= available.length) {
            return available[n - 1];
          }
          console.log(`  Invalid choice "${raw}". Enter a number 1-${available.length}.`);
        }
      }

      if (available.length > 1) {
        config.devAgent.adapter        = await pickAgent("Dev",        config.devAgent.adapter);
        config.judgeAgent.adapter      = await pickAgent("Judge",      config.judgeAgent.adapter);
        config.architectAgent.adapter  = await pickAgent("Architect",  config.architectAgent.adapter);
        config.documenterAgent.adapter = await pickAgent("Documenter", config.documenterAgent.adapter);
      } else {
        console.log(`Only one agent detected (${available[0]}); using for all roles.`);
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

      // Model prompts default to the existing per-role model when set
      // (so re-running init keeps the user's pick on Enter). Empty
      // input clears the override; an explicit value wins.
      const devModel = await prompt("Dev agent model", config.devAgent.model ?? "");
      config.devAgent.model = devModel || undefined;

      const judgeModel = await prompt("Judge agent model", config.judgeAgent.model ?? "");
      config.judgeAgent.model = judgeModel || undefined;

      const architectModel = await prompt("Architect agent model", config.architectAgent.model ?? "");
      config.architectAgent.model = architectModel || undefined;

      const documenterModel = await prompt("Documenter agent model", config.documenterAgent.model ?? "");
      config.documenterAgent.model = documenterModel || undefined;

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
      // Default the picker to the user's existing preferredEmbedder
      // when set (re-running init shouldn't push them back to the
      // catalogue default). Falls back to DEFAULT_EMBEDDER_NAME for
      // first-run installs.
      const existingPref = config.clio?.preferredEmbedder;
      const defaultEmbedderIdx = (() => {
        const target = existingPref ?? DEFAULT_EMBEDDER_NAME;
        const i = EMBEDDER_CATALOGUE.findIndex((e) => e.name === target);
        return (i >= 0 ? i : EMBEDDER_CATALOGUE.findIndex((e) => e.name === DEFAULT_EMBEDDER_NAME)) + 1;
      })();
      const embedderPick = await prompt(
        `Embedder choice (1-${EMBEDDER_CATALOGUE.length} / S)`,
        String(defaultEmbedderIdx),
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
      // 2026-04-25: init DOES trigger the HF download (loadNow: true)
      // and the underlying loadNow now actually warms the pipeline
      // (Embedder.warmup() added the same day; the previous loadNow
      // implementation only constructed the embedder shell). When this
      // returns successfully the model is on disk in ~/.cfcf/models/,
      // active in the DB, and the inference pipeline is materialised --
      // first `cfcf clio search` is instant.
      let embedderInstalled = false;
      let installError: string | null = null;
      let verifiedActive: { name: string; dim: number; recommendedChunkMaxChars: number } | null = null;
      if (embedderPicked) {
        const entry = findEmbedderEntry(embedderPicked);
        if (!entry) {
          installError = `Unknown embedder "${embedderPicked}" (catalogue mismatch?)`;
        } else {
          // Fast path: model already downloaded AND active in Clio's
          // DB → skip the warmup-with-progress-bar dance entirely. The
          // `Installing embedder ... ~130 MB download` + progress bar
          // were misleading on init re-runs; the only network traffic
          // was transformers.js re-validating tiny config files. Fix
          // captured 2026-04-26 during dogfood install.
          let clio: LocalClio | null = null;
          try {
            clio = new LocalClio();
            const existingActive = clio.getActiveEmbedderRecord();
            const fullyCached =
              existingActive?.name === entry.name && isEmbedderCached(entry);

            if (fullyCached && existingActive) {
              console.log();
              console.log(
                `✓ Clio ready: ${existingActive.name} (already cached and active; dim=${existingActive.dim}, chunk=${existingActive.recommendedChunkMaxChars} chars)`,
              );
              verifiedActive = {
                name: existingActive.name,
                dim: existingActive.dim,
                recommendedChunkMaxChars: existingActive.recommendedChunkMaxChars,
              };
              embedderInstalled = true;
            } else {
              // First-time install or different embedder picked --
              // download is real; show the bandwidth hint + progress.
              console.log();
              console.log(`Installing embedder: ${entry.name} (~${entry.approxSizeMb} MB download)`);
              console.log("First run only; subsequent uses read from ~/.cfcf/models/.");
              console.log();
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
            }
          } catch (err) {
            installError = err instanceof Error ? err.message : String(err);
          } finally {
            if (clio) {
              try { await clio.close(); } catch { /* best-effort */ }
            }
          }
        }
      }

      // Classify the install error so the message + retry hint match
      // the actual failure mode. Three buckets:
      //   - module-resolution: the @huggingface/transformers JS package
      //     couldn't be loaded from disk. Almost always a dev-mode issue
      //     (running the compiled binary from a path where the upward
      //     node_modules walk doesn't find the externalised deps). The
      //     real installer (5.5) ships a colocated node_modules/ next to
      //     the binary so end users never see this.
      //   - network: the JS package loaded fine, but transformers.js
      //     couldn't reach HuggingFace (offline / proxy / DNS / 403).
      //     Retrying from a network-connected shell is the right advice.
      //   - other: anything else -- print the raw error.
      const errorClass = installError ? classifyInstallError(installError) : null;
      console.log();
      console.log("Next steps:");
      console.log("  1. Start the server:    cfcf server start");
      if (embedderInstalled && verifiedActive) {
        console.log(`       (Clio ready: ${verifiedActive.name}, dim=${verifiedActive.dim}, chunk=${verifiedActive.recommendedChunkMaxChars} chars)`);
      } else if (errorClass === "module-resolution") {
        console.log(`  2. Fix the module path, then re-run: cfcf init --force`);
        console.log(`       This is a dev-mode issue: the binary couldn't load the JS`);
        console.log(`       package '@huggingface/transformers' from disk. The HF`);
        console.log(`       download did NOT happen. Three workarounds:`);
        console.log(`         (a) NODE_PATH=$(realpath packages/core/node_modules) ./cfcf-binary init --force`);
        console.log(`         (b) (cd packages/core && /full/path/to/cfcf-binary init --force)`);
        console.log(`         (c) bun run dev:cli init --force`);
        console.log(`       Real-installer users (item 5.5) won't hit this -- the`);
        console.log(`       installer ships node_modules/ colocated with the binary.`);
      } else if (errorClass === "network") {
        console.log(`  2. Retry embedder install (HF download failed): cfcf clio embedder install`);
        console.log(`       (your pick "${embedderPicked}" is saved; rerun from a network-connected shell)`);
      } else if (installError) {
        console.log(`  2. Retry embedder install: cfcf clio embedder install`);
        console.log(`       (your pick "${embedderPicked}" is saved)`);
      } else {
        console.log(`       (Clio: FTS-only mode -- install an embedder later with: cfcf clio embedder install ${DEFAULT_EMBEDDER_NAME})`);
      }
      const nextStep = embedderInstalled || !installError ? 2 : 3;
      console.log(`  ${nextStep}. Create a workspace:   cfcf workspace init --repo <path> --name <name>`);
      console.log(`  ${nextStep + 1}. Populate problem-pack/problem.md and success.md with your problem definition`);
      console.log(`  ${nextStep + 2}. Review with:          cfcf review --workspace <name>  (optional)`);
      console.log(`  ${nextStep + 3}. Launch development:   cfcf run --workspace <name>`);
      console.log();
      console.log("Note: if cfcf server is currently running, restart it so the new");
      console.log("config + active embedder take effect (the server caches both at");
      console.log("startup):");
      console.log("    cfcf server stop && cfcf server start");
      if (installError) {
        console.log();
        const label = errorClass === "module-resolution"
          ? "Install error (dev-mode module-resolution -- see step 2 above)"
          : errorClass === "network"
          ? "Install error (network/HuggingFace failure -- see step 2 above)"
          : "Install error (captured -- you can retry)";
        console.log(`${label}: ${installError}`);
      }
      console.log();
    });
}

/**
 * Classify an embedder-install error so init can show a useful retry
 * hint. We can't tell from a single string with 100% confidence, but
 * the keyword heuristics catch the two common cases (Bun/Node module
 * resolution failure for the externalised JS package, and
 * transformers.js's network/HF failures).
 */
function classifyInstallError(message: string): "module-resolution" | "network" | "other" {
  const m = message.toLowerCase();
  // Bun's ResolveMessage / Node's MODULE_NOT_FOUND wording.
  if (m.includes("cannot find module") || m.includes("resolvemessage") || m.includes("module_not_found")) {
    return "module-resolution";
  }
  // transformers.js / fetch failures during the HF download.
  if (
    m.includes("enotfound") ||
    m.includes("econnrefused") ||
    m.includes("etimedout") ||
    m.includes("certificate") ||
    m.includes("huggingface") ||
    m.includes("fetch failed") ||
    m.includes("network")
  ) {
    return "network";
  }
  return "other";
}
