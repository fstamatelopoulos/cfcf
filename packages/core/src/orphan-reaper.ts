/**
 * Orphan agent-process detection + cleanup (item 6.31 follow-up).
 *
 * When the cfcf server is killed via SIGKILL or an OS panic — bypassing
 * the SIGINT/SIGTERM signal handlers in `start.ts` that normally tear
 * down active agent processes — the spawned agents (`claude`, `codex`,
 * `opencode`, `ollama launch <agent>`) are reparented to PID 1
 * (init/launchd) and keep running. They tie up resources (notably,
 * `ollama launch` orphans serialise on ollama's model runner and starve
 * the next loop's `/v1/chat/completions` queue for up to 10 minutes per
 * orphan).
 *
 * This module identifies those orphans by scanning system processes
 * with three conjoined filters:
 *
 *   1. **Parent PID == 1** — the orphan signature on Unix. Live cfcf
 *      child processes have a live cfcf-server parent, not 1.
 *   2. **Same effective user** — never touches another user's
 *      processes, even if their command shape happens to match.
 *   3. **cfcf-spawned command shape** — very specific flag combos that
 *      the cfcf adapters always pass. The flag combos are tight enough
 *      that a hand-typed `claude -p ...` from another shell session
 *      would not match (cfcf always pairs `-p` with
 *      `--dangerously-skip-permissions`, which a user typing
 *      interactively typically wouldn't).
 *
 * Used by:
 *   - `start.ts` boot-time auto-reap (silent, single log line).
 *   - `cfcf server reap` CLI verb (interactive y/N confirmation).
 */

import { userInfo } from "node:os";

export type OrphanKind =
  | "claude-code"
  | "codex"
  | "opencode"
  | "ollama-launch-claude"
  | "ollama-launch-codex"
  | "ollama-launch-opencode";

export interface OrphanProcess {
  pid: number;
  ppid: number;
  user: string;
  /** Elapsed-time string from `ps` (e.g. "05:32" or "1-04:15:22") */
  etime: string;
  /** Full command line as reported by ps. */
  command: string;
  /** Which cfcf-spawn pattern this matched. */
  kind: OrphanKind;
}

/**
 * Run `ps -eo pid,ppid,user,etime,command -ww` and parse the output.
 *
 * The `-ww` flag disables column truncation so we see the full command
 * line. macOS's BSD-flavoured ps + GNU ps both accept `-eo` with these
 * column names. Windows is not supported — cfcf is Unix-first.
 *
 * Exposed for tests so the parser can be exercised against canned
 * `ps` output without touching the real process table.
 */
export function parsePsOutput(stdout: string): Array<{
  pid: number;
  ppid: number;
  user: string;
  etime: string;
  command: string;
}> {
  const lines = stdout.split("\n");
  if (lines.length === 0) return [];
  // First line is the header. Skip it.
  const out: Array<{ pid: number; ppid: number; user: string; etime: string; command: string }> = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    // Format: "  PID  PPID USER             ELAPSED COMMAND..."
    // We split on whitespace for the first 4 columns, then take the
    // rest of the line as the command (which may contain spaces).
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const [, pidStr, ppidStr, user, etime, command] = match;
    out.push({
      pid: Number(pidStr),
      ppid: Number(ppidStr),
      user,
      etime,
      command: command.trim(),
    });
  }
  return out;
}

/**
 * Classify a command line against the cfcf-spawn flag patterns.
 *
 * Returns the OrphanKind on match, or null if it doesn't look like a
 * cfcf-spawned agent. Pattern decisions encoded here:
 *
 *   - **claude-code direct**: command starts with `claude` (allowing
 *     `/path/to/claude`) AND contains `-p` (or `--print`) AND contains
 *     `--dangerously-skip-permissions`. The pair narrows past
 *     hand-typed claude invocations.
 *
 *   - **codex direct**: command starts with `codex` AND contains
 *     ` exec ` AND contains `danger-full-access`. Codex's exec mode +
 *     the danger flag is the cfcf signature.
 *
 *   - **opencode direct**: command starts with `opencode` AND contains
 *     ` run ` AND contains `--dangerously-skip-permissions`. Same
 *     reasoning as claude.
 *
 *   - **ollama launch <agent>**: command starts with `ollama` AND has
 *     ` launch ` AND has the agent name AND `--yes`. cfcf always
 *     passes `--yes` (required for unattended runs).
 *
 * Exported for tests.
 */
export function classifyCommand(command: string): OrphanKind | null {
  // Normalise: pull just the binary basename for the prefix check, but
  // keep the full command for flag detection.
  const head = command.split(/\s+/)[0] ?? "";
  const bin = head.split("/").pop() ?? "";

  // ollama launch <agent> --yes ...
  if (bin === "ollama" && / launch (claude|codex|opencode)\b/.test(command) && /\s--yes(\s|$)/.test(command)) {
    if (/ launch claude\b/.test(command)) return "ollama-launch-claude";
    if (/ launch codex\b/.test(command)) return "ollama-launch-codex";
    if (/ launch opencode\b/.test(command)) return "ollama-launch-opencode";
  }

  // claude -p ... --dangerously-skip-permissions
  if (
    bin === "claude" &&
    /(?:^|\s)(?:-p|--print)(?:\s|$)/.test(command) &&
    /--dangerously-skip-permissions/.test(command)
  ) {
    return "claude-code";
  }

  // codex ... exec ... danger-full-access
  if (bin === "codex" && /\sexec(\s|$)/.test(command) && /danger-full-access/.test(command)) {
    return "codex";
  }

  // opencode run --dangerously-skip-permissions ...
  if (bin === "opencode" && /\srun(\s|$)/.test(command) && /--dangerously-skip-permissions/.test(command)) {
    return "opencode";
  }

  return null;
}

/**
 * Apply the three conjoined orphan filters to parsed ps rows.
 *
 * Exported for tests so the matcher can be exercised independently of
 * the live process table.
 */
export function filterOrphans(
  rows: ReturnType<typeof parsePsOutput>,
  currentUser: string,
): OrphanProcess[] {
  const out: OrphanProcess[] = [];
  for (const row of rows) {
    if (row.ppid !== 1) continue;
    if (row.user !== currentUser) continue;
    const kind = classifyCommand(row.command);
    if (!kind) continue;
    out.push({ ...row, kind });
  }
  return out;
}

/**
 * Find orphan agent processes on the current system.
 *
 * Returns an empty array if `ps` isn't available or fails — orphan
 * detection is best-effort, never blocks server boot. The boot-time
 * caller swallows any throw via try/catch as a defence-in-depth layer.
 */
export async function findOrphanAgentProcesses(): Promise<OrphanProcess[]> {
  let stdout = "";
  try {
    const proc = Bun.spawn(["ps", "-eo", "pid,ppid,user,etime,command", "-ww"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exit = await proc.exited;
    if (exit !== 0) return [];
    stdout = await new Response(proc.stdout).text();
  } catch {
    return [];
  }

  const rows = parsePsOutput(stdout);
  const me = userInfo().username;
  return filterOrphans(rows, me);
}

/**
 * Format a one-line human-readable summary for an orphan, used in the
 * boot-time auto-reap log line and the `cfcf server reap` listing.
 */
export function formatOrphanLine(o: OrphanProcess): string {
  // Truncate the command at ~80 chars so wide terminals don't get
  // wrapped multi-line garbage. The classify result is informative
  // enough by itself.
  const maxCmd = 80;
  const cmd = o.command.length > maxCmd ? `${o.command.slice(0, maxCmd - 1)}…` : o.command;
  return `pid=${o.pid} kind=${o.kind} elapsed=${o.etime} ${cmd}`;
}

/**
 * Kill a list of orphan processes via process-group SIGTERM, then
 * SIGKILL after a grace window. Mirrors `killProcessTree` from
 * process-manager.ts but acts on PIDs we found out-of-band rather than
 * on a Bun.spawn handle we own.
 *
 * Returns counts. Best-effort: a failure to signal a process (already
 * dead, permission denied) is recorded as `failed++` but never throws.
 *
 * `killFn` is a seam for tests — defaults to `process.kill`.
 */
export async function reapOrphans(
  orphans: OrphanProcess[],
  opts: {
    /** Grace window in ms between SIGTERM and SIGKILL. Default 1500. */
    graceMs?: number;
    /** Override process.kill (for tests). */
    killFn?: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  } = {},
): Promise<{ killed: number; failed: number }> {
  const graceMs = opts.graceMs ?? 1500;
  const killFn = opts.killFn ?? ((pid, sig) => process.kill(pid, sig));

  let killed = 0;
  let failed = 0;

  const targets = orphans.map((o) => o.pid);

  // Round 1: SIGTERM each process group. Negative pid = group target.
  for (const pid of targets) {
    let signaled = false;
    try {
      killFn(-pid, "SIGTERM");
      signaled = true;
    } catch {
      // Group target failed (no group, or already dead). Try direct.
      try {
        killFn(pid, "SIGTERM");
        signaled = true;
      } catch {
        // Already gone.
      }
    }
    if (signaled) killed++;
    else failed++;
  }

  if (targets.length === 0) return { killed: 0, failed: 0 };

  // Grace window — wait for well-behaved processes to exit.
  await new Promise((resolve) => setTimeout(resolve, graceMs));

  // Round 2: SIGKILL anything still alive. We don't try to detect
  // "still alive" precisely; we just signal everything and ignore
  // ESRCH (process already exited).
  for (const pid of targets) {
    try {
      killFn(-pid, "SIGKILL");
    } catch {
      try {
        killFn(pid, "SIGKILL");
      } catch {
        // Already gone — that's the success case.
      }
    }
  }

  return { killed, failed };
}
