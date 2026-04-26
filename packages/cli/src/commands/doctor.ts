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
import { dirname, join } from "node:path";
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

function getInstallDir(): string {
  // The binary at <install-dir>/bin/cfcf -> install dir is exec's parent.
  // In dev mode (running via bun) this resolves to the repo root, which is
  // fine; the checks below all degrade gracefully.
  return dirname(dirname(process.execPath));
}

function getNativeDir(): string {
  return process.env.CFCF_NATIVE_DIR ?? join(homedir(), ".cfcf", "native");
}

// ── Individual checks ───────────────────────────────────────────────────

function checkManifest(): CheckResult {
  const path = join(getInstallDir(), "MANIFEST");
  if (!existsSync(path)) {
    return {
      name: "MANIFEST present",
      status: "warn",
      detail: `${path} not found (dev mode? OK to ignore. End-user installs always ship this file.)`,
    };
  }
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.includes(":"));
    const parsed = Object.fromEntries(lines.map((l) => {
      const i = l.indexOf(":");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }));
    return {
      name: "MANIFEST present",
      status: "ok",
      detail: `cfcf=${parsed["cfcf"] ?? "?"}, sqlite=${parsed["sqlite"] ?? "?"}, sqlite-vec=${parsed["sqlite-vec"] ?? "?"}`,
    };
  } catch (err) {
    return {
      name: "MANIFEST present",
      status: "fail",
      detail: `parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function checkCustomSqlite(): CheckResult {
  const path = join(getNativeDir(), `libsqlite3${dlExt()}`);
  if (!existsSync(path)) {
    return {
      name: "Custom libsqlite3 present",
      status: "warn",
      detail: `${path} missing -- 6.15 sqlite-vec features will be disabled. Reinstall to repair.`,
    };
  }
  return { name: "Custom libsqlite3 present", status: "ok", detail: path };
}

function checkSqliteVec(): CheckResult {
  const path = join(getNativeDir(), `sqlite-vec${dlExt()}`);
  if (!existsSync(path)) {
    return {
      name: "sqlite-vec extension present",
      status: "warn",
      detail: `${path} missing -- 6.15 hybrid-vector search will be disabled until reinstall.`,
    };
  }
  return { name: "sqlite-vec extension present", status: "ok", detail: path };
}

function checkCustomSqliteLoadable(): CheckResult {
  // Try setCustomSQLite + open a trivial DB + read sqlite_version.
  // Pinned-version assertion is the proof the custom lib is the one in use.
  const lib = join(getNativeDir(), `libsqlite3${dlExt()}`);
  if (!existsSync(lib)) {
    return {
      name: "Custom libsqlite3 loads (PRAGMA library_version)",
      status: "warn",
      detail: "skipped -- libsqlite3 not present",
    };
  }
  try {
    // Dynamic import keeps the module-load cost off the dev path.
    // bun:sqlite is a builtin so no node_modules walk happens here.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    Database.setCustomSQLite(lib);
    const db = new Database(":memory:");
    const got = db.query<{ v: string }, []>("SELECT sqlite_version() AS v").get();
    db.close();
    return {
      name: "Custom libsqlite3 loads (PRAGMA library_version)",
      status: "ok",
      detail: `sqlite_version = ${got?.v}`,
    };
  } catch (err) {
    return {
      name: "Custom libsqlite3 loads (PRAGMA library_version)",
      status: "fail",
      detail: `setCustomSQLite/open failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function checkColocatedNodeModules(): CheckResult[] {
  const root = join(getInstallDir(), "bin", "node_modules");
  const required = [
    "@huggingface/transformers",
    "onnxruntime-node",
    "sharp",
  ];
  // If MANIFEST isn't present we're in dev mode (running via bun, not a
  // real installed binary). Downgrade missing-dep failures to warnings —
  // the dev path resolves these from packages/core/node_modules instead.
  const devMode = !existsSync(join(getInstallDir(), "MANIFEST"));
  return required.map((name) => {
    const p = join(root, name, "package.json");
    if (!existsSync(p)) {
      return {
        name: `Runtime dep colocated: ${name}`,
        status: devMode ? "warn" : "fail",
        detail: devMode
          ? "dev mode (running via bun); skipped"
          : `expected at ${p}`,
      };
    }
    try {
      const pkg = JSON.parse(readFileSync(p, "utf8"));
      return {
        name: `Runtime dep colocated: ${name}`,
        status: "ok",
        detail: `v${pkg.version}`,
      };
    } catch {
      return {
        name: `Runtime dep colocated: ${name}`,
        status: "ok",       // package.json present is enough; version optional
        detail: "(version not parseable)",
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
      results.push(checkManifest());
      results.push(checkCustomSqlite());
      results.push(checkSqliteVec());
      results.push(checkCustomSqliteLoadable());
      results.push(...checkColocatedNodeModules());
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
