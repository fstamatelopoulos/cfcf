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
 */
export function createDefaultConfig(availableAgents: string[]): CfcfGlobalConfig {
  // Pick dev agent: prefer claude-code if available, then codex
  const devAdapter =
    availableAgents.includes("claude-code")
      ? "claude-code"
      : availableAgents.includes("codex")
        ? "codex"
        : availableAgents[0] || "claude-code";

  // Pick judge agent: prefer a different agent from dev, then same
  const judgeAdapter =
    availableAgents.includes("codex") && devAdapter !== "codex"
      ? "codex"
      : availableAgents.includes("claude-code") && devAdapter !== "claude-code"
        ? "claude-code"
        : devAdapter;

  // Architect agent: prefer claude-code (typically needs strong reasoning)
  const architectAdapter =
    availableAgents.includes("claude-code")
      ? "claude-code"
      : devAdapter;

  // Documenter agent: prefer claude-code (strong writing ability)
  const documenterAdapter =
    availableAgents.includes("claude-code")
      ? "claude-code"
      : devAdapter;

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

  return {
    version: CONFIG_VERSION,
    devAgent: { adapter: devAdapter },
    judgeAgent: { adapter: judgeAdapter },
    architectAgent: { adapter: architectAdapter },
    documenterAgent: { adapter: documenterAdapter },
    maxIterations: DEFAULT_MAX_ITERATIONS,
    pauseEvery: DEFAULT_PAUSE_EVERY,
    availableAgents,
    permissionsAcknowledged: false,
    notifications: defaultNotifications,
  };
}

/**
 * Validate a config object. Returns the config if valid, throws if not.
 */
function validateConfig(config: CfcfGlobalConfig): CfcfGlobalConfig {
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
  return config;
}
