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

  const proc = Bun.spawn([opts.command, ...opts.args], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Set up timeout if requested
  if (opts.timeout && opts.timeout > 0) {
    timeoutId = setTimeout(() => {
      killed = true;
      proc.kill();
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
      proc.kill();
    },
  };
}
