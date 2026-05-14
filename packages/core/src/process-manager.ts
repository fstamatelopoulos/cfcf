/**
 * Process manager for cfcf.
 *
 * Spawns agent CLI processes, streams their output, and manages their lifecycle.
 * Uses Bun.spawn() for process management.
 */

import { mkdir } from "fs/promises";
import { dirname } from "path";

export interface ProcessOptions {
  /** Command to run (e.g., "claude", "codex", "npm") */
  command: string;
  /** Arguments */
  args: string[];
  /** Working directory */
  cwd: string;
  /** Path to write the full log file */
  logFile?: string;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Timeout in milliseconds (0 = no timeout) */
  timeout?: number;
}

export interface ProcessResult {
  exitCode: number;
  logFile?: string;
  durationMs: number;
  killed: boolean;
}

export interface ManagedProcess {
  /** The underlying Bun subprocess */
  proc: ReturnType<typeof Bun.spawn>;
  /** Promise that resolves when the process exits */
  result: Promise<ProcessResult>;
  /** Kill the process */
  kill(): void;
}

/**
 * Spawn a managed process.
 *
 * Streams stdout/stderr to the log file in real-time (incremental writes).
 * Returns immediately with a ManagedProcess handle.
 */
export async function spawnProcess(opts: ProcessOptions): Promise<ManagedProcess> {
  const startTime = Date.now();
  let killed = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  // Prepare log file writer before spawning
  let logWriter: Bun.FileSink | null = null;
  if (opts.logFile) {
    await mkdir(dirname(opts.logFile), { recursive: true });
    logWriter = Bun.file(opts.logFile).writer();
  }

  // `detached: true` puts the spawned process (and its descendants) in
  // their own process group / session. That lets us kill the whole
  // subtree on shutdown via `process.kill(-pgid, signal)` rather than
  // just the immediate child. Item 6.31 (2026-05-08): without this,
  // wrapper scripts like `ollama launch <agent>` would die from SIGTERM
  // but leave the wrapped agent (e.g. `claude`) running as an orphan,
  // holding ollama's model serializer until it timed out (10 min).
  // Surfaced when `cfcf server stop && cfcf server start` accumulated
  // multiple zombie agents that wedged the next loop's API call queue.
  const proc = Bun.spawn([opts.command, ...opts.args], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
    // Spawn into a new process group on Unix (Bun calls setsid).
    // Without this, sending SIGTERM to `proc.pid` only signals the
    // immediate child; descendants persist as orphans.
    // See: https://bun.sh/docs/api/spawn#options.detached
    // (Windows: process groups behave differently; Bun's detached
    // is a no-op there. Acceptable since cfcf is Unix-first today.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detached: true as any,
  });

  // Set up timeout if requested
  if (opts.timeout && opts.timeout > 0) {
    timeoutId = setTimeout(() => {
      killed = true;
      killProcessTree(proc.pid);
    }, opts.timeout);
  }

  // Stream stdout and stderr to log file incrementally
  const streamToLog = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && logWriter) {
          const text = decoder.decode(value, { stream: true });
          logWriter.write(text);
          logWriter.flush();
        }
      }
    } finally {
      reader.releaseLock();
    }
  };

  // Start streaming both stdout and stderr concurrently
  const streamPromise = Promise.all([
    streamToLog(proc.stdout),
    streamToLog(proc.stderr),
  ]);

  const result = (async (): Promise<ProcessResult> => {
    // Wait for streams to finish and process to exit
    await streamPromise;
    const exitCode = await proc.exited;

    if (logWriter) {
      await logWriter.end();
    }

    if (timeoutId) clearTimeout(timeoutId);

    return {
      exitCode,
      logFile: opts.logFile,
      durationMs: Date.now() - startTime,
      killed,
    };
  })();

  return {
    proc,
    result,
    kill() {
      killed = true;
      killProcessTree(proc.pid);
    },
  };
}

/**
 * Kill the entire process tree rooted at `pid` (the leader of a process
 * group spawned with `detached: true`). Sends SIGTERM first; after a
 * 1.5s grace window, sends SIGKILL to anything still alive. Best-effort:
 * ignores errors (the process may already be dead, or the pgid may have
 * become invalid).
 *
 * Why send to `-pid` (negative): on Unix, `process.kill(-pgid, sig)`
 * delivers `sig` to every process in the group `pgid`. Since we
 * spawned with `detached: true`, the spawned process IS its own group
 * leader and `pgid === pid`. So negating the pid signals the whole
 * tree (the wrapper + everything it spawned recursively).
 *
 * Item 6.31 (2026-05-08).
 */
export function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    // SIGTERM the whole group. Negative pid = group target on Unix.
    process.kill(-pid, "SIGTERM");
  } catch {
    // Group may have already exited, or single-process kill is fine.
    try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
  }
  // After a grace window, force SIGKILL to anything still running.
  // 1.5s is enough for a well-behaved agent CLI to shut down cleanly
  // (drain stdout, finalise files, etc.); past that, the wrapper or
  // a wedged inference call won't respect SIGTERM and we go nuclear.
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
    }
  }, 1500).unref();
}
