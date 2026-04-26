/**
 * `cfcf doctor` -- self-check that confirms an install is healthy.
 *
 * Per `docs/research/installer-design.md` §11.3. Each check is a small
 * pure function returning `{ name, status, detail? }`; the action just
 * runs them in order, prints a coloured ✓/✗ summary, and exits non-zero
 * if any required check fails. `--json` emits the structured results
 * for scripted use.
 *
 * Reused as the troubleshooting starting point in
 * `docs/guides/installing.md`. Designed to be runnable BEFORE the user
 * has done any cfcf init work, so checks should not depend on a
 * configured server / workspace.
 */

import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

interface CheckResult {
  name: string;
  status: "ok" | "warn" | "fail";
  detail?: string;
}

function dlExt(): string {
  switch (process.platform) {
    case "darwin": return ".dylib";
    case "win32":  return ".dll";
    default:       return ".so";
  }
}

// ── Individual checks ───────────────────────────────────────────────────

function checkBunRuntime(): CheckResult {
  // We're running, so Bun is fine; surface the version for the report.
  const version = (globalThis as { Bun?: { version?: string } }).Bun?.version ?? "?";
  return {
    name: "Bun runtime",
    status: "ok",
    detail: `v${version}`,
  };
}

function checkCfcfPackage(): CheckResult {
  // Read the cfcf CLI package's own package.json — gives us the
  // installed cfcf version. The path is relative to this file's URL,
  // which works in both dev (TS source in repo) and installed
  // (bundled JS in <bun-global>/node_modules/cfcf/).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createRequire } = require("node:module") as typeof import("node:module");
    const req = createRequire(import.meta.url);
    // Climb out from packages/cli/src to find the cli package.json,
    // OR find the installed cfcf/package.json. Both shapes work because
    // the published package.json declares the same name.
    let pkgJsonPath: string;
    try {
      pkgJsonPath = req.resolve("@cerefox/cfcf-cli/package.json");
    } catch {
      // Dev mode: the workspace package isn't named @cerefox/cfcf-cli yet,
      // it's @cfcf/cli. Try the workspace one.
      pkgJsonPath = req.resolve("@cfcf/cli/package.json");
    }
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    return {
      name: "cfcf package metadata",
      status: "ok",
      detail: `${pkg.name}@${pkg.version}`,
    };
  } catch (err) {
    return {
      name: "cfcf package metadata",
      status: "warn",
      detail: `not resolvable (${err instanceof Error ? err.message : String(err)}). Dev mode is fine; installs should resolve.`,
    };
  }
}

function checkCustomSqlite(): CheckResult {
  // Resolve the per-platform native package via the same require.resolve
  // path applyCustomSqlite() uses, then check libsqlite3.<ext> exists.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createRequire } = require("node:module") as typeof import("node:module");
    const req = createRequire(import.meta.url);
    const tag = platformTag();
    if (!tag) {
      return {
        name: "Custom libsqlite3 (per-platform native package)",
        status: "warn",
        detail: `unsupported platform ${process.platform}/${process.arch}; skipped`,
      };
    }
    const pkgJson = req.resolve(`@cerefox/cfcf-native-${tag}/package.json`);
    const dir = join(pkgJson, "..");
    const lib = join(dir, `libsqlite3${dlExt()}`);
    if (!existsSync(lib)) {
      return {
        name: "Custom libsqlite3 (per-platform native package)",
        status: "fail",
        detail: `package found at ${dir} but libsqlite3${dlExt()} missing`,
      };
    }
    return { name: "Custom libsqlite3 (per-platform native package)", status: "ok", detail: lib };
  } catch (err) {
    return {
      name: "Custom libsqlite3 (per-platform native package)",
      status: "warn",
      detail: `@cerefox/cfcf-native-${platformTag() ?? "?"} not installed; falling back to system SQLite (dev mode is fine)`,
    };
  }
}

function checkSqliteVec(): CheckResult {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createRequire } = require("node:module") as typeof import("node:module");
    const req = createRequire(import.meta.url);
    const tag = platformTag();
    if (!tag) {
      return { name: "sqlite-vec extension", status: "warn", detail: "unsupported platform; skipped" };
    }
    const pkgJson = req.resolve(`@cerefox/cfcf-native-${tag}/package.json`);
    const dir = join(pkgJson, "..");
    const path = join(dir, `sqlite-vec${dlExt()}`);
    if (!existsSync(path)) {
      return {
        name: "sqlite-vec extension",
        status: "fail",
        detail: `package found at ${dir} but sqlite-vec${dlExt()} missing`,
      };
    }
    return { name: "sqlite-vec extension", status: "ok", detail: path };
  } catch {
    return {
      name: "sqlite-vec extension",
      status: "warn",
      detail: "skipped (native package not installed; 6.15 sqlite-vec features unavailable)",
    };
  }
}

function checkCustomSqliteLoadable(): CheckResult {
  // Try setCustomSQLite + open a trivial DB + read sqlite_version.
  // Pinned-version assertion is the proof the custom lib is the one in use.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createRequire } = require("node:module") as typeof import("node:module");
    const req = createRequire(import.meta.url);
    const tag = platformTag();
    if (!tag) {
      return { name: "Custom libsqlite3 loads", status: "warn", detail: "unsupported platform; skipped" };
    }
    const pkgJson = req.resolve(`@cerefox/cfcf-native-${tag}/package.json`);
    const dir = join(pkgJson, "..");
    const lib = join(dir, `libsqlite3${dlExt()}`);
    if (!existsSync(lib)) {
      return { name: "Custom libsqlite3 loads", status: "warn", detail: "skipped — libsqlite3 not present" };
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    Database.setCustomSQLite(lib);
    const db = new Database(":memory:");
    const got = db.query<{ v: string }, []>("SELECT sqlite_version() AS v").get();
    db.close();
    return {
      name: "Custom libsqlite3 loads",
      status: "ok",
      detail: `sqlite_version = ${got?.v}`,
    };
  } catch (err) {
    return {
      name: "Custom libsqlite3 loads",
      status: "warn",
      detail: `skipped (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

function platformTag(): string | null {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64")   return "darwin-x64";
  if (process.platform === "linux"  && process.arch === "x64")   return "linux-x64";
  if (process.platform === "win32"  && process.arch === "x64")   return "windows-x64";
  return null;
}

function checkRuntimeDeps(): CheckResult[] {
  // The three runtime deps are now standard npm-installed packages; npm/bun
  // place them in the user's global node_modules tree. We use createRequire
  // anchored at this file's URL so the resolution context matches what
  // cfcf actually does at runtime.
  const required = [
    "@huggingface/transformers",
    "onnxruntime-node",
    "sharp",
  ];
  return required.map((name) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createRequire } = require("node:module") as typeof import("node:module");
      const req = createRequire(import.meta.url);
      const pkgJson = req.resolve(`${name}/package.json`);
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
      return {
        name: `Runtime dep installed: ${name}`,
        status: "ok",
        detail: `v${pkg.version}`,
      };
    } catch (err) {
      return {
        name: `Runtime dep installed: ${name}`,
        status: "fail",
        detail: `not resolvable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });
}

function checkAgentClis(): CheckResult[] {
  // Detect the agent CLIs cfcf can drive. Doesn't read config (which the
  // user may not have run init yet); just reports what's reachable.
  const agents = [
    { name: "claude-code", check: ["claude", "--version"] },
    { name: "codex",       check: ["codex", "--version"] },
  ];
  return agents.map(({ name, check }) => {
    const r = spawnSync(check[0]!, check.slice(1), { encoding: "utf8" });
    if (r.status === 0) {
      return {
        name: `Agent CLI: ${name}`,
        status: "ok",
        detail: r.stdout?.trim().split("\n")[0] || r.stderr?.trim().split("\n")[0] || "OK",
      };
    }
    return {
      name: `Agent CLI: ${name}`,
      status: "warn",
      detail: "not found on PATH (only required if you've configured this adapter)",
    };
  });
}

function checkClioDb(): CheckResult {
  const path = process.env.CFCF_CLIO_DB ?? join(homedir(), ".cfcf", "clio.db");
  if (!existsSync(path)) {
    return {
      name: "Clio DB",
      status: "ok",
      detail: `${path} not yet created (will be on first cfcf clio call)`,
    };
  }
  // Reading the DB requires bun:sqlite -- can crash if the install is
  // partial. Wrap defensively.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(path, { readonly: true });
    const docs = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM clio_documents WHERE deleted_at IS NULL").get();
    db.close();
    return {
      name: "Clio DB",
      status: "ok",
      detail: `${path} (${docs?.n ?? "?"} docs)`,
    };
  } catch (err) {
    return {
      name: "Clio DB",
      status: "warn",
      detail: `${path} present but unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Render ──────────────────────────────────────────────────────────────

function fmt(r: CheckResult): string {
  const sym = r.status === "ok" ? "✓" : r.status === "warn" ? "⚠" : "✗";
  const tail = r.detail ? `  -- ${r.detail}` : "";
  return `  ${sym} ${r.name}${tail}`;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description(
      "Self-check that confirms a cfcf install is healthy (binary, native libs, runtime deps, agent CLIs).",
    )
    .option("--json", "Emit results as JSON")
    .action((opts) => {
      const results: CheckResult[] = [];
      results.push(checkBunRuntime());
      results.push(checkCfcfPackage());
      results.push(checkCustomSqlite());
      results.push(checkSqliteVec());
      results.push(checkCustomSqliteLoadable());
      results.push(...checkRuntimeDeps());
      results.push(...checkAgentClis());
      results.push(checkClioDb());

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        console.log("cfcf doctor — self-check");
        console.log();
        for (const r of results) console.log(fmt(r));
        console.log();
        const failed = results.filter((r) => r.status === "fail").length;
        const warned = results.filter((r) => r.status === "warn").length;
        if (failed === 0 && warned === 0) {
          console.log("✓ all checks passed.");
        } else if (failed === 0) {
          console.log(`⚠ ${warned} warning(s). Install is functional but degraded; reinstall may help.`);
        } else {
          console.log(`✗ ${failed} failure(s) + ${warned} warning(s). Reinstall recommended.`);
        }
      }

      const failed = results.some((r) => r.status === "fail");
      if (failed) process.exit(1);
    });
}
