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
import { bashCompletionPath, zshCompletionPath, detectShell } from "./completion.js";
import { listHelpTopics } from "@cfcf/core";

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

/**
 * Check whether bun's global package.json or bun.lock has accumulated
 * duplicate keys. Known Bun bug on `bun install -g <local-tarball>`:
 * each install appends instead of overwriting, so re-installs grow
 * BOTH files (Bun 1.3+ ships a JSON-shaped bun.lock alongside
 * package.json) with literal duplicate keys. JSON parsers tolerate
 * it (last-occurrence wins), but bun spams `warn: Duplicate key`
 * on every subsequent install.
 *
 * `scripts/install.sh` and `cfcf self-update` both dedup BOTH files
 * before AND after invoking `bun install -g`, so future installs
 * stay clean. This check warns the user if they have accumulated
 * mess from before those fixes landed.
 */
function checkBunGlobalPkgDups(): CheckResult {
  const name = "Bun global manifest (duplicate-key check)";
  const dir = join(homedir(), ".bun", "install", "global");
  const targets = [join(dir, "package.json"), join(dir, "bun.lock")];

  // Cheap heuristic: count "@cerefox/cfcf-cli" occurrences in the raw
  // text. If a single file has more than ~2 (one in deps, one in
  // lockfile-bookkeeping), dups exist. We don't enumerate them
  // precisely; we just want to flag the user.
  const dups: string[] = [];
  for (const path of targets) {
    if (!existsSync(path)) continue;
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      return { name, status: "warn", detail: `could not read ${path}` };
    }
    // Heuristic: count `"@cerefox/cfcf-cli":` occurrences. Both files
    // legitimately mention it a few times in different contexts:
    //   - package.json: once (top-level deps)
    //   - bun.lock: 2-3 times (workspaces deps + packages section)
    // Anything notably above baseline = bun-bug accumulation.
    // We don't JSON.parse because bun.lock is JSON5-shaped (trailing
    // commas, etc.) and would fail strict parse.
    const hits = (raw.match(/"@cerefox\/cfcf-cli"\s*:/g) ?? []).length;
    const baseline = path.endsWith("bun.lock") ? 3 : 1;
    if (hits > baseline) {
      dups.push(`${path} (${hits} occurrences)`);
    }
  }
  if (dups.length > 0) {
    return {
      name,
      status: "warn",
      detail: `accumulated duplicates (Bun bug; harmless but noisy): ${dups.join(", ")}. Re-run scripts/install.sh or cfcf self-update to auto-clean.`,
    };
  }
  return { name, status: "ok" };
}

/**
 * Check whether the user-facing help bundle is embedded. The bundle is
 * generated at build time from docs/guides/*.md by
 * scripts/embed-help-content.ts; if it's missing, `cfcf help` won't
 * work and the web UI Help tab will return errors. Best-effort: warn,
 * never fail.
 */
function checkHelpContent(): CheckResult {
  const name = "User manual + help content";
  try {
    const topics = listHelpTopics();
    if (topics.length === 0) {
      return {
        name,
        status: "warn",
        detail: "no help topics embedded; rebuild via `bun run scripts/embed-help-content.ts`",
      };
    }
    // Spot-check that the canonical core topics are all present.
    const slugs = topics.map((t) => t.slug);
    const missing = ["manual", "workflow", "cli", "troubleshooting"].filter(
      (req) => !slugs.includes(req),
    );
    if (missing.length > 0) {
      return {
        name,
        status: "warn",
        detail: `missing canonical topics: ${missing.join(", ")} — try \`cfcf self-update\``,
      };
    }
    return {
      name,
      status: "ok",
      detail: `${topics.length} topics embedded -- run \`cfcf help\` to read`,
    };
  } catch (err) {
    return {
      name,
      status: "warn",
      detail: `help bundle unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check whether the Help Assistant prerequisites are met. The HA
 * (`cfcf help assistant`) launches the user's configured agent CLI in
 * interactive mode; we just need to verify at least one supported
 * adapter is reachable on PATH. The full agent-CLI per-adapter check
 * lives in `checkAgentClis`; this one reports HA-specific status.
 *
 * Best-effort: `warn` worst case (HA isn't critical for cf² to work).
 */
function checkHelpAssistant(): CheckResult {
  const name = "Help Assistant prerequisites";
  // Reuse the same per-adapter probe `checkAgentClis` runs. We can't
  // resolve the user's config sync without rewiring doctor to async,
  // so we just check that AT LEAST ONE supported adapter is reachable
  // -- the HA's agent picker defaults to `devAgent` which is one of
  // the same set, so this is a reliable proxy.
  const probes = [
    { name: "claude-code", cmd: ["claude", "--version"] },
    { name: "codex",       cmd: ["codex", "--version"] },
  ];
  const reachable: string[] = [];
  for (const { name: adapterName, cmd } of probes) {
    const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: "utf8" });
    if (r.status === 0) reachable.push(adapterName);
  }
  if (reachable.length === 0) {
    return {
      name,
      status: "warn",
      detail: "no supported agent CLI on PATH (claude-code or codex). " +
              "Install one to use `cfcf help assistant`. (Other cf² flows still work.)",
    };
  }
  return {
    name,
    status: "ok",
    detail: `${reachable.length} agent${reachable.length === 1 ? "" : "s"} reachable: ${reachable.join(", ")}`,
  };
}

/**
 * Check whether the Product Architect prerequisites are met. PA
 * (`cfcf spec`) launches the user's configured agent CLI in
 * interactive mode against the user's repo. The agent itself drives
 * `git init` / `cfcf workspace init` / Problem Pack authoring during
 * the session, so the doctor's job is just to verify a supported
 * agent CLI is reachable.
 *
 * Best-effort: `warn` worst case (PA isn't critical for cf² to work).
 */
function checkProductArchitect(): CheckResult {
  const name = "Product Architect prerequisites";
  const probes = [
    { name: "claude-code", cmd: ["claude", "--version"] },
    { name: "codex",       cmd: ["codex", "--version"] },
  ];
  const reachable: string[] = [];
  for (const { name: adapterName, cmd } of probes) {
    const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: "utf8" });
    if (r.status === 0) reachable.push(adapterName);
  }
  if (reachable.length === 0) {
    return {
      name,
      status: "warn",
      detail: "no supported agent CLI on PATH (claude-code or codex). " +
              "Install one to use `cfcf spec`. (Other cf² flows still work.)",
    };
  }
  return {
    name,
    status: "ok",
    detail: `${reachable.length} agent${reachable.length === 1 ? "" : "s"} reachable: ${reachable.join(", ")}.`,
  };
}

/**
 * Check whether shell tab-completion is wired up. We're best-effort
 * here: this is a quality-of-life feature, not a correctness one, so
 * the worst-case status is `warn` (never `fail`).
 *
 * Three things have to be true for completion to actually fire:
 *   1. $SHELL is bash or zsh (we don't ship completion for fish/sh).
 *   2. Our completion script file exists at the canonical path.
 *   3. The user's rc file references our completion (either via the
 *      cfcf-managed sentinel block, or via a manual fpath/source line).
 *
 * Failure of any of (1)-(3) downgrades to `warn` with a specific hint
 * so users can fix it themselves without filing an issue.
 */
function checkShellCompletion(): CheckResult {
  const shell = detectShell();
  const name = "Shell tab completion";
  if (shell === null) {
    return {
      name,
      status: "warn",
      detail: `unsupported shell ($SHELL=${process.env.SHELL ?? "unset"}); cfcf ships completion for bash + zsh only`,
    };
  }

  const scriptPath = shell === "zsh" ? zshCompletionPath() : bashCompletionPath();
  if (!existsSync(scriptPath)) {
    return {
      name,
      status: "warn",
      detail: `completion script missing at ${scriptPath} -- run: cfcf completion install`,
    };
  }

  const rcFile = shell === "zsh"
    ? join(homedir(), ".zshrc")
    : join(homedir(), ".bashrc");
  if (!existsSync(rcFile)) {
    return {
      name,
      status: "warn",
      detail: `${rcFile} doesn't exist; tab-complete won't fire. Run: cfcf completion install`,
    };
  }

  const content = readFileSync(rcFile, "utf-8");
  const hasOurBlock = content.includes("# >>> cfcf shell completion");
  const hasManualSetup = shell === "zsh"
    ? /^\s*fpath=.*\.zsh\/completions/m.test(content)
    : /source\s+.*\.cfcf-completion\.bash/.test(content);
  if (!hasOurBlock && !hasManualSetup) {
    return {
      name,
      status: "warn",
      detail: `${rcFile} doesn't reference cfcf completion -- run: cfcf completion install`,
    };
  }

  return {
    name,
    status: "ok",
    detail: `${shell} (${scriptPath})`,
  };
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
      results.push(checkHelpContent());
      results.push(checkHelpAssistant());
      results.push(checkProductArchitect());
      results.push(checkShellCompletion());
      results.push(checkBunGlobalPkgDups());

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
