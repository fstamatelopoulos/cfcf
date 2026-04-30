/**
 * Clio SQLite database handle + migrations runner.
 *
 * One `~/.cfcf/clio.db` file holds every workspace's memory across every
 * Clio Project. Path can be overridden via `CFCF_CLIO_DB` (same pattern as
 * `CFCF_CONFIG_DIR` / `CFCF_LOGS_DIR`).
 *
 * Uses Bun's built-in `bun:sqlite` driver, which ships FTS5. The optional
 * `applyCustomSqlite()` helper redirects bun:sqlite at the libsqlite3 the
 * 5.5 installer ships in `~/.cfcf/native/` — same engine on every
 * platform, with `loadExtension` enabled. Required for 6.15's sqlite-vec
 * integration on macOS where Apple's system SQLite has loadExtension
 * compiled out. No-ops gracefully in dev mode (no `~/.cfcf/native/`)
 * which is fine for everything Clio v1 does.
 */

import { Database } from "bun:sqlite";
import { join, dirname } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync } from "fs";

// Embedded migrations. Each `with { type: "text" }` import inlines the
// file contents as a string at build time (same pattern as templates.ts).
// Order of execution is the order of the MIGRATIONS array below.
//
// 2026-04-27: collapsed the prior 0001-0004 chain into a single
// 0001_initial.sql so a fresh install applies one self-contained schema
// instead of replaying historical migrations. The cascade-bug post-
// mortem (decisions-log.md 2026-04-27) records WHY the prior 0003
// rebuild migration existed; that lesson lives there now, not in a
// migration file. Future schema changes get their own NEW migration
// file (0002_*.sql, 0003_*.sql, ...) -- don't edit 0001 in place.
import migration_0001_initial from "./migrations/0001_initial.sql" with { type: "text" };

export interface ClioMigration {
  /** Filename used as a unique key in the `clio_migrations` tracking table. */
  filename: string;
  /** SQL body to execute (may contain multiple statements). */
  sql: string;
}

const MIGRATIONS: ClioMigration[] = [
  { filename: "0001_initial.sql", sql: migration_0001_initial },
];

/**
 * Resolve the Clio DB path. `CFCF_CLIO_DB` env var overrides; otherwise
 * `~/.cfcf/clio.db`. Cross-workspace state lives under `~/.cfcf/` (same
 * tier as `~/.cfcf/logs/`), not under the platform-specific config dir.
 */
export function getClioDbPath(): string {
  if (process.env.CFCF_CLIO_DB) return process.env.CFCF_CLIO_DB;
  return join(homedir(), ".cfcf", "clio.db");
}

/**
 * Map process.platform + process.arch → the cfcf platform tag used in
 * the per-platform native package name
 * (`@cerefox/codefactory-native-<tag>`; legacy
 * `@cerefox/cfcf-native-<tag>` pre-5.5b). Returns null on unsupported
 * platforms (handled gracefully — falls back to system SQLite).
 */
function getPlatformTag(): string | null {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64")   return "darwin-x64";
  if (process.platform === "linux"  && process.arch === "x64")   return "linux-x64";
  if (process.platform === "win32"  && process.arch === "x64")   return "windows-x64";
  return null;
}

/**
 * Map process.platform → the dynamic-library suffix that ships in the
 * per-platform native package.
 */
function dlExt(): string {
  switch (process.platform) {
    case "darwin": return ".dylib";
    case "win32":  return ".dll";
    default:       return ".so";
  }
}

/**
 * Resolve the directory where the per-platform native package lives.
 * In production, the package was installed as a transitive dep of the
 * cfcf CLI package and lives at
 *   <bun-global-prefix>/node_modules/@cerefox/codefactory-native-<platform>/
 * `require.resolve` is the canonical npm-ecosystem way to find a
 * dep's directory. CFCF_NATIVE_DIR env override stays for tests +
 * advanced users.
 *
 * Probes the new name first, then the legacy `@cerefox/cfcf-native-*`
 * (pre-5.5b) so binaries built against pre-rename source still find
 * their native peer if it's already installed.
 */
export function getCfcfNativeDir(): string | null {
  if (process.env.CFCF_NATIVE_DIR) return process.env.CFCF_NATIVE_DIR;
  const tag = getPlatformTag();
  if (!tag) return null;
  // Try to resolve the platform package's package.json to get its dir.
  // require.resolve walks the standard Node module path; in installed
  // mode it finds the colocated peer under the global node_modules
  // prefix. In dev mode (running via `bun run dev:cli`) the package
  // isn't installed; we return null and the caller falls back gracefully.
  const candidates = [
    `@cerefox/codefactory-native-${tag}`,
    `@cerefox/cfcf-native-${tag}`, // legacy pre-5.5b
  ];
  for (const name of candidates) {
    try {
      const { createRequire } = require("node:module") as typeof import("node:module");
      const requireFromHere = createRequire(import.meta.url);
      const pkgJson = requireFromHere.resolve(`${name}/package.json`);
      return join(pkgJson, ".."); // dirname of package.json
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * sqlite-vec's loadable extension — path inside the per-platform native
 * package. Used by 6.15's sqlite-vec integration; exposed here so Clio's
 * eventual `db.loadExtension(...)` call has a single source of truth.
 * The `entryPoint` is sqlite-vec's actual init symbol — bun:sqlite's
 * filename-based default doesn't match the actual `sqlite3_vec_init`
 * symbol, so callers must pass the entry point explicitly.
 */
export function getSqliteVecPath(): { path: string; entryPoint: string } | null {
  const dir = getCfcfNativeDir();
  if (!dir) return null;
  const path = join(dir, `sqlite-vec${dlExt()}`);
  if (!existsSync(path)) return null;
  return { path, entryPoint: "sqlite3_vec_init" };
}

let customSqliteApplied = false;

/**
 * Point bun:sqlite at the pinned `libsqlite3` shipped by
 * `@cerefox/codefactory-native-<platform>`. Required on macOS for
 * `db.loadExtension(...)` to work (Apple's system SQLite has
 * SQLITE_OMIT_LOAD_EXTENSION compiled in). Also gives every platform
 * the same SQLite version so behavioural differences (FTS5 tokeniser
 * internals, UPSERT semantics, etc.) don't sneak in.
 *
 * Idempotent: only the first call has effect; subsequent calls are
 * no-ops. **Must run before the first `new Database(...)`** — Bun's
 * runtime resolves the SQLite library lazily but binds it to the
 * first-opened DB, so a late call after a prior open is silently
 * ignored.
 *
 * Silent no-op when the platform native package isn't reachable:
 *   - dev mode (running via `bun run dev:cli`; package not installed)
 *   - unsupported platform (e.g. linux-arm64; falls back to system SQLite)
 *   - corrupt install (caught by `cfcf doctor`)
 */
export function applyCustomSqlite(): void {
  if (customSqliteApplied) return;
  customSqliteApplied = true;
  const dir = getCfcfNativeDir();
  if (!dir) return;
  const path = join(dir, `libsqlite3${dlExt()}`);
  if (!existsSync(path)) return;
  try {
    Database.setCustomSQLite(path);
  } catch (err) {
    // Surface to stderr but don't throw -- system SQLite is the
    // safe fallback. Clio v1 features (FTS5, JSON1) are in every
    // SQLite build; only sqlite-vec (6.15) requires loadExtension
    // enabled, and 6.15 will error loudly itself if loadExtension
    // doesn't work.
    process.stderr.write(
      `[clio] warning: setCustomSQLite("${path}") failed: ${err instanceof Error ? err.message : String(err)}\n` +
      `[clio] falling back to system SQLite. sqlite-vec features will be disabled until reinstall.\n`,
    );
  }
}

/**
 * Open the Clio DB, ensuring the parent directory exists and all
 * pending migrations have been applied. Callers should cache the
 * returned handle for the process lifetime rather than reopening.
 *
 * Pass `opts.path` to override the DB path (used by tests for isolated
 * temp DBs).
 */
export function openClioDb(opts?: { path?: string }): Database {
  applyCustomSqlite();           // no-op when no installer is present
  const path = opts?.path ?? getClioDbPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(path, { create: true });

  // Pragmas:
  //   journal_mode=WAL      -> concurrent readers + one writer; survives crashes better
  //   foreign_keys=ON       -> enforce FKs (off by default in SQLite)
  //   synchronous=NORMAL    -> good WAL balance of safety + speed
  //   busy_timeout=5000     -> wait up to 5s for a contended write lock
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA synchronous=NORMAL;
    PRAGMA busy_timeout=5000;
  `);

  runMigrations(db);
  return db;
}

/**
 * Apply any pending migrations. Creates the `clio_migrations` tracking
 * table on first call. Each migration is applied in a transaction so a
 * partial failure rolls back cleanly.
 *
 * **Migration flags** -- a migration whose first 4 lines contain the
 * marker `-- @migration-flags: disable-foreign-keys` is run with
 * `PRAGMA foreign_keys = OFF` set BEFORE the wrapping transaction. This
 * is required for any migration that drops + rebuilds a parent table
 * referenced by `ON DELETE CASCADE` foreign keys: SQLite fires CASCADE
 * actions on `DROP TABLE` regardless of `defer_foreign_keys=ON`, which
 * silently destroys child rows. `PRAGMA foreign_keys=OFF` only takes
 * effect outside an active transaction (per SQLite docs), so the flag
 * tells the runner to set it pre-BEGIN and restore post-COMMIT.
 *
 * Discovered 2026-04-27 when migration 0003 nuked a user's clio_chunks
 * via DROP TABLE clio_documents; see decisions-log.md.
 */
export function runMigrations(db: Database, migrations: ClioMigration[] = MIGRATIONS): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clio_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  const alreadyApplied = new Set<string>();
  const rows = db.query<{ filename: string }, []>("SELECT filename FROM clio_migrations").all();
  for (const r of rows) alreadyApplied.add(r.filename);

  const recordApplied = db.prepare("INSERT INTO clio_migrations (filename) VALUES (?)");

  for (const migration of migrations) {
    if (alreadyApplied.has(migration.filename)) continue;

    const disableFks = /-- @migration-flags:.*\bdisable-foreign-keys\b/.test(
      migration.sql.split("\n").slice(0, 4).join("\n"),
    );

    if (disableFks) {
      // SQLite: PRAGMA foreign_keys is a no-op inside a transaction.
      // Disable + re-enable bracket the transaction so DROP TABLE on a
      // parent doesn't trigger ON DELETE CASCADE on children.
      db.exec("PRAGMA foreign_keys = OFF");
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      recordApplied.run(migration.filename);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      if (disableFks) {
        try { db.exec("PRAGMA foreign_keys = ON"); } catch { /* best-effort */ }
      }
      throw new Error(
        `Clio migration ${migration.filename} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (disableFks) {
      db.exec("PRAGMA foreign_keys = ON");
    }
  }
}

/**
 * List the migrations that have been applied to this DB. Useful for
 * `cfcf clio stats` output + debugging.
 */
export function listAppliedMigrations(db: Database): string[] {
  const rows = db.query<{ filename: string; applied_at: string }, []>(
    "SELECT filename, applied_at FROM clio_migrations ORDER BY filename",
  ).all();
  return rows.map((r) => `${r.filename} @ ${r.applied_at}`);
}
