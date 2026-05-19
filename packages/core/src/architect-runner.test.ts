/**
 * Tests for the architect runner module.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, writeFile, rm } from "fs/promises";
import { mkdtemp, rm as rmTmp, mkdir as mkdirTmp } from "fs/promises";
import { tmpdir } from "os";
import {
  writeArchitectInstructions,
  resetArchitectSignals,
  parseArchitectSignals,
  countPlanItems,
  diagnoseFailedArchitectSignals,
  flipTerminalStatusToIdle,
  TERMINAL_LOOP_STATUSES,
} from "./architect-runner.js";
import { createWorkspace, getWorkspace, updateWorkspace } from "./workspaces.js";
import type { WorkspaceConfig, ArchitectSignals, WorkspaceStatus } from "./types.js";

const TEST_DIR = join(import.meta.dir, "..", ".test-architect-runner");

function makeProject(overrides?: Partial<WorkspaceConfig>): WorkspaceConfig {
  return {
    id: "test-proj",
    name: "test-project",
    repoPath: TEST_DIR,
    devAgent: { adapter: "claude-code" },
    judgeAgent: { adapter: "codex" },
    architectAgent: { adapter: "claude-code" },
    documenterAgent: { adapter: "claude-code" },
    maxIterations: 10,
    pauseEvery: 0,
    onStalled: "alert",
    mergeStrategy: "auto",
    processTemplate: "default",
    currentIteration: 0,
    ...overrides,
  };
}

beforeEach(async () => {
  await mkdir(join(TEST_DIR, "cfcf-docs"), { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("writeArchitectInstructions", () => {
  test("writes instructions with project name", async () => {
    await writeArchitectInstructions(TEST_DIR, makeProject({ name: "my-app" }));
    const { readFile } = await import("fs/promises");
    const content = await readFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-instructions.md"),
      "utf-8",
    );
    expect(content).toContain("my-app");
    expect(content).not.toContain("{{PROJECT_NAME}}");
    expect(content).toContain("Solution Architect");
    expect(content).toContain("plan.md");
  });
});

describe("resetArchitectSignals", () => {
  test("writes template signal file", async () => {
    await resetArchitectSignals(TEST_DIR);
    const { readFile } = await import("fs/promises");
    const content = await readFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      "utf-8",
    );
    const signals = JSON.parse(content);
    expect(signals.readiness).toBe("NEEDS_REFINEMENT");
    expect(signals.gaps).toEqual([]);
  });
});

describe("parseArchitectSignals", () => {
  test("returns null for untouched template", async () => {
    await resetArchitectSignals(TEST_DIR);
    const result = await parseArchitectSignals(TEST_DIR);
    expect(result).toBeNull();
  });

  test("returns parsed signals when filled in", async () => {
    const signals: ArchitectSignals = {
      readiness: "READY",
      gaps: ["Missing error handling spec"],
      suggestions: ["Add rate limiting"],
      risks: ["External API dependency"],
      recommended_approach: "Use Express with Zod validation",
    };
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      JSON.stringify(signals),
      "utf-8",
    );
    const result = await parseArchitectSignals(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.readiness).toBe("READY");
    expect(result!.gaps).toHaveLength(1);
    expect(result!.recommended_approach).toContain("Express");
  });

  test("returns null for missing file", async () => {
    const result = await parseArchitectSignals("/nonexistent");
    expect(result).toBeNull();
  });

  test("returns null for malformed JSON", async () => {
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      "not json",
      "utf-8",
    );
    const result = await parseArchitectSignals(TEST_DIR);
    expect(result).toBeNull();
  });

  test("returns null when readiness is missing", async () => {
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      JSON.stringify({ gaps: ["something"] }),
      "utf-8",
    );
    const result = await parseArchitectSignals(TEST_DIR);
    expect(result).toBeNull();
  });

  // Regression: 2026-05-08 — parseArchitectSignals used to reject ANY
  // submission with all-empty supporting fields as "untouched template",
  // which conflated two genuinely different cases:
  //   (a) The agent never edited the file. Reject.
  //   (b) The agent legitimately found nothing to add (a clean re-review
  //       of a complete project). With readiness == READY or
  //       SCOPE_COMPLETE, empty arrays + null recommended_approach are
  //       the correct semantic answer.
  // Surfaced when qwen3-coder ran the SA on a calc workspace whose plan
  // was 100% complete; qwen produced READY + empty arrays (correct) and
  // cfcf paused with "signal file missing or malformed" (incorrect).
  // Fix: only reject empty supporting fields when readiness is one of
  // the values that semantically demand explanation (NEEDS_REFINEMENT,
  // BLOCKED). The four tests below pin both halves of the contract.

  test("accepts READY with empty supporting fields (clean re-review verdict)", async () => {
    const signals: ArchitectSignals = {
      readiness: "READY",
      gaps: [],
      suggestions: [],
      risks: [],
      // recommended_approach intentionally omitted — equivalent to null
    };
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      JSON.stringify(signals),
      "utf-8",
    );
    const result = await parseArchitectSignals(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.readiness).toBe("READY");
  });

  test("accepts SCOPE_COMPLETE with empty supporting fields", async () => {
    const signals: ArchitectSignals = {
      readiness: "SCOPE_COMPLETE",
      gaps: [],
      suggestions: [],
      risks: [],
    };
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      JSON.stringify(signals),
      "utf-8",
    );
    const result = await parseArchitectSignals(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.readiness).toBe("SCOPE_COMPLETE");
  });

  test("rejects NEEDS_REFINEMENT with empty fields (untouched template)", async () => {
    // The cfcf template ships with `readiness: "NEEDS_REFINEMENT"` + all
    // empty arrays + null recommended_approach. If we get this exact
    // shape back, the agent never touched the file.
    const signals: ArchitectSignals = {
      readiness: "NEEDS_REFINEMENT",
      gaps: [],
      suggestions: [],
      risks: [],
    };
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      JSON.stringify(signals),
      "utf-8",
    );
    const result = await parseArchitectSignals(TEST_DIR);
    expect(result).toBeNull();
  });

  test("rejects BLOCKED with empty fields (template-shaped)", async () => {
    // BLOCKED with no gaps/risks/suggestions is suspicious — if the
    // agent really meant BLOCKED, it should explain why. Treat as
    // template-untouched.
    const signals: ArchitectSignals = {
      readiness: "BLOCKED",
      gaps: [],
      suggestions: [],
      risks: [],
    };
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      JSON.stringify(signals),
      "utf-8",
    );
    const result = await parseArchitectSignals(TEST_DIR);
    expect(result).toBeNull();
  });

  // Regression: 2026-05-08 — agents (qwen3-coder specifically) returning
  // READY for a fully-shipped project where the right answer is
  // SCOPE_COMPLETE. Defensive auto-promotion in parseArchitectSignals
  // checks plan.md and overrides READY → SCOPE_COMPLETE when there are
  // completed items and zero pending. Tests below pin the boundary
  // conditions.

  test("promotes READY → SCOPE_COMPLETE when plan.md has all completed items + zero pending", async () => {
    const signals: ArchitectSignals = {
      readiness: "READY",
      gaps: [],
      suggestions: [],
      risks: [],
    };
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      JSON.stringify(signals),
      "utf-8",
    );
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "plan.md"),
      "# Plan\n\n- [x] Done item one\n- [x] Done item two\n",
      "utf-8",
    );
    const result = await parseArchitectSignals(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.readiness).toBe("SCOPE_COMPLETE");
  });

  test("does NOT promote READY when plan.md still has pending items", async () => {
    const signals: ArchitectSignals = {
      readiness: "READY",
      gaps: [],
      suggestions: [],
      risks: [],
    };
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      JSON.stringify(signals),
      "utf-8",
    );
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "plan.md"),
      "# Plan\n\n- [x] Done\n- [ ] Pending one\n- [ ] Pending two\n",
      "utf-8",
    );
    const result = await parseArchitectSignals(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.readiness).toBe("READY");
  });

  test("does NOT promote READY when plan.md is empty (first-run mode)", async () => {
    // No `[x]` items + no `[ ]` items = no plan yet (first-run
    // architect just scaffolded an empty stub, or the file is
    // missing). Don't auto-promote — we'd be inferring SCOPE_COMPLETE
    // from absence-of-data which is not safe.
    const signals: ArchitectSignals = {
      readiness: "READY",
      gaps: [],
      suggestions: [],
      risks: [],
    };
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      JSON.stringify(signals),
      "utf-8",
    );
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "plan.md"),
      "# Plan\n\nTodo list will go here.\n",
      "utf-8",
    );
    const result = await parseArchitectSignals(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.readiness).toBe("READY");
  });

  test("does NOT promote READY when plan.md is missing", async () => {
    const signals: ArchitectSignals = {
      readiness: "READY",
      gaps: [],
      suggestions: [],
      risks: [],
    };
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      JSON.stringify(signals),
      "utf-8",
    );
    // Don't create plan.md
    const result = await parseArchitectSignals(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.readiness).toBe("READY");
  });

  test("does NOT touch SCOPE_COMPLETE / NEEDS_REFINEMENT / BLOCKED verdicts", async () => {
    // Auto-promotion only fires when readiness === "READY". Other
    // verdicts pass through unchanged regardless of plan.md state.
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "plan.md"),
      "# Plan\n\n- [x] Done one\n- [x] Done two\n",
      "utf-8",
    );
    for (const r of ["SCOPE_COMPLETE", "NEEDS_REFINEMENT", "BLOCKED"] as const) {
      const signals: ArchitectSignals = {
        readiness: r,
        gaps: r === "SCOPE_COMPLETE" ? [] : ["dummy gap"],
        suggestions: r === "SCOPE_COMPLETE" ? [] : ["dummy suggestion"],
        risks: r === "SCOPE_COMPLETE" ? [] : ["dummy risk"],
      };
      await writeFile(
        join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
        JSON.stringify(signals),
        "utf-8",
      );
      const result = await parseArchitectSignals(TEST_DIR);
      expect(result).not.toBeNull();
      expect(result!.readiness).toBe(r);
    }
  });
});

describe("diagnoseFailedArchitectSignals (item 6.31 follow-up — pause-message diagnostics)", () => {
  test("returns 'missing' when signals file doesn't exist", async () => {
    // Don't create the file
    const result = await diagnoseFailedArchitectSignals(TEST_DIR);
    expect(result).toBe("missing");
  });

  test("returns 'malformed_json' when file exists but isn't valid JSON", async () => {
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      "not json at all { broken",
      "utf-8",
    );
    const result = await diagnoseFailedArchitectSignals(TEST_DIR);
    expect(result).toBe("malformed_json");
  });

  test("returns 'missing_readiness' when JSON parses but readiness field is absent", async () => {
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      JSON.stringify({ gaps: ["something"], suggestions: [] }),
      "utf-8",
    );
    const result = await diagnoseFailedArchitectSignals(TEST_DIR);
    expect(result).toBe("missing_readiness");
  });

  test("returns 'untouched_template' when file is the literal template (NEEDS_REFINEMENT + all empty + null approach)", async () => {
    // Exact shape that ships in cfcf's template + that opencode-ollama
    // produced on 2026-05-08 when it hung mid-session.
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      JSON.stringify({
        readiness: "NEEDS_REFINEMENT",
        gaps: [],
        suggestions: [],
        risks: [],
        recommended_approach: null,
      }),
      "utf-8",
    );
    const result = await diagnoseFailedArchitectSignals(TEST_DIR);
    expect(result).toBe("untouched_template");
  });

  test("returns 'valid' when the file is actually a valid signals payload (race-condition guard)", async () => {
    // Caller calls this only when parseArchitectSignals returned null,
    // but the file might have appeared between the two calls. Verifying
    // we don't lie about a now-valid file.
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      JSON.stringify({
        readiness: "READY",
        gaps: [],
        suggestions: ["Add docs"],
        risks: [],
        recommended_approach: "Use Express",
      }),
      "utf-8",
    );
    const result = await diagnoseFailedArchitectSignals(TEST_DIR);
    expect(result).toBe("valid");
  });

  test("does NOT classify a NEEDS_REFINEMENT-with-real-content as untouched-template", async () => {
    // If the agent reported NEEDS_REFINEMENT with actual gaps/suggestions,
    // that's a legitimate verdict — not a template.
    await writeFile(
      join(TEST_DIR, "cfcf-docs", "cfcf-architect-signals.json"),
      JSON.stringify({
        readiness: "NEEDS_REFINEMENT",
        gaps: ["Missing auth flow specification"],
        suggestions: [],
        risks: [],
      }),
      "utf-8",
    );
    const result = await diagnoseFailedArchitectSignals(TEST_DIR);
    expect(result).toBe("valid");
  });
});

describe("countPlanItems", () => {
  test("counts standard `- [ ]` and `- [x]` checkboxes", () => {
    const plan = `# Plan

## Iteration 1
- [x] First item
- [x] Second item

## Iteration 2
- [ ] Pending one
- [ ] Pending two
- [x] Already done in iter 2
`;
    expect(countPlanItems(plan)).toEqual({ pending: 2, completed: 3 });
  });

  test("accepts capital X for completed items", () => {
    expect(countPlanItems("- [X] Done\n- [x] Also done\n")).toEqual({ pending: 0, completed: 2 });
  });

  test("accepts `*` and `+` bullet markers", () => {
    expect(countPlanItems("* [x] one\n+ [ ] two\n- [x] three\n")).toEqual({ pending: 1, completed: 2 });
  });

  test("ignores non-checkbox lines", () => {
    const plan = `# Plan

Regular text lines aren't counted.
And [bracketed text] without checkboxes isn't either.
- Plain bullet, no checkbox
- [x] This counts
`;
    expect(countPlanItems(plan)).toEqual({ pending: 0, completed: 1 });
  });

  test("returns zeros for an empty plan", () => {
    expect(countPlanItems("")).toEqual({ pending: 0, completed: 0 });
    expect(countPlanItems("# Plan\n\nNo checkboxes here.\n")).toEqual({ pending: 0, completed: 0 });
  });
});

// ── flipTerminalStatusToIdle (v0.24.5) ───────────────────────────────────
//
// Tests the explicit-trigger transition for the
// "ready/iterating" status. When a user runs `cfcf review` on a
// workspace whose loop has already terminated (completed / failed
// / stopped), the workspace.status flips back to `idle` so the
// dashboard badge accurately reflects "we're preparing new scope."
//
// Tests use a real tmpdir-backed CFCF_CONFIG_DIR + createWorkspace
// because the flip uses the real updateWorkspace path. Cheap
// enough (~ms per test) for the fidelity gained.

describe("flipTerminalStatusToIdle (v0.24.5 status-iterating transition)", () => {
  let configDir: string;
  let repoDir: string;
  const originalConfigDir = process.env.CFCF_CONFIG_DIR;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "cfcf-flip-test-"));
    process.env.CFCF_CONFIG_DIR = configDir;
    repoDir = join(configDir, "fake-repo");
    await mkdirTmp(join(repoDir, ".git"), { recursive: true });
  });

  afterEach(async () => {
    process.env.CFCF_CONFIG_DIR = originalConfigDir;
    await rmTmp(configDir, { recursive: true, force: true });
  });

  test("TERMINAL_LOOP_STATUSES contains exactly completed, failed, stopped", () => {
    // Lock the set so future edits can't silently expand it. Each
    // entry is a deliberate inclusion — see the helper's docstring.
    expect([...TERMINAL_LOOP_STATUSES].sort()).toEqual(["completed", "failed", "stopped"]);
  });

  test("flips from 'completed' to 'idle' (the user-reported gmbot case)", async () => {
    const ws = await createWorkspace({ name: "gmbot-test", repoPath: repoDir });
    await updateWorkspace(ws.id, { status: "completed" });
    const refreshed = await getWorkspace(ws.id);
    expect(refreshed?.status).toBe("completed");

    const flipped = await flipTerminalStatusToIdle(refreshed!);
    expect(flipped).toBe(true);

    const after = await getWorkspace(ws.id);
    expect(after?.status).toBe("idle");
  });

  test("flips from 'failed' to 'idle'", async () => {
    const ws = await createWorkspace({ name: "failed-test", repoPath: repoDir });
    await updateWorkspace(ws.id, { status: "failed" });
    const refreshed = await getWorkspace(ws.id);

    const flipped = await flipTerminalStatusToIdle(refreshed!);
    expect(flipped).toBe(true);
    expect((await getWorkspace(ws.id))?.status).toBe("idle");
  });

  test("flips from 'stopped' to 'idle'", async () => {
    const ws = await createWorkspace({ name: "stopped-test", repoPath: repoDir });
    await updateWorkspace(ws.id, { status: "stopped" });
    const refreshed = await getWorkspace(ws.id);

    const flipped = await flipTerminalStatusToIdle(refreshed!);
    expect(flipped).toBe(true);
    expect((await getWorkspace(ws.id))?.status).toBe("idle");
  });

  test("does NOT flip 'paused' (paused stays paused — preserves resume mechanics)", async () => {
    // The load-bearing non-flip case: a paused loop awaiting user
    // input must NOT be reset by a standalone `cfcf review` —
    // otherwise the resume mechanics + `refine_plan` action break.
    // The user wants SA output WHILE the loop stays pause-resumable.
    const ws = await createWorkspace({ name: "paused-test", repoPath: repoDir });
    await updateWorkspace(ws.id, { status: "paused" });
    const refreshed = await getWorkspace(ws.id);

    const flipped = await flipTerminalStatusToIdle(refreshed!);
    expect(flipped).toBe(false);
    expect((await getWorkspace(ws.id))?.status).toBe("paused");
  });

  test("does NOT flip 'running' (no-op on already-running loop)", async () => {
    const ws = await createWorkspace({ name: "running-test", repoPath: repoDir });
    await updateWorkspace(ws.id, { status: "running" });
    const refreshed = await getWorkspace(ws.id);

    const flipped = await flipTerminalStatusToIdle(refreshed!);
    expect(flipped).toBe(false);
    expect((await getWorkspace(ws.id))?.status).toBe("running");
  });

  test("does NOT flip 'idle' (already idle — no-op, safe to call unconditionally)", async () => {
    const ws = await createWorkspace({ name: "idle-test", repoPath: repoDir });
    // workspaces default to idle on creation — no explicit update needed.
    const refreshed = await getWorkspace(ws.id);
    expect(refreshed?.status).toBe("idle");

    const flipped = await flipTerminalStatusToIdle(refreshed!);
    expect(flipped).toBe(false);
    expect((await getWorkspace(ws.id))?.status).toBe("idle");
  });

  test("handles workspace with undefined status (defensive — older workspaces)", async () => {
    // Defensive: a workspace persisted without `status` (very old
    // workspaces, or a corrupted config). Should not flip — undefined
    // isn't a terminal status. No throw.
    const ws = await createWorkspace({ name: "undef-test", repoPath: repoDir });
    const wsWithoutStatus = { ...ws, status: undefined } as WorkspaceConfig & { status?: WorkspaceStatus };

    const flipped = await flipTerminalStatusToIdle(wsWithoutStatus);
    expect(flipped).toBe(false);
  });
});
