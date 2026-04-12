import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { writePidFile, readPidFile, removePidFile, isProcessRunning } from "./pid-file.js";

describe("pid-file", () => {
  let tempDir: string;
  const originalEnv = process.env.CFCF_CONFIG_DIR;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cfcf-pid-test-"));
    process.env.CFCF_CONFIG_DIR = tempDir;
  });

  afterEach(async () => {
    process.env.CFCF_CONFIG_DIR = originalEnv;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes and reads PID file", async () => {
    await writePidFile(12345, 7233);
    const info = await readPidFile();
    expect(info).not.toBeNull();
    expect(info!.pid).toBe(12345);
    expect(info!.port).toBe(7233);
    expect(info!.startedAt).toBeDefined();
  });

  it("returns null when no PID file", async () => {
    expect(await readPidFile()).toBeNull();
  });

  it("removes PID file", async () => {
    await writePidFile(12345, 7233);
    await removePidFile();
    expect(await readPidFile()).toBeNull();
  });

  it("detects current process as running", () => {
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  it("detects non-existent PID as not running", () => {
    expect(isProcessRunning(999999)).toBe(false);
  });
});
