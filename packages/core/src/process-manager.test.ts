import { describe, it, expect } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { spawnProcess } from "./process-manager.js";

describe("process manager", () => {
  describe("spawnProcess", () => {
    it("runs a simple command and captures output", async () => {
      const managed = spawnProcess({
        command: "echo",
        args: ["hello world"],
        cwd: process.cwd(),
      });

      const result = await managed.result;
      expect(result.exitCode).toBe(0);
      expect(result.killed).toBe(false);
      expect(result.durationMs).toBeGreaterThan(0);
    });

    it("captures exit code for failing commands", async () => {
      const managed = spawnProcess({
        command: "bash",
        args: ["-c", "exit 42"],
        cwd: process.cwd(),
      });

      const result = await managed.result;
      expect(result.exitCode).toBe(42);
    });

    it("writes output to log file", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "cfcf-proc-test-"));
      const logFile = join(tempDir, "test.log");

      try {
        const managed = spawnProcess({
          command: "echo",
          args: ["log this"],
          cwd: process.cwd(),
          logFile,
        });

        const result = await managed.result;
        expect(result.exitCode).toBe(0);
        expect(result.logFile).toBe(logFile);

        const logContent = await readFile(logFile, "utf-8");
        expect(logContent).toContain("log this");
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("can kill a running process", async () => {
      const managed = spawnProcess({
        command: "sleep",
        args: ["30"],
        cwd: process.cwd(),
      });

      // Kill after a brief delay
      setTimeout(() => managed.kill(), 100);

      const result = await managed.result;
      expect(result.killed).toBe(true);
      expect(result.durationMs).toBeLessThan(5000);
    });

    it("respects timeout", async () => {
      const managed = spawnProcess({
        command: "sleep",
        args: ["30"],
        cwd: process.cwd(),
        timeout: 200,
      });

      const result = await managed.result;
      expect(result.killed).toBe(true);
      expect(result.durationMs).toBeLessThan(5000);
    });

    it("passes environment variables", async () => {
      const managed = spawnProcess({
        command: "bash",
        args: ["-c", "echo $CFCF_TEST_VAR"],
        cwd: process.cwd(),
        env: { CFCF_TEST_VAR: "test-value" },
      });

      const result = await managed.result;
      expect(result.exitCode).toBe(0);
    });

    it("runs in the specified working directory", async () => {
      const managed = spawnProcess({
        command: "pwd",
        args: [],
        cwd: "/tmp",
      });

      const result = await managed.result;
      expect(result.exitCode).toBe(0);
    });
  });
});
