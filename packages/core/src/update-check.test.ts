import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearStaleUpdateFlag,
  compareSemver,
  makeUpdateCheckJob,
  readUpdateAvailable,
  runUpdateCheck,
} from "./update-check.js";

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "cfcf-upd-"));
  return join(dir, "update-available.json");
}

describe("compareSemver", () => {
  test("compares major/minor/patch", () => {
    expect(compareSemver("1.0.0", "2.0.0")).toBe(-1);
    expect(compareSemver("0.18.0", "0.17.1")).toBe(1);
    expect(compareSemver("0.17.1", "0.17.1")).toBe(0);
    expect(compareSemver("0.17.0", "0.17.1")).toBe(-1);
    expect(compareSemver("1.10.0", "1.9.99")).toBe(1); // not string compare
  });

  test("strips leading v and prerelease tail", () => {
    expect(compareSemver("v0.18.0", "0.17.1")).toBe(1);
    expect(compareSemver("0.17.1-dev", "0.17.1")).toBe(0);
    expect(compareSemver("0.18.0-dev", "0.17.1")).toBe(1);
  });
});

describe("runUpdateCheck", () => {
  test("writes the flag file when latest > current", async () => {
    const file = tmpFile();
    await runUpdateCheck({
      currentVersion: "0.17.1",
      filePath: file,
      fetchLatest: async () => "0.18.0",
    });
    expect(existsSync(file)).toBe(true);
    const body = JSON.parse(readFileSync(file, "utf-8"));
    expect(body.currentVersion).toBe("0.17.1");
    expect(body.latestVersion).toBe("0.18.0");
    expect(typeof body.checkedAt).toBe("string");
    // Security: the flag file MUST NOT carry a clickable URL. It lives in
    // ~/.cfcf/ which is user-writable; a malicious local write could
    // otherwise plant an attacker-controlled <a target="_blank"> in the
    // web banner. See update-check.ts:UpdateAvailableFile.
    expect(body.releaseNotesUrl).toBeUndefined();
  });

  test("deletes the flag file when running matches latest", async () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({
      currentVersion: "0.17.0",
      latestVersion: "0.18.0",
      checkedAt: new Date().toISOString(),
    }));
    await runUpdateCheck({
      currentVersion: "0.18.0",
      filePath: file,
      fetchLatest: async () => "0.18.0",
    });
    expect(existsSync(file)).toBe(false);
  });

  test("deletes the flag file when running is ahead of latest (tag-only release case)", async () => {
    const file = tmpFile();
    writeFileSync(file, "{ \"stale\": true }");
    await runUpdateCheck({
      currentVersion: "0.17.1",
      filePath: file,
      fetchLatest: async () => "0.17.0",
    });
    expect(existsSync(file)).toBe(false);
  });

  test("propagates fetch errors so JobScheduler records lastError", async () => {
    const file = tmpFile();
    let threw = false;
    try {
      await runUpdateCheck({
        currentVersion: "0.17.1",
        filePath: file,
        fetchLatest: async () => { throw new Error("offline"); },
      });
    } catch (err) {
      threw = true;
      expect((err as Error).message).toBe("offline");
    }
    expect(threw).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

});

describe("readUpdateAvailable", () => {
  test("returns the parsed file when present", async () => {
    const file = tmpFile();
    await runUpdateCheck({
      currentVersion: "0.17.1",
      filePath: file,
      fetchLatest: async () => "0.18.0",
    });
    const r = await readUpdateAvailable(file);
    expect(r?.latestVersion).toBe("0.18.0");
  });

  test("returns null when the file is absent", async () => {
    const file = tmpFile();
    const r = await readUpdateAvailable(file);
    expect(r).toBeNull();
  });

  test("returns null on malformed JSON", async () => {
    const file = tmpFile();
    writeFileSync(file, "not json");
    const r = await readUpdateAvailable(file);
    expect(r).toBeNull();
  });

  test("returns null when required fields are missing", async () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({ latestVersion: "0.18.0" }));
    const r = await readUpdateAvailable(file);
    expect(r).toBeNull();
  });
});

describe("clearStaleUpdateFlag", () => {
  test("deletes the flag file when running version has caught up to latestVersion", async () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({
      currentVersion: "0.17.1",
      latestVersion: "0.18.0",
      checkedAt: new Date().toISOString(),
    }));
    const cleared = await clearStaleUpdateFlag("0.18.0", file);
    expect(cleared).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  test("deletes the flag file when running version is ahead (tag-only release)", async () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({
      currentVersion: "0.17.0",
      latestVersion: "0.17.0",
      checkedAt: new Date().toISOString(),
    }));
    const cleared = await clearStaleUpdateFlag("0.17.1", file);
    expect(cleared).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  test("preserves the flag file when latestVersion is still newer", async () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({
      currentVersion: "0.17.1",
      latestVersion: "0.18.0",
      checkedAt: new Date().toISOString(),
    }));
    const cleared = await clearStaleUpdateFlag("0.17.1", file);
    expect(cleared).toBe(false);
    expect(existsSync(file)).toBe(true);
  });

  test("no-ops when the flag file is absent", async () => {
    const file = tmpFile();
    const cleared = await clearStaleUpdateFlag("0.18.0", file);
    expect(cleared).toBe(false);
  });

  test("no-ops when the flag file is malformed", async () => {
    const file = tmpFile();
    writeFileSync(file, "not json");
    const cleared = await clearStaleUpdateFlag("0.18.0", file);
    // readUpdateAvailable returns null for malformed -> no-op (cleared=false)
    // The file stays so the next scheduler tick can replace it cleanly.
    expect(cleared).toBe(false);
  });
});

describe("makeUpdateCheckJob", () => {
  test("produces a Job with id=update-check and the requested interval", () => {
    const job = makeUpdateCheckJob({
      currentVersion: "0.17.1",
      intervalMs: 60_000,
      fetchLatest: async () => "0.17.1",
    });
    expect(job.id).toBe("update-check");
    expect(job.intervalMs).toBe(60_000);
  });

  test("default interval is 24h", () => {
    const job = makeUpdateCheckJob({
      currentVersion: "0.17.1",
      fetchLatest: async () => "0.17.1",
    });
    expect(job.intervalMs).toBe(24 * 60 * 60 * 1000);
  });
});
