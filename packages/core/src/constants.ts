/**
 * Constants and defaults for cfcf.
 */

import { join } from "path";
import { homedir } from "os";

/** Default server port */
export const DEFAULT_PORT = 7233;

/** cfcf version (updated on release) */
export const VERSION = "0.7.5";

/** Config file format version */
export const CONFIG_VERSION = 1;

/** Default max iterations per run */
export const DEFAULT_MAX_ITERATIONS = 10;

/** Default pause cadence (0 = no pauses) */
export const DEFAULT_PAUSE_EVERY = 0;

/**
 * Get the platform-specific config directory for cfcf.
 *
 * - Linux: ~/.config/cfcf/
 * - macOS: ~/Library/Application Support/cfcf/
 * - Windows: %APPDATA%/cfcf/
 *
 * Override with CFCF_CONFIG_DIR env var.
 */
export function getConfigDir(): string {
  if (process.env.CFCF_CONFIG_DIR) {
    return process.env.CFCF_CONFIG_DIR;
  }

  const platform = process.platform;

  if (platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "cfcf");
  }

  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "cfcf");
  }

  // Linux and others: XDG_CONFIG_HOME or ~/.config
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "cfcf");
}

/**
 * Get the cfcf logs directory (for agent stdout/stderr backups).
 *
 * Stored under ~/.cfcf/logs/ on all platforms.
 * Override with CFCF_LOGS_DIR env var.
 */
export function getLogsDir(): string {
  if (process.env.CFCF_LOGS_DIR) {
    return process.env.CFCF_LOGS_DIR;
  }
  return join(homedir(), ".cfcf", "logs");
}

/** Config file name */
export const CONFIG_FILENAME = "config.json";

/** Supported agent adapter names */
export const SUPPORTED_AGENTS = ["claude-code", "codex"] as const;

export type SupportedAgent = (typeof SUPPORTED_AGENTS)[number];
