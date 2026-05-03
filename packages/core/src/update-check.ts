/**
 * `update-check` -- the first JobScheduler-registered job (item 6.20).
 *
 * Polls npmjs.com for the latest published version of @cerefox/codefactory
 * and, if it's newer than the running cfcf, drops a flag file at
 * `~/.cfcf/update-available.json`. The web UI banner + CLI lifecycle banner
 * + `cfcf doctor` all read that file -- nothing else triggers any auto-
 * update; the user always runs `cfcf self-update` explicitly.
 *
 * Default interval: 24 h. Network failures are non-fatal: the JobScheduler
 * records `lastError` and we re-try on the next tick.
 *
 * The npm registry is the single source of truth for "what's published".
 * We intentionally don't fall back to GitHub Releases automatically: if the
 * registry call fails, we want the user to know (via doctor / scheduler-
 * state.json), not silently fall back to a different source that could
 * report a different "latest" (e.g. a tag-only release like 0.17.1 that
 * was deliberately not pushed to npm).
 */

import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Job } from "./scheduler/index.js";

const NPM_PACKAGE = "@cerefox/codefactory";
const NPM_LATEST_URL = `https://registry.npmjs.org/${NPM_PACKAGE}/latest`;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 h
const FETCH_TIMEOUT_MS = 5_000;

/** On-disk shape of `~/.cfcf/update-available.json`. */
export interface UpdateAvailableFile {
  /** The cfcf version that was running when the check fired. */
  currentVersion: string;
  /** The newer version found on npm. Always > currentVersion at write time. */
  latestVersion: string;
  /** ISO timestamp of the check. */
  checkedAt: string;
  /** GitHub release notes URL for `latestVersion` (best-effort). */
  releaseNotesUrl?: string;
}

/**
 * Default location of the update-available flag file. Honours
 * `CFCF_UPDATE_FILE` for tests (and for power users who want to redirect
 * cfcf state out of the home directory).
 */
export function defaultUpdateFilePath(): string {
  if (process.env.CFCF_UPDATE_FILE) return process.env.CFCF_UPDATE_FILE;
  return join(homedir(), ".cfcf", "update-available.json");
}

// ── Semver compare ─────────────────────────────────────────────────────

/**
 * Compare two semver-shaped version strings (no prerelease support; we don't
 * publish prereleases to npm). Strips leading `v`, ignores anything after
 * the first `-` (so `0.17.1-dev` is treated as `0.17.1`). Returns -1 / 0 / 1.
 *
 * Exported for unit tests.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parse = (s: string): [number, number, number] => {
    const stripped = s.replace(/^v/, "").split("-")[0];
    const parts = stripped.split(".").map((p) => {
      const n = parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const [a1, a2, a3] = parse(a);
  const [b1, b2, b3] = parse(b);
  if (a1 !== b1) return a1 < b1 ? -1 : 1;
  if (a2 !== b2) return a2 < b2 ? -1 : 1;
  if (a3 !== b3) return a3 < b3 ? -1 : 1;
  return 0;
}

// ── Network ────────────────────────────────────────────────────────────

async function fetchNpmLatest(): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(NPM_LATEST_URL, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${NPM_LATEST_URL}`);
    const data = (await res.json()) as { version?: string };
    if (typeof data.version !== "string") {
      throw new Error(`unexpected response shape from ${NPM_LATEST_URL}`);
    }
    return data.version;
  } finally {
    clearTimeout(t);
  }
}

// ── Flag-file helpers ──────────────────────────────────────────────────

async function writeFlag(file: string, body: UpdateAvailableFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(body, null, 2) + "\n", "utf-8");
}

async function deleteFlag(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }
    throw err;
  }
}

/**
 * Local-only stale-flag cleanup. Called by the server at startup (before
 * the scheduler does its 24h tick) so an upgrade made within 24h of the
 * last check doesn't leave the flag file lingering on disk.
 *
 * No network call -- the canonical "is there something newer?" question is
 * still the JobScheduler's job. This just garbage-collects the file when
 * `latestVersion <= currentVersion` (the running cfcf has caught up).
 *
 * Returns `true` if a stale file was found + deleted; `false` if no file
 * existed or the file is still valid (latest > current).
 */
export async function clearStaleUpdateFlag(
  currentVersion: string,
  filePath: string = defaultUpdateFilePath(),
): Promise<boolean> {
  const flag = await readUpdateAvailable(filePath);
  if (!flag) return false;
  if (compareSemver(flag.latestVersion, currentVersion) > 0) {
    // Still valid -- the registered version is genuinely newer. Leave it.
    return false;
  }
  try {
    await unlink(filePath);
    return true;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    // Best-effort cleanup -- never crash startup over the flag file.
    return false;
  }
}

/**
 * Read the on-disk flag file, returning `null` if absent or unreadable.
 * Used by the web UI route (`GET /api/update-status`), the CLI lifecycle
 * banner, and `cfcf doctor`.
 */
export async function readUpdateAvailable(
  filePath: string = defaultUpdateFilePath(),
): Promise<UpdateAvailableFile | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<UpdateAvailableFile>;
    if (
      typeof parsed.currentVersion !== "string" ||
      typeof parsed.latestVersion !== "string" ||
      typeof parsed.checkedAt !== "string"
    ) {
      return null;
    }
    return {
      currentVersion: parsed.currentVersion,
      latestVersion: parsed.latestVersion,
      checkedAt: parsed.checkedAt,
      releaseNotesUrl: typeof parsed.releaseNotesUrl === "string" ? parsed.releaseNotesUrl : undefined,
    };
  } catch {
    return null;
  }
}

// ── Job factory ────────────────────────────────────────────────────────

export interface UpdateCheckOptions {
  /** Running cfcf version. Inject so the function is pure-testable. */
  currentVersion: string;
  /** Default 24 h. */
  intervalMs?: number;
  /** Override the flag-file path (for tests). */
  filePath?: string;
  /** Override the network fetch (for tests). Returns the latest version string. */
  fetchLatest?: () => Promise<string>;
  /**
   * Optional GitHub releases URL builder for `releaseNotesUrl`. Default
   * builds `https://github.com/fstamatelopoulos/cfcf/releases/tag/v<latest>`.
   * Set to `null` to omit the field entirely.
   */
  releaseNotesUrl?: ((latest: string) => string) | null;
}

const DEFAULT_RELEASE_NOTES_URL = (latest: string) =>
  `https://github.com/fstamatelopoulos/cfcf/releases/tag/v${latest}`;

/**
 * Run one update check synchronously (resolves on completion). Exported so
 * tests + `cfcf doctor --refresh` style flows can drive a single check
 * without spinning up the scheduler.
 */
export async function runUpdateCheck(opts: UpdateCheckOptions): Promise<void> {
  const file = opts.filePath ?? defaultUpdateFilePath();
  const buildUrl =
    opts.releaseNotesUrl === null
      ? null
      : opts.releaseNotesUrl ?? DEFAULT_RELEASE_NOTES_URL;
  const fetcher = opts.fetchLatest ?? fetchNpmLatest;
  const latest = await fetcher();
  if (compareSemver(latest, opts.currentVersion) > 0) {
    await writeFlag(file, {
      currentVersion: opts.currentVersion,
      latestVersion: latest,
      checkedAt: new Date().toISOString(),
      releaseNotesUrl: buildUrl ? buildUrl(latest) : undefined,
    });
  } else {
    // We're caught up (running == latest, or somehow ahead via tag-only
    // release like 0.17.1) -- clear any stale flag from a previous check
    // so the banner disappears post-self-update.
    await deleteFlag(file);
  }
}

/**
 * Build the JobScheduler-registered job. The server registers this once at
 * startup; the scheduler's restart-resilient state means a fresh server
 * usually re-checks immediately (catching missed-tick across restart).
 */
export function makeUpdateCheckJob(opts: UpdateCheckOptions): Job {
  return {
    id: "update-check",
    intervalMs: opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    fn: () => runUpdateCheck(opts),
  };
}
