/**
 * Process manager for cfcf.
 *
 * Spawns agent CLI processes, streams their output, and manages their lifecycle.
 * Uses Bun.spawn() for process management.
 */

import { mkdir } from "fs/promises";
import { join, dirname } from "path";

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
  /** Async iterable of log lines (stdout + stderr merged) */
  logs: AsyncIterable<string>;
  /** Promise that resolves when the process exits */
  result: Promise<ProcessResult>;
  /** Kill the process */
  kill(): void;
}

/**
 * Spawn a managed process.
 *
 * Returns immediately with a ManagedProcess handle.
 * The caller can iterate over `logs` for real-time output and await `result` for completion.
 */
export function spawnProcess(opts: ProcessOptions): ManagedProcess {
  const startTime = Date.now();
  let killed = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const proc = Bun.spawn([opts.command, ...opts.args], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Merge stdout and stderr into a single async iterable of lines
  const logs = mergeStreams(proc.stdout, proc.stderr);

  // Set up timeout if requested
  if (opts.timeout && opts.timeout > 0) {
    timeoutId = setTimeout(() => {
      killed = true;
      proc.kill();
    }, opts.timeout);
  }

  const result = (async (): Promise<ProcessResult> => {
    // Set up log file writer if requested
    let logWriter: Bun.FileSink | null = null;
    if (opts.logFile) {
      await mkdir(dirname(opts.logFile), { recursive: true });
      logWriter = Bun.file(opts.logFile).writer();
    }

    // Consume the merged stream, writing to log file
    for await (const line of logs) {
      if (logWriter) {
        logWriter.write(line + "\n");
      }
    }

    if (logWriter) {
      await logWriter.end();
    }

    const exitCode = await proc.exited;
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
    logs,
    result,
    kill() {
      killed = true;
      proc.kill();
    },
  };
}

/**
 * Merge two ReadableStreams into a single async iterable of lines.
 * Lines from both streams are interleaved as they arrive.
 */
async function* mergeStreams(
  stdout: ReadableStream<Uint8Array> | null,
  stderr: ReadableStream<Uint8Array> | null,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let done = false;

  async function readStream(stream: ReadableStream<Uint8Array> | null) {
    if (!stream) return;
    const reader = stream.getReader();
    try {
      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        if (value) {
          chunks.push(decoder.decode(value, { stream: true }));
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // Read both streams concurrently, collecting chunks
  // For simplicity in v0.1, we read both to completion then yield lines.
  // A more sophisticated version would use a proper async queue for true interleaving.
  await Promise.all([readStream(stdout), readStream(stderr)]);

  // Split accumulated output into lines
  const allOutput = chunks.join("");
  const lines = allOutput.split("\n");
  for (const line of lines) {
    if (line.length > 0) {
      yield line;
    }
  }
}
