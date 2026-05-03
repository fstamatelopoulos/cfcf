/**
 * CLI lifecycle-command update banner (item 6.20).
 *
 * The harness intentionally limits this banner to the small set of
 * "lifecycle" commands -- `init`, `server`, `status`, `doctor`, and
 * `self-update --check`. Every-invocation prints would add 5–20 ms FS-read
 * overhead to scripted operations and become noise users learn to filter
 * out; lifecycle commands are the ones a human runs interactively when
 * they're already paying attention to cfcf, so a one-line nudge there has
 * the best signal-to-noise.
 *
 * Suppression: `CFCF_NO_UPDATE_NOTICE=1` env var, OR `notifyUpdates: false`
 * in the global config (read sync; ~5 ms cost on lifecycle commands only).
 *
 * Output goes to stderr so the banner never contaminates stdout-based
 * scripted use of these commands (notably `cfcf status --json` /
 * `cfcf doctor --json`).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareSemver, defaultUpdateFilePath, getConfigPath, VERSION } from "@cfcf/core";

const LIFECYCLE_COMMANDS = new Set(["init", "server", "status", "doctor"]);

function isLifecycleInvocation(argv: string[]): boolean {
  // argv[0]=bun, argv[1]=cfcf script, argv[2]=verb. The banner gate is
  // verb-only; sub-commands of lifecycle verbs (`server start`, `server
  // stop`, `init --force`, …) all qualify because the user is paying
  // attention to lifecycle state when they typed the verb.
  const verb = argv[2];
  if (!verb) return false;
  if (LIFECYCLE_COMMANDS.has(verb)) return true;
  // Special case per the locked design: `self-update --check` is opt-in
  // for the banner because the user is explicitly asking about install
  // state. The bare `self-update` flow already prints its own latest-vs-
  // current diff, so we skip the duplicate banner there.
  if (verb === "self-update" && argv.includes("--check")) return true;
  return false;
}

function userOptedOut(): boolean {
  if (process.env.CFCF_NO_UPDATE_NOTICE === "1") return true;
  // Sync config read: keep the banner cost bounded at ~5 ms even when the
  // config file is large. Skip silently on any error -- a missing config
  // (pre-init) just means we fall through to "default behaviour" (banner
  // enabled), and a corrupt one shouldn't break the CLI verb the user is
  // trying to run.
  try {
    const raw = readFileSync(getConfigPath(), "utf-8");
    const cfg = JSON.parse(raw) as { notifyUpdates?: boolean };
    if (cfg.notifyUpdates === false) return true;
  } catch { /* fall through */ }
  return false;
}

interface UpdateAvailableLite {
  latestVersion: string;
  currentVersion?: string;
}

function readFlagSync(): UpdateAvailableLite | null {
  // Inline sync read (the @cfcf/core `readUpdateAvailable` helper is async,
  // and we don't want any await cost on the CLI hot path before commander
  // parses). Same shape, same path.
  const path = process.env.CFCF_UPDATE_FILE ?? join(homedir(), ".cfcf", "update-available.json");
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<UpdateAvailableLite>;
    if (typeof parsed.latestVersion !== "string") return null;
    return {
      latestVersion: parsed.latestVersion,
      currentVersion: typeof parsed.currentVersion === "string" ? parsed.currentVersion : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Detect whether stderr can render ANSI color escapes. Conservative: only
 * colorize when stderr is a real TTY AND the user hasn't opted out via
 * NO_COLOR (the de-facto cross-tool standard, https://no-color.org) AND
 * the terminal isn't the legacy "dumb" type. When in doubt, skip colors --
 * scripted users (`cfcf status 2>&1 | tee log`) get clean text.
 *
 * Exported for unit tests.
 */
export function stderrSupportsColor(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = !!process.stderr.isTTY,
): boolean {
  if (!isTTY) return false;
  if (env.NO_COLOR) return false;
  if (env.TERM === "dumb") return false;
  return true;
}

/**
 * Pure formatter so the test layer doesn't need to capture stderr or fake
 * `getConfigPath` / FS state. Returns the line to print, or `null` if no
 * banner should be shown for the given inputs.
 *
 * `withColor` controls ANSI escape rendering: bold + bright yellow on the
 * banner so a TTY user sees it clearly above the verb's own output, plain
 * text when the destination doesn't support colors.
 *
 * Exported for unit tests.
 */
export function formatBannerLine(
  argv: string[],
  flag: UpdateAvailableLite | null,
  runningVersion: string,
  optedOut: boolean,
  withColor: boolean = false,
): string | null {
  if (!isLifecycleInvocation(argv)) return null;
  if (optedOut) return null;
  if (!flag) return null;
  if (compareSemver(flag.latestVersion, runningVersion) <= 0) return null;
  const text = `⏫ cfcf v${flag.latestVersion} available; run \`cfcf self-update --yes\``;
  if (!withColor) return text;
  // ESC[1m  = bold; ESC[33m = yellow; ESC[0m = reset.
  return `\x1b[1;33m${text}\x1b[0m`;
}

/**
 * Hot-path entry point. Called from `packages/cli/src/index.ts` once at
 * startup. No-ops on every non-lifecycle verb. Writes to stderr. Never
 * throws -- a banner failure must not block the CLI verb itself.
 */
export function maybePrintUpdateBanner(): void {
  try {
    if (!isLifecycleInvocation(process.argv)) return;
    if (userOptedOut()) return;
    const flag = readFlagSync();
    const line = formatBannerLine(process.argv, flag, VERSION, false, stderrSupportsColor());
    if (line) {
      process.stderr.write(line + "\n");
    }
  } catch {
    // Best-effort: banner failure never blocks the actual verb.
  }
}

// Test helpers (re-exported only for the test file).
export const __test__ = {
  isLifecycleInvocation,
  defaultUpdateFilePath,
};
