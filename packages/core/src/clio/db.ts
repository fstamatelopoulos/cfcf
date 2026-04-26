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
// Order of execution is the order of this array.
import migration_0001_initial from "./migrations/0001_initial.sql" with { type: "text" };
import migration_0002_active_embedder from "./migrations/0002_active_embedder.sql" with { type: "text" };

export interface ClioMigration {
  /** Filename used as a unique key in the `clio_migrations` tracking table. */
  filename: string;
  /** SQL body to execute (may contain multiple statements). */
  sql: string;
}

const MIGRATIONS: ClioMigration[] = [
  { filename: "0001_initial.sql", sql: migration_0001_initial },
  { filename: "0002_active_embedder.sql", sql: migration_0002_active_embedder },
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
 * Resolve the directory where the installer drops `libsqlite3.<ext>`
 * + `sqlite-vec.<ext>`. Defaults to `~/.cfcf/native/`; override via
 * `CFCF_NATIVE_DIR` (mostly used by integration tests).
 */
export function getCfcfNativeDir(): string {
  if (process.env.CFCF_NATIVE_DIR) return process.env.CFCF_NATIVE_DIR;
  return join(homedir(), ".cfcf", "native");
}

/**
 * Map process.platform → the dynamic-library suffix that the installer
 * uses for both libsqlite3 and sqlite-vec.
 */
function dlExt(): string {
  switch (process.platform) {
    case "darwin": return ".dylib";
    case "win32":  return ".dll";
    default:       return ".so";
  }
}

/**
 * sqlite-vec's loadable extension — full path under `~/.cfcf/native/`.
 * Used by 6.15's sqlite-vec integration; exposed here so Clio's eventual
 * `db.loadExtension(...)` call has a single source of truth for the
 * path. The `entryPoint` is sqlite-vec's actual init symbol — the
 * filename-based default that bun:sqlite computes (`sqlite3_sqlitevec_init`)
 * doesn't match (the symbol is `sqlite3_vec_init`), so callers must pass
 * the entry point explicitly.
 */
export function getSqliteVecPath(): { path: string; entryPoint: string } | null {
  const dir = getCfcfNativeDir();
  const path = join(dir, `sqlite-vec${dlExt()}`);
  if (!existsSync(path)) return null;
  return { path, entryPoint: "sqlite3_vec_init" };
}

let customSqliteApplied = false;

/**
 * Point bun:sqlite at the pinned `libsqlite3` shipped by the 5.5
 * installer. Required on macOS for `db.loadExtension(...)` to work
 * (Apple's system SQLite has SQLITE_OMIT_LOAD_EXTENSION compiled in).
 * Also gives every platform the same SQLite version so behavioural
 * differences (FTS5 tokeniser internals, UPSERT semantics, etc.) don't
 * sneak in.
 *
 * Idempotent: only the first call has effect; subsequent calls are
 * no-ops. **Must run before the first `new Database(...)`** — Bun's
 * runtime resolves the SQLite library lazily but binds it to the
 * first-opened DB, so a late call after a prior open is silently
 * ignored.
 *
 * Silent no-op when `~/.cfcf/native/libsqlite3.<ext>` is absent:
 *   - dev mode (no installer ever ran)
 *   - user manually deleted `~/.cfcf/native/`
 *   - new install where Database has somehow been opened before this
 *     hook ran (programmer error worth surfacing — but still
 *     non-fatal here; the call site just gets system SQLite back,
 *     which works for everything Clio v1 does)
 */
export function applyCustomSqlite(): void {
  if (customSqliteApplied) return;
  customSqliteApplied = true;
  const path = join(getCfcfNativeDir(), `libsqlite3${dlExt()}`);
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

    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      recordApplied.run(migration.filename);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(
        `Clio migration ${migration.filename} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
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
