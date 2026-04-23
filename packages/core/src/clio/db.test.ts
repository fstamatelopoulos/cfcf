/**
 * Tests for Clio's DB handle + migrations runner.
 *
 * Exercises: open-and-migrate happy path, idempotent re-open (migrations
 * don't re-run), schema exists after migration, failure rolls back.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { openClioDb, runMigrations, listAppliedMigrations, type ClioMigration } from "./db.js";

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

    // Applied migrations list: should have exactly the initial one
    const applied = listAppliedMigrations(db);
    expect(applied.length).toBe(1);
    expect(applied[0]).toContain("0001_initial.sql");

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

describe("schema shape", () => {
  it("enforces content_hash uniqueness on clio_documents", () => {
    const path = makeTempDbPath();
    const db = openClioDb({ path });

    db.run("INSERT INTO clio_projects (id, name) VALUES ('p1', 'test')");
    db.run(`
      INSERT INTO clio_documents (id, project_id, title, source, content_hash)
      VALUES ('d1', 'p1', 't1', 'src', 'abc123')
    `);

    expect(() =>
      db.run(`
        INSERT INTO clio_documents (id, project_id, title, source, content_hash)
        VALUES ('d2', 'p1', 't2', 'src2', 'abc123')
      `),
    ).toThrow(/UNIQUE constraint failed/);

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
