/**
 * Constants and defaults for cfcf.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/** Default server port */
export const DEFAULT_PORT = 7233;

/**
 * Read the running cfcf version once at module load. Single source of
 * truth: every caller (`cfcf --version`, `cfcf server start`,
 * `/api/health`, `/api/status`) ends up agreeing.
 *
 * Resolution order (first match wins):
 *   1. **Installed mode**: `@cerefox/codefactory/package.json` via
 *      `require.resolve` (the published package; `bun install -g` puts
 *      it in the global node_modules tree). Returns the published
 *      version verbatim.
 *   2. **Bundled relative**: `../package.json` next to `import.meta.url`.
 *      In a bundled install (`dist/cfcf.js` → `package.json` is the
 *      sibling of `dist/`) this is the same file as #1; this branch
 *      catches the case where the package isn't reachable as a named
 *      import (e.g. an unusual install layout).
 *   3. **Dev-mode workspace**: `../../package.json` (from
 *      `packages/core/src/constants.ts` → `packages/core/package.json`).
 *      Bun workspaces don't materialize @cfcf/core in node_modules, so
 *      `require.resolve("@cfcf/core/package.json")` doesn't work. The
 *      relative-path fallback is the dev-mode escape hatch. Suffixed
 *      `-dev` so the binary is visibly distinguishable from a release.
 *   4. **Last resort**: `"0.0.0-unknown"` -- the bundler somehow stripped
 *      every package.json (shouldn't happen in practice).
 *
 * Pre-5.5b the installed name was `@cerefox/cfcf-cli`. Renamed to
 * `@cerefox/codefactory` 2026-04-29 (see
 * docs/research/npm-publish-5.5b-audit.md). The legacy name is kept as
 * a transitional fallback so a binary built against pre-rename source
 * trees still resolves cleanly.
 *
 * Previous behaviour was a hardcoded `"0.10.0"` constant that drifted
 * from the actual installed version (caught 2026-04-27: `cfcf
 * --version` showed "0.0.0-dev" but `cfcf server start` showed
 * "v0.10.0").
 */
function resolveVersion(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createRequire } = require("node:module") as typeof import("node:module");
  const req = createRequire(import.meta.url);

  // 1. Installed mode: the published name is reachable via the named
  //    import. Bun workspaces don't materialise `@cfcf/*` in
  //    node_modules so this branch only fires post-`bun install -g`.
  //    Try the new name first, then the legacy name (transitional
  //    fallback for any binaries still built against the pre-5.5b
  //    package layout).
  for (const pkgName of ["@cerefox/codefactory", "@cerefox/cfcf-cli"]) {
    try {
      const pkgPath = req.resolve(`${pkgName}/package.json`);
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (typeof pkg.version === "string") return pkg.version;
    } catch { /* fall through to next candidate */ }
  }

  // 2. Walk up from `import.meta.url` looking for the nearest
  //    package.json. The relative path differs between bundled (dist/)
  //    and unbundled (src/) layouts -- we try a few candidates.
  //    Discriminate by the `name` field: `@cerefox/codefactory` (or the
  //    legacy `@cerefox/cfcf-cli`) = installed; `@cfcf/*` = dev
  //    workspace (suffix `-dev`). This catches odd installs where the
  //    named-import path didn't resolve, and gives `bun run dev:cli` a
  //    clean dev-mode label.
  for (const candidate of ["../package.json", "../../package.json", "../../../package.json"]) {
    try {
      const url = new URL(candidate, import.meta.url).pathname;
      const pkg = JSON.parse(readFileSync(url, "utf8"));
      if (typeof pkg.version !== "string") continue;
      if (pkg.name === "@cerefox/codefactory" || pkg.name === "@cerefox/cfcf-cli") {
        return pkg.version;
      }
      if (typeof pkg.name === "string" && pkg.name.startsWith("@cfcf/")) {
        return `${pkg.version}-dev`;
      }
    } catch { /* try next candidate */ }
  }

  return "0.0.0-unknown";
}

/** cfcf version (resolved once at module load; see resolveVersion above). */
export const VERSION = resolveVersion();

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
