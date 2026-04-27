/**
 * Tests for Clio's DB handle + migrations runner.
 *
 * Exercises: open-and-migrate happy path, idempotent re-open (migrations
 * don't re-run), schema exists after migration, failure rolls back.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { openClioDb, runMigrations, listAppliedMigrations, applyCustomSqlite, getSqliteVecPath, type ClioMigration } from "./db.js";

// Load migration SQL via the same `with { type: "text" }` import the
// db.ts production code uses, so tests exercise the real bytes.
import m0001Sql from "./migrations/0001_initial.sql" with { type: "text" };
import m0002Sql from "./migrations/0002_active_embedder.sql" with { type: "text" };
function m0001(): string { return m0001Sql; }
function m0002(): string { return m0002Sql; }

const tempDirs: string[] = [];
function makeTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cfcf-clio-db-test-"));
  tempDirs.push(dir);
  return join(dir, "clio.db");
}

afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("openClioDb", () => {
  it("creates the DB file + parent dir + applies migrations", () => {
    const path = makeTempDbPath();
    const db = openClioDb({ path });

    // Applied migrations list: every embedded migration has been run.
    const applied = listAppliedMigrations(db);
    expect(applied.length).toBeGreaterThanOrEqual(2);
    expect(applied[0]).toContain("0001_initial.sql");
    expect(applied[1]).toContain("0002_active_embedder.sql");

    // Core tables exist
    const tables = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type IN ('table','virtual') AND name LIKE 'clio_%' ORDER BY name",
    ).all().map((r) => r.name);

    for (const expected of [
      "clio_audit_log",
      "clio_chunks",
      "clio_chunks_fts",
      "clio_document_versions",
      "clio_documents",
      "clio_migrations",
      "clio_projects",
    ]) {
      expect(tables).toContain(expected);
    }

    db.close();
  });

  it("is idempotent: reopening the DB does not re-run migrations", () => {
    const path = makeTempDbPath();

    const db1 = openClioDb({ path });
    const appliedAt1 = db1.query<{ filename: string; applied_at: string }, []>(
      "SELECT filename, applied_at FROM clio_migrations",
    ).all();
    db1.close();

    // Reopen (simulates a fresh process)
    const db2 = openClioDb({ path });
    const appliedAt2 = db2.query<{ filename: string; applied_at: string }, []>(
      "SELECT filename, applied_at FROM clio_migrations",
    ).all();
    db2.close();

    // Same rows, same timestamps -- migrations didn't re-run
    expect(appliedAt2).toEqual(appliedAt1);
  });

  it("applies multiple migrations in order", () => {
    const path = makeTempDbPath();

    const extra: ClioMigration[] = [
      { filename: "0001_initial.sql", sql: "CREATE TABLE m1_foo (id INTEGER);" },
      { filename: "0002_extra.sql", sql: "CREATE TABLE m2_bar (id INTEGER);" },
      { filename: "0003_third.sql", sql: "CREATE TABLE m3_baz (id INTEGER);" },
    ];

    const db = new Database(path, { create: true });
    runMigrations(db, extra);

    const applied = db.query<{ filename: string }, []>(
      "SELECT filename FROM clio_migrations ORDER BY filename",
    ).all().map((r) => r.filename);

    expect(applied).toEqual(["0001_initial.sql", "0002_extra.sql", "0003_third.sql"]);

    // All three tables exist
    const tables = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'm%_%' ORDER BY name",
    ).all().map((r) => r.name);
    expect(tables).toEqual(["m1_foo", "m2_bar", "m3_baz"]);

    db.close();
  });

  it("rolls back a failing migration so later re-runs can recover", () => {
    const path = makeTempDbPath();

    const broken: ClioMigration[] = [
      { filename: "0001_ok.sql", sql: "CREATE TABLE ok_tbl (id INTEGER);" },
      { filename: "0002_broken.sql", sql: "this is not valid SQL;" },
    ];

    const db = new Database(path, { create: true });
    expect(() => runMigrations(db, broken)).toThrow(/0002_broken.sql failed/);

    // 0001 stays applied; 0002 rolled back (not in clio_migrations)
    const applied = db.query<{ filename: string }, []>(
      "SELECT filename FROM clio_migrations",
    ).all().map((r) => r.filename);
    expect(applied).toEqual(["0001_ok.sql"]);

    // ok_tbl exists from 0001
    const tables = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='ok_tbl'",
    ).all();
    expect(tables).toHaveLength(1);

    db.close();
  });
});

describe("applyCustomSqlite + getSqliteVecPath", () => {
  // The 5.5 installer drops a custom libsqlite3 + sqlite-vec under
  // ~/.cfcf/native/. These tests verify the dev-mode no-op + the
  // file-present path. The "actually call setCustomSQLite" path is
  // exercised by the build-release-tarball.sh smoke test (a real
  // libsqlite3 there); unit tests run with no installer present.
  it("applyCustomSqlite is a silent no-op when ~/.cfcf/native/ is absent", () => {
    const fakeDir = mkdtempSync(join(tmpdir(), "cfcf-no-native-"));
    tempDirs.push(fakeDir);
    process.env.CFCF_NATIVE_DIR = fakeDir;        // pointed at empty dir
    try {
      // Should not throw, should not error.
      expect(() => applyCustomSqlite()).not.toThrow();
      // Subsequent open works against system SQLite as usual.
      const db = openClioDb({ path: makeTempDbPath() });
      expect(db.query("SELECT sqlite_version() AS v").get()).toBeTruthy();
      db.close();
    } finally {
      delete process.env.CFCF_NATIVE_DIR;
    }
  });

  it("getSqliteVecPath returns null when sqlite-vec isn't staged", () => {
    const fakeDir = mkdtempSync(join(tmpdir(), "cfcf-no-vec-"));
    tempDirs.push(fakeDir);
    process.env.CFCF_NATIVE_DIR = fakeDir;
    try {
      expect(getSqliteVecPath()).toBeNull();
    } finally {
      delete process.env.CFCF_NATIVE_DIR;
    }
  });

  it("getSqliteVecPath surfaces the path + entryPoint when the lib is present", () => {
    const fakeDir = mkdtempSync(join(tmpdir(), "cfcf-fake-vec-"));
    tempDirs.push(fakeDir);
    // Drop a fake .dylib/.so/.dll matching the platform. We don't
    // verify the file is a valid library here -- 6.15's loadExtension
    // is what fails loudly when the bytes are bad. We're testing the
    // resolution layer.
    const ext =
      process.platform === "darwin" ? ".dylib" :
      process.platform === "win32"  ? ".dll"  : ".so";
    const fakeLib = join(fakeDir, `sqlite-vec${ext}`);
    writeFileSync(fakeLib, "fake bytes");

    process.env.CFCF_NATIVE_DIR = fakeDir;
    try {
      const got = getSqliteVecPath();
      expect(got).not.toBeNull();
      expect(got!.path).toBe(fakeLib);
      expect(got!.entryPoint).toBe("sqlite3_vec_init");
    } finally {
      delete process.env.CFCF_NATIVE_DIR;
    }
  });
});

describe("schema shape", () => {
  // Regression test: migration 0003 must NOT cascade-delete clio_chunks
  // when it rebuilds clio_documents. Discovered 2026-04-27 -- the original
  // 0003 used `PRAGMA defer_foreign_keys=ON` inside the migration's
  // transaction, which postpones FK CHECKS but NOT cascade actions. DROP
  // TABLE clio_documents fired ON DELETE CASCADE on every chunk and
  // corrupted the FTS5 index. Fix: the `-- @migration-flags:
  // disable-foreign-keys` marker on line 1 of 0003 + a new branch in
  // runMigrations that brackets the migration with `PRAGMA
  // foreign_keys = OFF / ON` outside the transaction.
  //
  // Test path: simulate a user's pre-0003 DB (only 0001 + 0002 applied,
  // with real chunk data), run runMigrations to apply 0003 (and 0004),
  // verify chunks + FTS index survive the rebuild.
  it("migration 0003 preserves clio_chunks + FTS index across the table rebuild", async () => {
    const { Database } = await import("bun:sqlite");
    const db = new Database(":memory:", { create: true });
    db.exec("PRAGMA foreign_keys = ON");

    // Apply only 0001 + 0002 -- represents a user's DB before they
    // upgraded to a build that includes 0003.
    runMigrations(db, [
      { filename: "0001_initial.sql", sql: m0001() },
      { filename: "0002_active_embedder.sql", sql: m0002() },
    ]);

    // Insert real data: project, doc, chunk. The chunk is the canary;
    // the original 0003 deleted it via ON DELETE CASCADE.
    db.run("INSERT INTO clio_projects (id, name) VALUES ('p1', 'p1')");
    db.run(
      "INSERT INTO clio_documents (id, project_id, title, source, content_hash, chunk_count) VALUES ('d1', 'p1', 't', 's', 'h1', 1)",
    );
    db.run(
      "INSERT INTO clio_chunks (id, document_id, chunk_index, content, char_count) VALUES ('c1', 'd1', 0, 'survive the rebuild canary', 26)",
    );

    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM clio_chunks").get()?.n).toBe(1);
    expect(
      db.query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM clio_chunks_fts WHERE clio_chunks_fts MATCH 'canary'",
      ).get()?.n,
    ).toBe(1);

    // Apply the rest (0003, 0004). With the fix, chunks + FTS survive.
    runMigrations(db);

    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM clio_chunks").get()?.n).toBe(1);
    expect(
      db.query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM clio_chunks_fts WHERE clio_chunks_fts MATCH 'canary'",
      ).get()?.n,
    ).toBe(1);
    // The doc row also survived (its data was copied across in the rebuild).
    expect(
      db.query<{ id: string; author: string }, []>("SELECT id, author FROM clio_documents WHERE id='d1'").get(),
    ).toEqual({ id: "d1", author: "agent" });
    db.close();
  });

  // Migration 0003 (item 5.11) relaxed the UNIQUE constraint on
  // clio_documents.content_hash so legitimate updates whose new content
  // happens to match another doc don't deadlock. Application-level dedup
  // still happens in LocalClio.ingest's create branch (returns
  // action="skipped" for the existing match); the schema just doesn't
  // enforce one-doc-per-hash anymore.
  it("does NOT enforce content_hash uniqueness at the schema level (relaxed in 0003)", () => {
    const path = makeTempDbPath();
    const db = openClioDb({ path });

    db.run("INSERT INTO clio_projects (id, name) VALUES ('p1', 'test')");
    db.run(`
      INSERT INTO clio_documents (id, project_id, title, source, content_hash)
      VALUES ('d1', 'p1', 't1', 'src', 'abc123')
    `);

    // Used to throw on the duplicate hash; now succeeds silently.
    expect(() =>
      db.run(`
        INSERT INTO clio_documents (id, project_id, title, source, content_hash)
        VALUES ('d2', 'p1', 't2', 'src2', 'abc123')
      `),
    ).not.toThrow();

    db.close();
  });

  it("enforces one-current-chunk per (document, chunk_index)", () => {
    const path = makeTempDbPath();
    const db = openClioDb({ path });

    db.run("INSERT INTO clio_projects (id, name) VALUES ('p1', 'test')");
    db.run(`
      INSERT INTO clio_documents (id, project_id, title, source, content_hash)
      VALUES ('d1', 'p1', 't', 'src', 'h1')
    `);
    db.run(`
      INSERT INTO clio_chunks (id, document_id, chunk_index, content, char_count)
      VALUES ('c1', 'd1', 0, 'hello', 5)
    `);

    // Second current chunk with same index -> UNIQUE violation
    expect(() =>
      db.run(`
        INSERT INTO clio_chunks (id, document_id, chunk_index, content, char_count)
        VALUES ('c2', 'd1', 0, 'world', 5)
      `),
    ).toThrow(/UNIQUE constraint failed/);

    // But an archived chunk with the same chunk_index is fine (version_id NOT NULL)
    db.run(`
      INSERT INTO clio_document_versions (id, document_id, version_number)
      VALUES ('v1', 'd1', 1)
    `);
    db.run(`
      INSERT INTO clio_chunks (id, document_id, version_id, chunk_index, content, char_count)
      VALUES ('c3', 'd1', 'v1', 0, 'archived', 8)
    `);

    db.close();
  });

  it("FTS5 triggers index current chunks and skip archived ones", () => {
    const path = makeTempDbPath();
    const db = openClioDb({ path });

    db.run("INSERT INTO clio_projects (id, name) VALUES ('p1', 'test')");
    db.run(`
      INSERT INTO clio_documents (id, project_id, title, source, content_hash)
      VALUES ('d1', 'p1', 't', 'src', 'h1')
    `);
    db.run(`
      INSERT INTO clio_document_versions (id, document_id, version_number)
      VALUES ('v1', 'd1', 1)
    `);
    db.run(`
      INSERT INTO clio_chunks (id, document_id, chunk_index, content, char_count)
      VALUES ('c-current', 'd1', 0, 'workspace memory is the future', 30)
    `);
    db.run(`
      INSERT INTO clio_chunks (id, document_id, version_id, chunk_index, content, char_count)
      VALUES ('c-archived', 'd1', 'v1', 0, 'workspace memory was the past', 29)
    `);

    // FTS MATCH returns only the current chunk
    const hits = db.query<{ id: string }, [string]>(
      `SELECT c.id AS id
         FROM clio_chunks_fts f
         JOIN clio_chunks c ON c.rowid = f.rowid
        WHERE clio_chunks_fts MATCH ?`,
    ).all("workspace");
    expect(hits.map((r) => r.id)).toEqual(["c-current"]);

    db.close();
  });

  it("cascades chunks on document delete", () => {
    const path = makeTempDbPath();
    const db = openClioDb({ path });

    db.run("INSERT INTO clio_projects (id, name) VALUES ('p1', 'test')");
    db.run(`
      INSERT INTO clio_documents (id, project_id, title, source, content_hash)
      VALUES ('d1', 'p1', 't', 'src', 'h1')
    `);
    db.run(`
      INSERT INTO clio_chunks (id, document_id, chunk_index, content, char_count)
      VALUES ('c1', 'd1', 0, 'one', 3)
    `);
    db.run(`
      INSERT INTO clio_chunks (id, document_id, chunk_index, content, char_count)
      VALUES ('c2', 'd1', 1, 'two', 3)
    `);

    expect(db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM clio_chunks").all()[0].n).toBe(2);
    db.run("DELETE FROM clio_documents WHERE id='d1'");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM clio_chunks").all()[0].n).toBe(0);

    db.close();
  });
});
