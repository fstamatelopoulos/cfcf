/**
 * Configuration management for cfcf.
 *
 * Handles reading, writing, and validating the global config file.
 * Config is stored in the platform-specific config directory.
 */

import { join } from "path";
import { mkdir, readFile, writeFile, access } from "fs/promises";
import {
  getConfigDir,
  CONFIG_FILENAME,
  CONFIG_VERSION,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_PAUSE_EVERY,
} from "./constants.js";
import type { CfcfGlobalConfig } from "./types.js";

/**
 * Get the full path to the config file.
 */
export function getConfigPath(): string {
  return join(getConfigDir(), CONFIG_FILENAME);
}

/**
 * Check if the config file exists (i.e., first-run setup has been completed).
 */
export async function configExists(): Promise<boolean> {
  try {
    await access(getConfigPath());
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and parse the config file.
 * Returns null if the file doesn't exist.
 * Throws on parse errors.
 */
export async function readConfig(): Promise<CfcfGlobalConfig | null> {
  try {
    const raw = await readFile(getConfigPath(), "utf-8");
    const config = JSON.parse(raw) as CfcfGlobalConfig;
    return validateConfig(config);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Write the config file, creating the directory if needed.
 */
export async function writeConfig(config: CfcfGlobalConfig): Promise<void> {
  const dir = getConfigDir();
  await mkdir(dir, { recursive: true });
  const path = getConfigPath();
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Create a default config populated with detected agents.
 *
 * `availableOllamaModels` is optional (item 6.28) — when ollama isn't
 * detected at first-run time, callers pass undefined or an empty array
 * and the config field stays unset. The model picker for `*-ollama`
 * adapters falls back to its empty-list path.
 */
export function createDefaultConfig(
  availableAgents: string[],
  availableOllamaModels?: string[],
): CfcfGlobalConfig {
  // Default-adapter policy (item 6.28):
  //   - **Unattended roles** (dev / judge / reflection / documenter): prefer
  //     `codex` first, since Anthropic's third-party-harness policy makes
  //     `claude-code` non-compliant for these. Without this preference,
  //     fresh `cfcf init` would default unattended roles to claude-code
  //     and immediately fire the policy warning — bad UX.
  //   - **Interactive roles** (architect / Product Architect / Help
  //     Assistant): prefer `claude-code` first. These run inside the
  //     user's TUI and are within Anthropic's allowed-interactive scope.
  //
  // Helper: prefer codex among policy-compliant unattended adapters.
  // The future ollama-routed + opencode adapters are also compliant;
  // codex stays first because it's the most well-tested existing path
  // and OpenAI's policy explicitly endorses CLI automation.
  const pickUnattendedDefault = (excludeAdapter?: string): string => {
    const order = ["codex", "claude-code-ollama", "opencode-ollama", "opencode", "claude-code"];
    for (const candidate of order) {
      if (candidate === excludeAdapter) continue;
      if (availableAgents.includes(candidate)) return candidate;
    }
    return availableAgents[0] || "codex";
  };

  // Dev: codex if available, else claude-code, else first detected.
  const devAdapter = pickUnattendedDefault();

  // Judge: prefer a different policy-compliant adapter from dev. If only
  // one compliant adapter is available, fall back to same-as-dev rather
  // than claude-code (avoiding the warning trumps the differ-from-dev
  // preference).
  const judgeCandidate = pickUnattendedDefault(devAdapter);
  const judgeAdapter = judgeCandidate === "claude-code" ? devAdapter : judgeCandidate;

  // Architect: prefer claude-code (interactive role — `cfcf review` is
  // user-invoked; runs unattended only when `autoReviewSpecs=true`,
  // which is opt-in and surfaces the warning at init time).
  const architectAdapter =
    availableAgents.includes("claude-code")
      ? "claude-code"
      : devAdapter;

  // Documenter: same policy as dev — runs unattended after a successful
  // loop, so prefer codex over claude-code.
  const documenterAdapter = pickUnattendedDefault();

  // Default notifications: pick the OS channel for the current platform
  const osChannel = process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : "terminal-bell";
  const defaultNotifications: import("./types.js").NotificationConfig = {
    enabled: true,
    events: {
      "loop.paused": ["terminal-bell", osChannel as import("./types.js").NotificationChannelName, "log"],
      "loop.completed": ["terminal-bell", osChannel as import("./types.js").NotificationChannelName, "log"],
      "agent.failed": ["terminal-bell", osChannel as import("./types.js").NotificationChannelName, "log"],
    },
  };

  // PA + HA: explicit defaults to claude-code (interactive scope). Without
  // this, validateConfig backfills them from architect / dev — and with
  // the dev=codex flip above, HA would otherwise default to codex even
  // though it's an interactive role where claude-code is policy-clean.
  const productArchitectAdapter =
    availableAgents.includes("claude-code")
      ? "claude-code"
      : architectAdapter;
  const helpAssistantAdapter =
    availableAgents.includes("claude-code")
      ? "claude-code"
      : devAdapter;

  return {
    version: CONFIG_VERSION,
    devAgent: { adapter: devAdapter },
    judgeAgent: { adapter: judgeAdapter },
    architectAgent: { adapter: architectAdapter },
    documenterAgent: { adapter: documenterAdapter },
    // Reflection runs unattended every iteration — backfill from the
    // policy-compliant unattended pick (same as dev's default), not
    // from architect (which prefers claude-code for interactive use).
    reflectionAgent: { adapter: devAdapter },
    productArchitectAgent: { adapter: productArchitectAdapter },
    helpAssistantAgent: { adapter: helpAssistantAdapter },
    reflectSafeguardAfter: 3,
    autoReviewSpecs: false,
    autoDocumenter: true,
    readinessGate: "blocked",
    maxIterations: DEFAULT_MAX_ITERATIONS,
    pauseEvery: DEFAULT_PAUSE_EVERY,
    availableAgents,
    availableOllamaModels: Array.isArray(availableOllamaModels) && availableOllamaModels.length > 0
      ? [...availableOllamaModels]
      : undefined,
    permissionsAcknowledged: false,
    notifications: defaultNotifications,
    notifyUpdates: true,   // item 6.20
    theme: "auto",         // item 6.12 -- follow OS prefers-color-scheme until the user picks a theme via the web toggle
  };
}

/**
 * Validate a config object. Returns the config if valid, throws if not.
 */
/**
 * Validate a config object. Throws on fields that are genuinely required
 * (`version`, `devAgent.adapter`, `judgeAgent.adapter`); backfills the rest
 * with sensible defaults so older configs continue to work after upgrade.
 *
 * Exported so the server's `PUT /api/config` endpoint (item 5.9) can
 * reuse the same rules as `readConfig` when accepting user edits.
 */
export function validateConfig(config: CfcfGlobalConfig): CfcfGlobalConfig {
  if (!config.version || typeof config.version !== "number") {
    throw new Error("Invalid config: missing or invalid 'version' field");
  }
  if (!config.devAgent?.adapter) {
    throw new Error("Invalid config: missing 'devAgent.adapter'");
  }
  if (!config.judgeAgent?.adapter) {
    throw new Error("Invalid config: missing 'judgeAgent.adapter'");
  }
  // Backfill newer fields for configs created before these roles existed
  if (!config.architectAgent?.adapter) {
    config.architectAgent = { adapter: config.devAgent.adapter };
  }
  if (!config.documenterAgent?.adapter) {
    config.documenterAgent = { adapter: config.devAgent.adapter };
  }
  // Backfill reflection role (item 5.6). Default to the architect agent
  // because reflection shares the "broad context, strong reasoning" profile.
  if (!config.reflectionAgent?.adapter) {
    config.reflectionAgent = {
      adapter: config.architectAgent?.adapter ?? config.devAgent.adapter,
    };
  }
  // Backfill Help Assistant role (item 5.8 PR4). Default to the dev
  // agent because the HA's interaction profile (interactive shell,
  // tool use, file reads) closely matches what users picked for dev.
  if (!config.helpAssistantAgent?.adapter) {
    config.helpAssistantAgent = { adapter: config.devAgent.adapter };
  }
  // Backfill Product Architect role (item 5.14). Default to the
  // architect agent because PA's spec-iteration workload (broad
  // context + strong reasoning + multi-turn judgement) closely
  // matches what the architect role does on the loop side.
  // Falls back through architect -> dev so a config that's been
  // hand-edited to remove architectAgent still gets a sensible PA.
  if (!config.productArchitectAgent?.adapter) {
    config.productArchitectAgent = {
      adapter: config.architectAgent?.adapter ?? config.devAgent.adapter,
    };
  }
  if (typeof config.reflectSafeguardAfter !== "number" || config.reflectSafeguardAfter < 1) {
    config.reflectSafeguardAfter = 3;
  }
  // item 5.1 backfills -- pre-5.1 configs don't have these keys.
  if (typeof config.autoReviewSpecs !== "boolean") {
    config.autoReviewSpecs = false;
  }
  if (typeof config.autoDocumenter !== "boolean") {
    config.autoDocumenter = true;
  }
  if (!isValidReadinessGate(config.readinessGate)) {
    config.readinessGate = "blocked";
  }
  // item 6.20 -- new-version notification opt-out. Default true so existing
  // installs start surfacing the lifecycle banner once they upgrade past
  // 0.18.0 without needing a config edit.
  if (typeof config.notifyUpdates !== "boolean") {
    config.notifyUpdates = true;
  }
  // item 6.12 -- web UI theme. Default "auto" so existing installs follow
  // the user's OS preference until they pick a theme explicitly.
  if (config.theme !== "dark" && config.theme !== "light" && config.theme !== "auto") {
    config.theme = "auto";
  }
  // item 6.28 -- ollama models snapshot from `ollama list` at init time.
  // Coerce malformed entries to undefined so a hand-edited config can't
  // break startup. An empty array gets normalised to undefined too —
  // there's no observable difference downstream.
  if (config.availableOllamaModels !== undefined) {
    if (!Array.isArray(config.availableOllamaModels)) {
      delete config.availableOllamaModels;
    } else {
      const filtered = config.availableOllamaModels
        .filter((m): m is string => typeof m === "string" && m.trim().length > 0)
        .map((m) => m.trim());
      config.availableOllamaModels = filtered.length > 0 ? filtered : undefined;
    }
  }
  // item 6.26 -- per-adapter model override. Coerce malformed entries to
  // a no-op (drop the field rather than throw); the seed list is the
  // safe fallback. Strict shape: Record<string, string[]> with all-
  // string array members; anything else is silently ignored so a
  // hand-edited config can't break startup.
  if (config.agentModels !== undefined) {
    if (typeof config.agentModels !== "object" || Array.isArray(config.agentModels)) {
      delete config.agentModels;
    } else {
      const cleaned: Record<string, string[]> = {};
      for (const [adapter, models] of Object.entries(config.agentModels)) {
        if (typeof adapter !== "string" || !Array.isArray(models)) continue;
        const filtered = models
          .filter((m): m is string => typeof m === "string" && m.trim().length > 0)
          .map((m) => m.trim());
        if (filtered.length > 0) cleaned[adapter] = filtered;
      }
      config.agentModels = Object.keys(cleaned).length > 0 ? cleaned : undefined;
    }
  }
  return config;
}

function isValidReadinessGate(value: unknown): value is CfcfGlobalConfig["readinessGate"] {
  return value === "never" || value === "blocked" || value === "needs_refinement_or_blocked";
}
