/**
 * Clio SQLite database handle + migrations runner.
 *
 * One `~/.cfcf/clio.db` file holds every workspace's memory across every
 * Clio Project. Path can be overridden via `CFCF_CLIO_DB` (same pattern as
 * `CFCF_CONFIG_DIR` / `CFCF_LOGS_DIR`).
 *
 * Uses Bun's built-in `bun:sqlite` driver, which ships FTS5. PR1 doesn't
 * need `loadExtension` (no sqlite-vec yet) -- that's PR2's concern.
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
 * Open the Clio DB, ensuring the parent directory exists and all
 * pending migrations have been applied. Callers should cache the
 * returned handle for the process lifetime rather than reopening.
 *
 * Pass `opts.path` to override the DB path (used by tests for isolated
 * temp DBs).
 */
export function openClioDb(opts?: { path?: string }): Database {
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
