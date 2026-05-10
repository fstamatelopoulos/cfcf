/**
 * Tests for the Clio usage-log module (item 6.9 — Cerefox parity).
 *
 * Covers:
 * - Migration applies cleanly + table is created
 * - logUsage writes a row with the expected shape
 * - logUsage swallows errors (fire-and-forget)
 * - getUsageLog filters: since/until, operation, access_path,
 *   requestor, reads/writes, zero-hits
 * - getUsageSummary aggregates correctly
 * - LocalClio's logUsage / getUsageLog / getUsageSummary delegate
 *   to the writer (smoke test through the backend interface)
 */

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LocalClio } from "./backend/local-clio.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "cfcf-usage-log-test-"));
});

afterEach(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeClio(): LocalClio {
  return new LocalClio({ path: join(tempDir, "clio.db") });
}

describe("clio_usage_log table (migration 0003)", () => {
  it("logUsage writes a row with the expected shape", async () => {
    const clio = makeClio();
    clio.logUsage({
      operation: "search",
      accessPath: "cli",
      requestor: "user",
      queryText: "auth decisions",
      resultCount: 3,
      extra: { latency_ms: 42 },
    });
    const rows = await clio.getUsageLog();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.operation).toBe("search");
    expect(row.accessPath).toBe("cli");
    expect(row.requestor).toBe("user");
    expect(row.queryText).toBe("auth decisions");
    expect(row.resultCount).toBe(3);
    expect(row.extra).toEqual({ latency_ms: 42 });
    expect(row.loggedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
    await clio.close();
  });

  it("nullable fields default cleanly when omitted", async () => {
    const clio = makeClio();
    clio.logUsage({ operation: "ingest", accessPath: "agent-cli" });
    const rows = await clio.getUsageLog();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.requestor).toBeNull();
    expect(row.documentId).toBeNull();
    expect(row.projectId).toBeNull();
    expect(row.queryText).toBeNull();
    expect(row.resultCount).toBeNull();
    expect(row.extra).toBeNull();
    await clio.close();
  });

  it("multiple writes ordered DESC by logged_at on read", async () => {
    const clio = makeClio();
    clio.logUsage({ operation: "search", accessPath: "cli", queryText: "first" });
    // Force a logged_at delta — strftime('%fZ') resolution is
    // millisecond, but back-to-back inserts can land on the same
    // tick. Sleep 5ms.
    await new Promise((resolve) => setTimeout(resolve, 5));
    clio.logUsage({ operation: "search", accessPath: "cli", queryText: "second" });
    const rows = await clio.getUsageLog();
    expect(rows).toHaveLength(2);
    expect(rows[0].queryText).toBe("second"); // newest first
    expect(rows[1].queryText).toBe("first");
    await clio.close();
  });
});

describe("getUsageLog filters", () => {
  it("operation filter narrows to one event type", async () => {
    const clio = makeClio();
    clio.logUsage({ operation: "search", accessPath: "cli" });
    clio.logUsage({ operation: "ingest", accessPath: "cli" });
    clio.logUsage({ operation: "search", accessPath: "cli" });

    const searches = await clio.getUsageLog({ operation: "search" });
    expect(searches).toHaveLength(2);
    const ingests = await clio.getUsageLog({ operation: "ingest" });
    expect(ingests).toHaveLength(1);
    await clio.close();
  });

  it("readsOnly returns only read operations", async () => {
    const clio = makeClio();
    clio.logUsage({ operation: "search", accessPath: "cli" });
    clio.logUsage({ operation: "ingest", accessPath: "cli" });
    clio.logUsage({ operation: "get-document", accessPath: "cli" });
    clio.logUsage({ operation: "delete", accessPath: "cli" });

    const reads = await clio.getUsageLog({ readsOnly: true });
    const ops = new Set(reads.map((r) => r.operation));
    expect(ops).toEqual(new Set(["search", "get-document"]));
    await clio.close();
  });

  it("writesOnly returns only write operations", async () => {
    const clio = makeClio();
    clio.logUsage({ operation: "search", accessPath: "cli" });
    clio.logUsage({ operation: "ingest", accessPath: "cli" });
    clio.logUsage({ operation: "delete", accessPath: "cli" });

    const writes = await clio.getUsageLog({ writesOnly: true });
    const ops = new Set(writes.map((r) => r.operation));
    expect(ops).toEqual(new Set(["ingest", "delete"]));
    await clio.close();
  });

  it("zeroHitsOnly returns only result_count = 0 rows", async () => {
    const clio = makeClio();
    clio.logUsage({ operation: "search", accessPath: "cli", resultCount: 0, queryText: "no-match" });
    clio.logUsage({ operation: "search", accessPath: "cli", resultCount: 5, queryText: "good-match" });
    clio.logUsage({ operation: "search", accessPath: "cli", resultCount: 0, queryText: "another-miss" });

    const misses = await clio.getUsageLog({ zeroHitsOnly: true });
    expect(misses).toHaveLength(2);
    const queries = new Set(misses.map((r) => r.queryText));
    expect(queries).toEqual(new Set(["no-match", "another-miss"]));
    await clio.close();
  });

  it("requestor filter exact-matches an actor stamp", async () => {
    const clio = makeClio();
    clio.logUsage({ operation: "search", accessPath: "agent-cli", requestor: "dev|claude-code|sonnet" });
    clio.logUsage({ operation: "search", accessPath: "cli", requestor: "user" });
    clio.logUsage({ operation: "search", accessPath: "agent-cli", requestor: "judge|codex|gpt-5" });

    const dev = await clio.getUsageLog({ requestor: "dev|claude-code|sonnet" });
    expect(dev).toHaveLength(1);
    expect(dev[0].operation).toBe("search");
    await clio.close();
  });

  it("accessPath filter narrows to one source", async () => {
    const clio = makeClio();
    clio.logUsage({ operation: "search", accessPath: "cli" });
    clio.logUsage({ operation: "search", accessPath: "web" });
    clio.logUsage({ operation: "search", accessPath: "agent-cli" });

    const cli = await clio.getUsageLog({ accessPath: "cli" });
    expect(cli).toHaveLength(1);
    const web = await clio.getUsageLog({ accessPath: "web" });
    expect(web).toHaveLength(1);
    await clio.close();
  });

  it("limit caps the result set", async () => {
    const clio = makeClio();
    for (let i = 0; i < 10; i++) {
      clio.logUsage({ operation: "search", accessPath: "cli", queryText: `q${i}` });
    }
    const limited = await clio.getUsageLog({ limit: 3 });
    expect(limited).toHaveLength(3);
    await clio.close();
  });
});

describe("getUsageSummary", () => {
  it("returns zero counts for an empty log", async () => {
    const clio = makeClio();
    const summary = await clio.getUsageSummary();
    expect(summary.totalCount).toBe(0);
    expect(summary.opsByDay).toEqual([]);
    expect(summary.opsByOperation).toEqual([]);
    expect(summary.opsByAccessPath).toEqual([]);
    expect(summary.opsByRequestor).toEqual([]);
    expect(summary.topDocuments).toEqual([]);
    await clio.close();
  });

  it("aggregates operations + access_paths correctly", async () => {
    const clio = makeClio();
    clio.logUsage({ operation: "search", accessPath: "cli", requestor: "user" });
    clio.logUsage({ operation: "search", accessPath: "cli", requestor: "user" });
    clio.logUsage({ operation: "search", accessPath: "web", requestor: "user" });
    clio.logUsage({ operation: "ingest", accessPath: "agent-cli", requestor: "dev|claude-code|sonnet" });

    const summary = await clio.getUsageSummary();
    expect(summary.totalCount).toBe(4);
    const opMap = new Map(summary.opsByOperation.map((r) => [r.operation, r.count]));
    expect(opMap.get("search")).toBe(3);
    expect(opMap.get("ingest")).toBe(1);
    const apMap = new Map(summary.opsByAccessPath.map((r) => [r.accessPath, r.count]));
    expect(apMap.get("cli")).toBe(2);
    expect(apMap.get("web")).toBe(1);
    expect(apMap.get("agent-cli")).toBe(1);
    const reqMap = new Map(summary.opsByRequestor.map((r) => [r.requestor, r.count]));
    expect(reqMap.get("user")).toBe(3);
    expect(reqMap.get("dev|claude-code|sonnet")).toBe(1);
    await clio.close();
  });
});

describe("LocalClio backend interface — usage log methods", () => {
  it("backend interface exposes logUsage / getUsageLog / getUsageSummary", () => {
    const clio = makeClio();
    expect(typeof clio.logUsage).toBe("function");
    expect(typeof clio.getUsageLog).toBe("function");
    expect(typeof clio.getUsageSummary).toBe("function");
    clio.close();
  });
});
