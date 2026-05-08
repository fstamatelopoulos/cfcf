/**
 * Tests for the orphan-process detector + reaper (item 6.31 sub-(b)+(c)).
 *
 * The matcher is the load-bearing piece — false positives could kill
 * unrelated processes, false negatives leave orphans serializing on
 * ollama. Tests cover each cfcf-spawn pattern, the user filter, the
 * PPID==1 filter, the reap-loop semantics, and the formatter.
 */

import { describe, test, expect } from "bun:test";
import {
  parsePsOutput,
  classifyCommand,
  filterOrphans,
  formatOrphanLine,
  reapOrphans,
  type OrphanProcess,
} from "./orphan-reaper.js";

describe("classifyCommand", () => {
  test("matches claude-code (claude -p with --dangerously-skip-permissions)", () => {
    expect(classifyCommand("claude -p --dangerously-skip-permissions \"do thing\"")).toBe(
      "claude-code",
    );
    expect(classifyCommand("/usr/local/bin/claude --dangerously-skip-permissions -p hello")).toBe(
      "claude-code",
    );
    expect(classifyCommand("claude --print --dangerously-skip-permissions blah")).toBe(
      "claude-code",
    );
  });

  test("does NOT match interactive claude (no -p)", () => {
    expect(classifyCommand("claude --dangerously-skip-permissions")).toBeNull();
    expect(classifyCommand("claude")).toBeNull();
  });

  test("does NOT match claude -p without the danger flag", () => {
    // Hand-typed claude -p from another shell would not have the
    // danger flag — leave it alone.
    expect(classifyCommand("claude -p \"hi\"")).toBeNull();
  });

  test("matches codex (exec + danger-full-access)", () => {
    expect(classifyCommand("codex -a never exec -s danger-full-access \"prompt\"")).toBe("codex");
    expect(classifyCommand("/opt/codex exec -s danger-full-access foo")).toBe("codex");
  });

  test("does NOT match codex without the danger flag", () => {
    expect(classifyCommand("codex exec \"hi\"")).toBeNull();
  });

  test("matches opencode (run + --dangerously-skip-permissions)", () => {
    expect(classifyCommand("opencode run --dangerously-skip-permissions \"prompt\"")).toBe(
      "opencode",
    );
    expect(classifyCommand("/usr/bin/opencode run --dangerously-skip-permissions x")).toBe(
      "opencode",
    );
  });

  test("does NOT match interactive opencode", () => {
    expect(classifyCommand("opencode")).toBeNull();
    expect(classifyCommand("opencode tui")).toBeNull();
  });

  test("matches `ollama launch claude --yes`", () => {
    expect(
      classifyCommand("ollama launch claude --model gemma4:31b --yes -- --dangerously-skip-permissions -p hi"),
    ).toBe("ollama-launch-claude");
  });

  test("matches `ollama launch codex --yes`", () => {
    expect(classifyCommand("ollama launch codex --yes -- exec foo")).toBe(
      "ollama-launch-codex",
    );
  });

  test("matches `ollama launch opencode --yes`", () => {
    expect(
      classifyCommand("ollama launch opencode --model qwen3-coder:latest --yes -- run hi"),
    ).toBe("ollama-launch-opencode");
  });

  test("does NOT match ollama serve / pull / other", () => {
    expect(classifyCommand("ollama serve")).toBeNull();
    expect(classifyCommand("ollama pull qwen3-coder")).toBeNull();
    expect(classifyCommand("ollama list")).toBeNull();
  });

  test("does NOT match unrelated commands", () => {
    expect(classifyCommand("node server.js")).toBeNull();
    expect(classifyCommand("python -p hello")).toBeNull();
    expect(classifyCommand("bun run dev")).toBeNull();
  });
});

describe("parsePsOutput", () => {
  test("parses standard ps -eo output with header", () => {
    const stdout = `  PID  PPID USER             ELAPSED COMMAND
    1     0 root          12-04:15:22 /sbin/launchd
12345     1 fotis            05:32 ollama launch claude --model gemma4 --yes -- -p hi
12346 12345 fotis            05:31 claude -p --dangerously-skip-permissions "hi"
`;
    const rows = parsePsOutput(stdout);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      pid: 1,
      ppid: 0,
      user: "root",
      etime: "12-04:15:22",
      command: "/sbin/launchd",
    });
    expect(rows[1].pid).toBe(12345);
    expect(rows[1].ppid).toBe(1);
    expect(rows[1].command).toBe("ollama launch claude --model gemma4 --yes -- -p hi");
    expect(rows[2].command).toBe('claude -p --dangerously-skip-permissions "hi"');
  });

  test("returns empty array for empty / header-only input", () => {
    expect(parsePsOutput("")).toEqual([]);
    expect(parsePsOutput("PID PPID USER ELAPSED COMMAND\n")).toEqual([]);
  });

  test("skips malformed lines without throwing", () => {
    const stdout = `  PID  PPID USER             ELAPSED COMMAND
1 2 fotis 05:00 valid command
this is garbage
99 100 fotis 06:00 also valid
`;
    const rows = parsePsOutput(stdout);
    expect(rows).toHaveLength(2);
    expect(rows[0].pid).toBe(1);
    expect(rows[1].pid).toBe(99);
  });
});

describe("filterOrphans", () => {
  const sample = [
    // Orphan: ppid=1, user matches, command matches → keep
    { pid: 100, ppid: 1, user: "fotis", etime: "05:00", command: "ollama launch claude --yes -- -p hi" },
    // Live cfcf child: ppid != 1 → skip
    { pid: 200, ppid: 9999, user: "fotis", etime: "05:00", command: "ollama launch claude --yes -- -p hi" },
    // Other user: skip even with ppid=1 + matching command
    { pid: 300, ppid: 1, user: "alice", etime: "05:00", command: "ollama launch claude --yes -- -p hi" },
    // Wrong command shape: skip
    { pid: 400, ppid: 1, user: "fotis", etime: "05:00", command: "ollama serve" },
    // Codex orphan: keep
    { pid: 500, ppid: 1, user: "fotis", etime: "10:00", command: "codex exec -s danger-full-access" },
    // Hand-typed claude (no danger flag): skip
    { pid: 600, ppid: 1, user: "fotis", etime: "00:01", command: "claude -p hi" },
  ];

  test("keeps orphans matching all three filters", () => {
    const result = filterOrphans(sample, "fotis");
    const pids = result.map((o) => o.pid).sort();
    expect(pids).toEqual([100, 500]);
  });

  test("respects the user filter (different user → no matches)", () => {
    const result = filterOrphans(sample, "bob");
    expect(result).toHaveLength(0);
  });

  test("returns empty for empty input", () => {
    expect(filterOrphans([], "fotis")).toEqual([]);
  });

  test("attaches kind label to each kept row", () => {
    const result = filterOrphans(sample, "fotis");
    const byPid = new Map(result.map((o) => [o.pid, o.kind]));
    expect(byPid.get(100)).toBe("ollama-launch-claude");
    expect(byPid.get(500)).toBe("codex");
  });
});

describe("formatOrphanLine", () => {
  test("renders a one-line summary with pid + kind + elapsed + command", () => {
    const o: OrphanProcess = {
      pid: 12345,
      ppid: 1,
      user: "fotis",
      etime: "05:32",
      command: "ollama launch claude --model gemma4 --yes -- -p hi",
      kind: "ollama-launch-claude",
    };
    const line = formatOrphanLine(o);
    expect(line).toContain("pid=12345");
    expect(line).toContain("kind=ollama-launch-claude");
    expect(line).toContain("elapsed=05:32");
    expect(line).toContain("ollama launch claude");
  });

  test("truncates very long commands with an ellipsis", () => {
    const longCmd = "ollama launch claude --model x --yes -- " + "a".repeat(200);
    const o: OrphanProcess = {
      pid: 1,
      ppid: 1,
      user: "fotis",
      etime: "00:01",
      command: longCmd,
      kind: "ollama-launch-claude",
    };
    const line = formatOrphanLine(o);
    // Cap is ~80 chars on the command portion; total line still readable.
    expect(line).toContain("…");
    expect(line.length).toBeLessThan(longCmd.length);
  });
});

describe("reapOrphans", () => {
  const sample: OrphanProcess[] = [
    { pid: 1001, ppid: 1, user: "fotis", etime: "01:00", command: "claude -p --dangerously-skip-permissions x", kind: "claude-code" },
    { pid: 1002, ppid: 1, user: "fotis", etime: "02:00", command: "ollama launch claude --yes", kind: "ollama-launch-claude" },
  ];

  test("returns zero counts when given empty list", async () => {
    const calls: Array<[number, NodeJS.Signals | number | undefined]> = [];
    const killFn = (pid: number, sig?: NodeJS.Signals | number) => {
      calls.push([pid, sig]);
      return true;
    };
    const result = await reapOrphans([], { graceMs: 0, killFn });
    expect(result).toEqual({ killed: 0, failed: 0 });
    expect(calls).toHaveLength(0);
  });

  test("sends SIGTERM to each process group, then SIGKILL after grace", async () => {
    const calls: Array<[number, NodeJS.Signals | number | undefined]> = [];
    const killFn = (pid: number, sig?: NodeJS.Signals | number) => {
      calls.push([pid, sig]);
      return true;
    };
    const result = await reapOrphans(sample, { graceMs: 0, killFn });
    expect(result.killed).toBe(2);
    expect(result.failed).toBe(0);

    // SIGTERM round: -1001, -1002 (group targets)
    const termCalls = calls.filter((c) => c[1] === "SIGTERM");
    expect(new Set(termCalls.map((c) => c[0]))).toEqual(new Set([-1001, -1002]));

    // SIGKILL round: -1001, -1002
    const killCalls = calls.filter((c) => c[1] === "SIGKILL");
    expect(new Set(killCalls.map((c) => c[0]))).toEqual(new Set([-1001, -1002]));
  });

  test("falls back to direct PID kill when group kill throws ESRCH", async () => {
    const calls: Array<[number, NodeJS.Signals | number | undefined, "ok" | "throw"]> = [];
    const killFn = (pid: number, sig?: NodeJS.Signals | number) => {
      // Simulate group kill failing for all calls (ESRCH on group),
      // but direct PID kill succeeding.
      if (pid < 0) {
        calls.push([pid, sig, "throw"]);
        throw new Error("ESRCH");
      }
      calls.push([pid, sig, "ok"]);
      return true;
    };
    const result = await reapOrphans(sample, { graceMs: 0, killFn });
    expect(result.killed).toBe(2);
    expect(result.failed).toBe(0);

    // Group SIGTERMs threw; we then fell back to direct SIGTERM
    // (positive pid) and that succeeded.
    const directTerms = calls.filter(
      (c) => c[1] === "SIGTERM" && c[2] === "ok" && c[0] > 0,
    );
    expect(new Set(directTerms.map((c) => c[0]))).toEqual(new Set([1001, 1002]));
  });

  test("counts processes that fail both group + direct kill as `failed`", async () => {
    const killFn = () => {
      throw new Error("EPERM");
    };
    const result = await reapOrphans(sample, { graceMs: 0, killFn });
    expect(result.killed).toBe(0);
    expect(result.failed).toBe(2);
  });
});
