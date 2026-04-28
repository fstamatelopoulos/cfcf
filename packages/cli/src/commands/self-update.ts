/**
 * `cfcf self-update` -- thin wrapper that re-runs the installer in
 * upgrade mode against the latest published release.
 *
 * Per `docs/research/installer-design.md` §10.2 + §3.3 (upgrade flow).
 * The installer's untar step replaces `bin/` + `native/` + `MANIFEST`
 * + `uninstall.sh` and leaves `clio.db`, `models/`, `logs/` alone, so
 * `cfcf self-update` cannot lose user data by design.
 *
 * Sub-commands / flags:
 *   cfcf self-update                 # check + interactive upgrade
 *   cfcf self-update --check         # check only; print latest vs current; exit
 *   cfcf self-update --yes           # non-interactive; upgrade if newer is available
 *   cfcf self-update --version vX.Y.Z   # install a specific version
 *   cfcf self-update --base-url <url>   # override CFCF_BASE_URL
 *
 * Pre-conditions:
 *   - Running cfcf must be a real installed binary (not dev mode); we
 *     detect via the presence of `<install-dir>/MANIFEST`. Bails
 *     cleanly with a helpful message in dev mode.
 *   - Network access to fetch MANIFEST.txt + install.sh from the
 *     configured base URL.
 *
 * Web-UI new-version notification (server-side polling + a banner) is
 * tracked separately under plan item 6.20.
 */

import type { Command } from "commander";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const DEFAULT_RELEASES_REPO = "fstamatelopoulos/cfcf-releases";

interface ManifestSummary {
  cfcf?: string;
  sqlite?: string;
  "sqlite-vec"?: string;
  platform?: string;
  "built-at"?: string;
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

function getInstallDir(): string {
  return dirname(dirname(process.execPath));
}

function readLocalManifest(): ManifestSummary | null {
  const path = join(getInstallDir(), "MANIFEST");
  if (!existsSync(path)) return null;
  try {
    return parseManifest(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function defaultBaseUrl(version: string): string {
  if (version === "latest") {
    return `https://github.com/${DEFAULT_RELEASES_REPO}/releases/latest/download`;
  }
  return `https://github.com/${DEFAULT_RELEASES_REPO}/releases/download/${version}`;
}

async function fetchRemoteManifest(baseUrl: string): Promise<ManifestSummary> {
  const url = `${baseUrl}/MANIFEST.txt`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return parseManifest(await res.text());
}

async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export function registerSelfUpdateCommand(program: Command): void {
  program
    .command("self-update")
    .description(
      "Upgrade cfcf to the latest published release. Re-runs the installer in " +
      "upgrade mode -- preserves your Clio DB, embedder models, and logs.",
    )
    .option("--check", "Only check whether a newer version is available; don't install.")
    .option("--yes", "Non-interactive: upgrade without prompting if a newer version is available.")
    .option("--version <ver>", "Install a specific version instead of the latest (e.g. v0.10.0).")
    .option("--base-url <url>", "Override the install URL (otherwise GitHub Releases of cfcf-releases).")
    .action(async (opts) => {
      // 1. Sanity: must be running an installed binary, not dev mode.
      const local = readLocalManifest();
      if (!local || !local.cfcf) {
        console.error("cfcf self-update: no MANIFEST detected at " + join(getInstallDir(), "MANIFEST") + ".");
        console.error("This command only works on real installs (binary at <install-dir>/bin/cfcf).");
        console.error("In dev mode, just `git pull` + `bun install`.");
        process.exit(1);
      }

      // 2. Resolve target version + base URL.
      const target = opts.version ?? "latest";
      const baseUrl = opts.baseUrl ?? defaultBaseUrl(target);

      console.log(`Current: ${local.cfcf} (sqlite ${local.sqlite ?? "?"}, sqlite-vec ${local["sqlite-vec"] ?? "?"})`);
      console.log(`Target : ${target}  (resolving from ${baseUrl})`);
      console.log();

      // 3. Fetch the remote manifest. Resolves "latest" via the
      //    redirect target.
      let remote: ManifestSummary;
      try {
        remote = await fetchRemoteManifest(baseUrl);
      } catch (err) {
        console.error(`cfcf self-update: could not fetch remote MANIFEST: ${err instanceof Error ? err.message : String(err)}`);
        console.error("Common causes:");
        console.error("  - No network access");
        console.error(`  - Install URL not yet hosted (default points at ${DEFAULT_RELEASES_REPO})`);
        console.error("  - Try --base-url to point at an alternate host");
        process.exit(1);
      }

      console.log(`Latest available: ${remote.cfcf ?? "?"}`);
      console.log();

      // 4. Same-version short-circuit.
      if (remote.cfcf && remote.cfcf === local.cfcf) {
        console.log("✓ already on latest. No upgrade needed.");
        return;
      }

      if (opts.check) {
        if (remote.cfcf && remote.cfcf !== local.cfcf) {
          console.log(`A newer version is available: ${remote.cfcf}`);
          console.log("Run `cfcf self-update` (without --check) to install it.");
        }
        return;
      }

      // 5. Prompt unless --yes.
      if (!opts.yes) {
        const ok = await promptYesNo(
          `Upgrade from ${local.cfcf} → ${remote.cfcf ?? target}? Your Clio DB + models + logs will be preserved.`,
        );
        if (!ok) {
          console.log("Aborted.");
          return;
        }
      }

      // 6. Run `bun install -g <new-tarball>`. Bun's package manager
      //    handles the upgrade in place: replaces the cfcf package +
      //    runs postinstall hooks for the per-platform native package.
      //    Atomic from the user's perspective; if it fails the previous
      //    install stays intact.
      const versionToInstall = remote.cfcf ?? target;
      console.log(`\nLaunching installer for ${versionToInstall}...\n`);

      // Workaround for Bun bug: `bun install -g <local-tarball>` (and
      // arguably tarball URLs too) appends duplicate keys to
      // ~/.bun/install/global/package.json on every run instead of
      // overwriting. After enough self-updates the file accumulates
      // hundreds of dups and produces screens of `warn: Duplicate key`.
      // Fix: dedup by parse+stringify (JSON.parse keeps the LAST
      // occurrence so a round-trip yields a clean object). Best-effort.
      // Same fix lives in scripts/install.sh.
      try {
        const fs = await import("node:fs");
        const os = await import("node:os");
        const path = await import("node:path");
        const globalPkg = path.join(os.homedir(), ".bun", "install", "global", "package.json");
        if (fs.existsSync(globalPkg)) {
          const raw = fs.readFileSync(globalPkg, "utf-8");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const parsed = JSON.parse(raw) as Record<string, any>;
          fs.writeFileSync(globalPkg, JSON.stringify(parsed, null, 2) + "\n");
        }
      } catch { /* best-effort */ }

      // The release uploads `cfcf-<version>.tgz` next to MANIFEST.txt.
      // baseUrl already encodes either /releases/latest/download or
      // /releases/download/<tag>; just append the tarball name.
      const tarballUrl = `${baseUrl}/cfcf-${versionToInstall}.tgz`;
      const proc = spawn("bun", ["install", "-g", tarballUrl], {
        stdio: "inherit",
      });

      proc.on("exit", (code) => {
        if (code === 0) {
          console.log(`\n✓ upgraded to ${versionToInstall}.`);

          // Regenerate shell completion to pick up any new verbs in
          // the upgraded version. We invoke the NEW cfcf binary
          // (just installed) as a subprocess -- this process is the
          // OLD version and its completion module's tree-walking
          // would emit yesterday's verbs. Best-effort; a failure
          // here doesn't fail the upgrade. Same regeneration the
          // install.sh and postinstall paths run.
          try {
            const completion = spawn("cfcf", ["completion", "install"], { stdio: "inherit" });
            completion.on("exit", () => {
              printUpgradeFollowUp(versionToInstall);
            });
            completion.on("error", () => {
              printUpgradeFollowUp(versionToInstall);
            });
          } catch {
            printUpgradeFollowUp(versionToInstall);
          }
        } else {
          console.error(`\n✗ installer exited with code ${code}`);
          process.exit(code ?? 1);
        }
      });
    });
}

/**
 * Common follow-up messaging printed after a successful self-update,
 * regardless of whether the post-upgrade completion regeneration
 * succeeded. Kept in one place so the three exit-paths (completion
 * exit, completion error, completion-spawn-throw) stay consistent.
 */
function printUpgradeFollowUp(version: string): void {
  console.log(`  Run \`cfcf doctor\` to verify the new install.`);
  if (process.env.CFCF_INTERNAL_SERVE === undefined) {
    console.log(`  If cfcf server was running before the upgrade, restart it: cfcf server stop && cfcf server start`);
  }
  // version is in the success line above the call to this helper;
  // keep this signature unchanged so future text additions stay
  // localised. (Currently unused but included for forward-compat.)
  void version;
}
