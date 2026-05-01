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
 *      `require.resolve` (the published package; `npm install -g` puts
 *      it in the global node_modules tree). Returns the published
 *      version verbatim.
 *   2. **Dev-mode (workspace)**: walk up from `import.meta.url` looking
 *      for the **monorepo root** `package.json`, identified by its
 *      `workspaces` field (only present at the root). Returns
 *      `<root.version>-dev`. Workspace sub-packages
 *      (`packages/core/package.json` etc.) intentionally **don't carry
 *      a version field** — single source of truth lives at the repo
 *      root, and this resolver enforces it. Per-package versions were
 *      removed 2026-05-01 after they drifted (root said `0.16.4`, all
 *      sub-packages said `0.16.1`).
 *   3. **Last resort**: `"0.0.0-unknown"` -- the bundler somehow stripped
 *      every package.json (shouldn't happen in practice).
 *
 * Pre-5.5b the package was named `@cerefox/cfcf-cli`. The rename to
 * `@cerefox/codefactory` (2026-04-29; see
 * docs/research/npm-publish-5.5b-audit.md) is a hard cut: the old name
 * is NOT a fallback. Reasoning: keeping the legacy name as an
 * additional resolve target would leave a permanent attack surface if
 * the legacy name ever ended up published by someone else.
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
  try {
    const pkgPath = req.resolve("@cerefox/codefactory/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (typeof pkg.version === "string") return pkg.version;
  } catch { /* fall through */ }

  // 2. Dev mode: walk up from `import.meta.url` looking for the
  //    monorepo root `package.json`, identified by its `workspaces`
  //    field (only present at the root). From
  //    `packages/core/src/constants.ts` the root is at
  //    `../../../package.json`; one extra level is included as
  //    belt-and-suspenders for unusual layouts (bundled output, etc.).
  //    Workspace sub-packages skip naturally because they don't have
  //    `workspaces`.
  for (const candidate of [
    "../package.json",
    "../../package.json",
    "../../../package.json",
    "../../../../package.json",
  ]) {
    try {
      const url = new URL(candidate, import.meta.url).pathname;
      const pkg = JSON.parse(readFileSync(url, "utf8"));
      if (Array.isArray(pkg.workspaces) && typeof pkg.version === "string") {
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
