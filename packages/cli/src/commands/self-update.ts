/**
 * `cfcf self-update` -- upgrade an installed cfcf to a newer release.
 *
 * Mirrors `scripts/install.sh`'s flow: `npm install -g
 * @cerefox/codefactory[@version]`. We use npm (not bun) because Bun
 * blocks postinstall scripts of transitive deps by default
 * (oven-sh/bun#4959), which would break onnxruntime-node + protobufjs
 * at install time. npm runs postinstalls by default; the upgrade is
 * friction-free. Bun is still cfcf's RUNTIME requirement; only the
 * install tool changed.
 *
 * The user's `~/.cfcf/` data dir (clio.db, logs, models) is never
 * touched -- only the global node_modules entry is swapped, so
 * self-update cannot lose user data by design.
 *
 * Sub-commands / flags:
 *   cfcf self-update                       check + interactive upgrade
 *   cfcf self-update --check               check only; print latest vs
 *                                          current and exit
 *   cfcf self-update --yes                 non-interactive; upgrade if
 *                                          newer is available
 *   cfcf self-update --version vX.Y.Z      install a specific version
 *   cfcf self-update --source npm|tarball  override the source detection
 *   cfcf self-update --base-url <url>      tarball mirror URL; implies
 *                                          --source tarball if --source
 *                                          isn't passed
 *
 * Env-var equivalents (CLI flag wins):
 *   CFCF_INSTALL_SOURCE                    "npm" | "tarball"
 *   CFCF_VERSION                           "latest" | "vX.Y.Z"
 *   CFCF_BASE_URL                          tarball mirror URL
 *   CFCF_RELEASES_REPO                     overrides the GitHub default
 *                                          tarball URL builder
 *
 * Pre-conditions:
 *   - Running cfcf must be a real installed binary (the published
 *     `@cerefox/codefactory` package.json must be reachable via
 *     require.resolve). In dev mode (running from source via `bun run
 *     dev:cli`) the command bails cleanly with a "git pull instead" hint.
 *   - Network access to npmjs.com (npm mode) or to CFCF_BASE_URL
 *     (tarball mode).
 *
 * Web-UI new-version notification (server-side polling + a banner) is
 * tracked separately under plan item 6.20.
 */

import type { Command } from "commander";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const NPM_PACKAGE = "@cerefox/codefactory";
const NPM_REGISTRY = "https://registry.npmjs.org";
const DEFAULT_RELEASES_REPO = "fstamatelopoulos/cfcf-releases";

type InstallSource = "npm" | "tarball";

interface CurrentInstall {
  name: string;
  version: string;
}

interface ResolvedTarget {
  source: InstallSource;
  version: string;        // "latest" or normalised "X.Y.Z" (no leading 'v')
  baseUrl?: string;       // tarball mode only
}

interface ManifestSummary {
  cfcf?: string;
  sqlite?: string;
  "sqlite-vec"?: string;
  "built-at"?: string;
}

// ── Current install detection ──────────────────────────────────────────

/**
 * Probe the published package via `require.resolve`. Same path the cfcf
 * runtime uses to read its own version (see packages/core/src/
 * constants.ts -- the legacy `@cerefox/cfcf-cli` name was intentionally
 * removed there for security reasons; we follow the same rule).
 */
function getCurrentInstall(): CurrentInstall | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createRequire } = require("node:module") as typeof import("node:module");
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve(`${NPM_PACKAGE}/package.json`);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (typeof pkg.version === "string") {
      return { name: pkg.name ?? NPM_PACKAGE, version: pkg.version };
    }
  } catch { /* not reachable -- dev mode or broken install */ }
  return null;
}

// ── Source + version resolution (mirrors install.sh) ───────────────────

export interface SelfUpdateOptions {
  check?: boolean;
  yes?: boolean;
  version?: string;
  source?: string;
  baseUrl?: string;
}

/**
 * Source/version resolution. Mirrors `scripts/install.sh`'s logic:
 *   • CLI flag wins over env var
 *   • CFCF_BASE_URL (or --base-url) without an explicit source implies
 *     tarball mode -- since the only reason to pass it is to point us at
 *     a tarball mirror, silently ignoring it in npm mode would surprise.
 *   • Default mode is npm.
 *
 * Exported so the resolution logic can be unit-tested without spawning
 * `bun install` or hitting the registry. Reads from `process.env` for
 * env-var inputs.
 */
export function resolveTarget(opts: SelfUpdateOptions): ResolvedTarget {
  // 1. Source: explicit flag > env var > inferred from base-url > npm.
  const sourceRaw =
    opts.source ??
    process.env.CFCF_INSTALL_SOURCE ??
    (opts.baseUrl || process.env.CFCF_BASE_URL ? "tarball" : "npm");
  if (sourceRaw !== "npm" && sourceRaw !== "tarball") {
    throw new Error(
      `Unknown install source: '${sourceRaw}' (expected 'npm' or 'tarball').`,
    );
  }
  const source = sourceRaw as InstallSource;

  // 2. Version: explicit flag > env > "latest". Strip leading 'v' for
  //    the npm-style internal form; the user can pass either.
  const versionRaw = opts.version ?? process.env.CFCF_VERSION ?? "latest";
  const version = versionRaw === "latest" ? "latest" : versionRaw.replace(/^v/, "");

  // 3. Tarball base URL: only used in tarball mode. Default points at
  //    GitHub Releases of the cfcf-releases repo (matches install.sh).
  let baseUrl: string | undefined;
  if (source === "tarball") {
    const releasesRepo = process.env.CFCF_RELEASES_REPO ?? DEFAULT_RELEASES_REPO;
    baseUrl =
      opts.baseUrl ??
      process.env.CFCF_BASE_URL ??
      (version === "latest"
        ? `https://github.com/${releasesRepo}/releases/latest/download`
        : `https://github.com/${releasesRepo}/releases/download/v${version}`);
  }

  return { source, version, baseUrl };
}

// ── Latest-version resolution ──────────────────────────────────────────

async function fetchNpmLatest(): Promise<string> {
  const url = `${NPM_REGISTRY}/${NPM_PACKAGE}/latest`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const data = (await res.json()) as { version?: string };
  if (typeof data.version !== "string") {
    throw new Error(`unexpected response shape from ${url} (no 'version' field)`);
  }
  return data.version;
}

async function fetchTarballManifest(baseUrl: string): Promise<ManifestSummary> {
  const url = `${baseUrl}/MANIFEST.txt`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return parseManifest(await res.text());
}

function parseManifest(text: string): ManifestSummary {
  const out: ManifestSummary = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k && v) (out as Record<string, string>)[k] = v;
  }
  return out;
}

// ── Platform detection (tarball mode only) ─────────────────────────────

function platformTag(): string | null {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64")   return "darwin-x64";
  if (process.platform === "linux"  && process.arch === "x64")   return "linux-x64";
  if (process.platform === "win32"  && process.arch === "x64")   return "windows-x64";
  return null;
}

// ── Bun-global dedup workaround ────────────────────────────────────────
// Same fix mirrored in scripts/install.sh -- see install.sh comments
// for the full rationale (Bun bug; harmless but spammy without dedup).

async function dedupBunGlobal(): Promise<void> {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const globalDir = path.join(os.homedir(), ".bun", "install", "global");
  const targets = [
    path.join(globalDir, "package.json"),
    path.join(globalDir, "bun.lock"),
  ];
  // Key-based dedup of consecutive same-key lines, keeping the LAST
  // occurrence (matches JSON.parse last-wins semantics). Bun's bug
  // appends the same key with a normalised value variant (e.g.
  // "/path/x.tgz" then "file:///path/x.tgz"), so line-dedup misses it.
  // 1-line lookahead: buffer one line, replace buf when next has same
  // key, flush otherwise. Works on bun.lock (not strict JSON; has JSON5
  // trailing commas) and package.json -- text-based, no parser needed.
  const keyRe = /^\s*"([^"]+)"\s*:/;
  for (const p of targets) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf-8");
      const lines = raw.split("\n");
      const out: string[] = [];
      let buf: string | null = null;
      let bufKey = "";
      for (const line of lines) {
        const m = line.match(keyRe);
        const k = m ? m[1] : "";
        if (buf !== null) {
          if (k !== "" && k === bufKey) { buf = line; bufKey = k; }
          else { out.push(buf); buf = line; bufKey = k; }
        } else { buf = line; bufKey = k; }
      }
      if (buf !== null) out.push(buf);
      fs.writeFileSync(p, out.join("\n"));
    } catch { /* best-effort */ }
  }
}

// ── Upgrade execution ──────────────────────────────────────────────────

/**
 * Run `npm install -g <spec>` and resolve when npm exits. Fails with a
 * non-zero exit code on npm failure. stdio inherited so the user sees
 * progress in real time.
 */
function runNpmInstall(spec: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("npm", ["install", "-g", spec], { stdio: "inherit" });
    proc.on("exit", (code) => resolve(code ?? 1));
  });
}

async function upgradeNpm(version: string): Promise<void> {
  const spec = version === "latest"
    ? `${NPM_PACKAGE}@latest`
    : `${NPM_PACKAGE}@${version}`;
  console.log(`\n→ npm install -g ${spec}\n`);
  // Bun-global dedup runs as best-effort cleanup of any prior bun-
  // installed cfcf state (users who installed via `bun install -g`
  // before may still have entries in ~/.bun/install/global/).
  await dedupBunGlobal();
  const code = await runNpmInstall(spec);
  await dedupBunGlobal();
  if (code !== 0) {
    console.error(`\n✗ installer exited with code ${code}`);
    process.exit(code);
  }
}

async function upgradeTarball(version: string, baseUrl: string): Promise<void> {
  const v = version.replace(/^v/, "");
  const tag = platformTag();
  if (!tag) {
    console.error(
      `cfcf self-update: tarball mode requires a supported platform; got ${process.platform}/${process.arch}.`,
    );
    process.exit(1);
  }
  // Native first, CLI second -- mirrors install.sh's tarball flow so
  // the CLI's optionalDependencies entry has a satisfying peer at
  // require.resolve time even when the npm registry can't be reached.
  const nativeUrl = `${baseUrl}/cerefox-codefactory-native-${tag}-${v}.tgz`;
  const cliUrl = `${baseUrl}/cfcf-${v}.tgz`;
  console.log(`\n→ npm install -g ${nativeUrl}\n`);
  await dedupBunGlobal();
  let code = await runNpmInstall(nativeUrl);
  await dedupBunGlobal();
  if (code !== 0) {
    console.error(`\n✗ native-package install exited with code ${code}`);
    process.exit(code);
  }
  console.log(`\n→ npm install -g ${cliUrl}\n`);
  code = await runNpmInstall(cliUrl);
  await dedupBunGlobal();
  if (code !== 0) {
    console.error(`\n✗ CLI install exited with code ${code}`);
    process.exit(code);
  }
}

// ── Post-upgrade follow-up ─────────────────────────────────────────────

/**
 * Regenerate shell completion + print follow-up hints. We invoke the
 * NEW cfcf binary as a subprocess so the upgraded verb tree is what
 * runs (this process is the OLD version still in memory).
 */
function postUpgrade(versionLabel: string): void {
  console.log(`\n✓ upgraded to ${versionLabel}.`);
  try {
    const completion = spawn("cfcf", ["completion", "install"], { stdio: "inherit" });
    completion.on("exit", () => printFollowUp());
    completion.on("error", () => printFollowUp());
  } catch {
    printFollowUp();
  }
}

function printFollowUp(): void {
  console.log(`  Run \`cfcf doctor\` to verify the new install.`);
  if (process.env.CFCF_INTERNAL_SERVE === undefined) {
    console.log(`  If cfcf server was running before the upgrade, restart it: cfcf server stop && cfcf server start`);
  }
}

// ── Prompt ─────────────────────────────────────────────────────────────

async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// ── Command registration ───────────────────────────────────────────────

export function registerSelfUpdateCommand(program: Command): void {
  program
    .command("self-update")
    .description(
      "Upgrade cfcf to the latest published release. Defaults to the npm registry; tarball mirrors via --source tarball or --base-url. Preserves your Clio DB, embedder models, and logs.",
    )
    .option("--check", "Only check whether a newer version is available; don't install.")
    .option("--yes", "Non-interactive: upgrade without prompting if a newer version is available.")
    .option("--version <ver>", "Install a specific version instead of the latest (e.g. v0.16.1).")
    .option("--source <kind>", "Install source: 'npm' (default) or 'tarball'.")
    .option("--base-url <url>", "Tarball mirror URL; implies --source tarball when --source isn't passed.")
    .action(async (opts: SelfUpdateOptions) => {
      // 1. Sanity: must be running an installed binary, not dev mode.
      const local = getCurrentInstall();
      if (!local) {
        console.error(
          `cfcf self-update: this command requires an installed cfcf, but ${NPM_PACKAGE}/package.json wasn't reachable from this binary.`,
        );
        console.error("Looks like you're running from source (dev mode). In dev mode, just `git pull` + `bun install`.");
        process.exit(1);
      }

      // 2. Resolve target source + version.
      let target: ResolvedTarget;
      try {
        target = resolveTarget(opts);
      } catch (err) {
        console.error(`cfcf self-update: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      console.log(`Current: ${local.name}@${local.version}`);
      console.log(`Source : ${target.source}${target.baseUrl ? ` (${target.baseUrl})` : ""}`);
      console.log(`Target : ${target.version === "latest" ? "latest" : `v${target.version}`}`);
      console.log();

      // 3. Resolve "latest" via the source-appropriate channel.
      let resolvedLatest = target.version;
      if (target.version === "latest") {
        try {
          resolvedLatest = target.source === "npm"
            ? await fetchNpmLatest()
            : (await fetchTarballManifest(target.baseUrl!)).cfcf?.replace(/^v/, "") ?? "";
          if (!resolvedLatest) {
            throw new Error("could not parse latest version from remote response");
          }
        } catch (err) {
          console.error(`cfcf self-update: could not fetch latest version: ${err instanceof Error ? err.message : String(err)}`);
          console.error("Common causes:");
          if (target.source === "npm") {
            console.error("  - No network access to registry.npmjs.org");
            console.error(`  - Package ${NPM_PACKAGE} not yet published (pre-publish phase)`);
            console.error("  - Try --source tarball or --base-url to use a mirror");
          } else {
            console.error("  - No network access");
            console.error(`  - Mirror URL not reachable (${target.baseUrl})`);
          }
          process.exit(1);
        }
      }

      console.log(`Latest available: ${resolvedLatest}`);
      console.log();

      // 4. Same-version short-circuit.
      if (resolvedLatest === local.version) {
        console.log("✓ already on latest. No upgrade needed.");
        return;
      }

      if (opts.check) {
        console.log(`A newer version is available: ${resolvedLatest}`);
        console.log("Run `cfcf self-update` (without --check) to install it.");
        return;
      }

      // 5. Prompt unless --yes.
      if (!opts.yes) {
        const ok = await promptYesNo(
          `Upgrade ${local.version} → ${resolvedLatest}? Your Clio DB + models + logs will be preserved.`,
        );
        if (!ok) {
          console.log("Aborted.");
          return;
        }
      }

      // 6. Run the source-appropriate install.
      if (target.source === "npm") {
        await upgradeNpm(resolvedLatest);
      } else {
        await upgradeTarball(resolvedLatest, target.baseUrl!);
      }

      // 7. Post-upgrade: completion regen + follow-up hints.
      postUpgrade(resolvedLatest);
    });
}
