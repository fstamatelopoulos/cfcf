import { describe, it, expect } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { spawnProcess } from "./process-manager.js";

describe("process manager", () => {
  describe("spawnProcess", () => {
    it("runs a simple command and captures output", async () => {
      const managed = await spawnProcess({
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
      const managed = await spawnProcess({
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
        const managed = await spawnProcess({
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
      const managed = await spawnProcess({
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
      const managed = await spawnProcess({
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
      const managed = await spawnProcess({
        command: "bash",
        args: ["-c", "echo $CFCF_TEST_VAR"],
        cwd: process.cwd(),
        env: { CFCF_TEST_VAR: "test-value" },
      });

      const result = await managed.result;
      expect(result.exitCode).toBe(0);
    });

    it("runs in the specified working directory", async () => {
      const managed = await spawnProcess({
        command: "pwd",
        args: [],
        cwd: "/tmp",
      });

      const result = await managed.result;
      expect(result.exitCode).toBe(0);
    });

    // Regression: 2026-05-08 (item 6.31) — kill() must terminate the
    // whole process tree, not just the immediate child. Without
    // detached + process-group semantics, wrapper scripts like
    // `ollama launch <agent>` would die from SIGTERM but leave the
    // wrapped agent running as an orphan of init.
    it("kill() terminates the whole process tree (wrapper + child)", async () => {
      // Spawn `bash -c "sleep 30 & wait"`. The bash shell is the
      // immediate child; `sleep 30` is a grandchild via the
      // backgrounded `&`. Pre-fix: kill() sent SIGTERM to bash,
      // bash died, sleep continued for 30s as orphan. Post-fix:
      // kill() sends SIGTERM to the whole process group, killing
      // both bash and sleep together.
      const managed = await spawnProcess({
        command: "bash",
        args: ["-c", "sleep 30 & wait"],
        cwd: process.cwd(),
      });
      // Capture the spawned bash's PID so we can verify the sleep
      // grandchild dies too. On macOS / Linux pgrep -P <pid> lists
      // direct children.
      const bashPid = managed.proc.pid;
      // Wait briefly for sleep to spawn under bash.
      await new Promise((r) => setTimeout(r, 200));
      // Verify sleep is alive as bash's child (sanity guard for the
      // test's own setup; if pgrep can't find the child the test is
      // unreliable on this platform).
      const childrenBefore = Bun.spawnSync(["pgrep", "-P", String(bashPid)]);
      const sleepPidStr = childrenBefore.stdout.toString().trim().split("\n")[0];
      const sleepPid = parseInt(sleepPidStr, 10);
      expect(sleepPid).toBeGreaterThan(0);
      // Now kill the spawn. This should take down both bash AND sleep.
      managed.kill();
      // Wait for the SIGTERM grace window + a bit for OS reaping.
      await new Promise((r) => setTimeout(r, 2200));
      // The sleep grandchild should be gone — `kill -0 <pid>` returns
      // non-zero if the pid is no longer alive.
      const stillAlive = Bun.spawnSync(["kill", "-0", String(sleepPid)]);
      expect(stillAlive.exitCode).not.toBe(0);
    });
  });
});
