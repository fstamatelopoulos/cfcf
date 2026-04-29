/**
 * Tests for the Product Architect launcher (v2; Pattern A argv builder).
 *
 * The actual spawn isn't covered (interactive agent CLI; not testable
 * in unit form). These tests cover argv construction + adapter
 * dispatch + that we no longer use Pattern B.
 *
 * Plan item 5.14 (v2).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { buildLaunchArgs } from "./launcher.js";

// Track tempfiles created by codex-path tests so we can clean them up.
const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const p = cleanupPaths.pop()!;
    try { rmSync(dirname(p), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe("buildLaunchArgs (Pattern A)", () => {
  it("dispatches claude-code with --append-system-prompt + sonnet default + no tempfile", () => {
    const out = buildLaunchArgs({ adapter: "claude-code" }, "PA system prompt body", "Hello");
    expect(out.command).toBe("claude");
    expect(out.tempPromptFile).toBeNull();
    expect(out.args).toContain("--append-system-prompt");
    const flagIdx = out.args.indexOf("--append-system-prompt");
    expect(out.args[flagIdx + 1]).toBe("PA system prompt body");
    const modelIdx = out.args.indexOf("--model");
    expect(out.args[modelIdx + 1]).toBe("sonnet");
  });

  it("respects the configured model override for claude-code", () => {
    const out = buildLaunchArgs({ adapter: "claude-code", model: "opus" }, "x", "Hello");
    const modelIdx = out.args.indexOf("--model");
    expect(out.args[modelIdx + 1]).toBe("opus");
  });

  it("dispatches codex with model_instructions_file tempfile + no inline model when none configured", () => {
    const out = buildLaunchArgs({ adapter: "codex" }, "PA prompt for codex", "Hello");
    expect(out.command).toBe("codex");
    expect(out.tempPromptFile).not.toBeNull();
    cleanupPaths.push(out.tempPromptFile!);

    // -c arg must reference the tempfile
    const cIdx = out.args.indexOf("-c");
    expect(cIdx).toBeGreaterThanOrEqual(0);
    expect(out.args[cIdx + 1]).toMatch(/^model_instructions_file=".+\/pa-instructions\.md"$/);

    // No --model when not configured (codex is account-tied)
    expect(out.args).not.toContain("--model");
  });

  it("respects the configured model for codex when set", () => {
    const out = buildLaunchArgs({ adapter: "codex", model: "gpt-5" }, "x", "Hello");
    cleanupPaths.push(out.tempPromptFile!);
    const modelIdx = out.args.indexOf("--model");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(out.args[modelIdx + 1]).toBe("gpt-5");
  });

  it("throws on unknown adapters with a config-edit hint", () => {
    expect(() => buildLaunchArgs({ adapter: "aider" }, "x", "Hello")).toThrow(
      /Product Architect doesn't support adapter "aider"/,
    );
    expect(() => buildLaunchArgs({ adapter: "aider" }, "x", "Hello")).toThrow(
      /productArchitectAgent/,
    );
  });

  it("appends the firstUserMessage as the LAST positional argv entry (Flavour A) for claude-code", () => {
    const out = buildLaunchArgs({ adapter: "claude-code" }, "system", "Please introduce yourself");
    expect(out.args[out.args.length - 1]).toBe("Please introduce yourself");
    // It must come AFTER --append-system-prompt + --model — i.e. as a true positional.
    const appendIdx = out.args.indexOf("--append-system-prompt");
    const modelIdx = out.args.indexOf("--model");
    expect(out.args.length - 1).toBeGreaterThan(appendIdx);
    expect(out.args.length - 1).toBeGreaterThan(modelIdx);
  });

  it("appends the firstUserMessage as the LAST positional argv entry (Flavour A) for codex", () => {
    const out = buildLaunchArgs({ adapter: "codex" }, "system", "Please introduce yourself");
    cleanupPaths.push(out.tempPromptFile!);
    expect(out.args[out.args.length - 1]).toBe("Please introduce yourself");
    // It must come AFTER -c <model_instructions_file=...>
    const cIdx = out.args.indexOf("-c");
    expect(out.args.length - 1).toBeGreaterThan(cIdx);
  });

  it("claude-code: defaults to FULL permissions (matches iteration-time agents)", () => {
    const out = buildLaunchArgs({ adapter: "claude-code" }, "system", "Hello");
    expect(out.args).toContain("--dangerously-skip-permissions");
  });

  it("claude-code: --safe opts back into per-command permission prompts", () => {
    const out = buildLaunchArgs({ adapter: "claude-code" }, "system", "Hello", true);
    expect(out.args).not.toContain("--dangerously-skip-permissions");
  });

  it("codex: defaults to approval_policy=never + sandbox_mode=danger-full-access", () => {
    const out = buildLaunchArgs({ adapter: "codex" }, "system", "Hello");
    cleanupPaths.push(out.tempPromptFile!);
    // approval_policy=never override should be present
    const approvalIdx = out.args.findIndex((a) => a.startsWith("approval_policy="));
    expect(approvalIdx).toBeGreaterThanOrEqual(0);
    expect(out.args[approvalIdx]).toMatch(/approval_policy="?never"?/);
    // sandbox_mode=danger-full-access override should be present
    const sandboxIdx = out.args.findIndex((a) => a.startsWith("sandbox_mode="));
    expect(sandboxIdx).toBeGreaterThanOrEqual(0);
    expect(out.args[sandboxIdx]).toMatch(/sandbox_mode="?danger-full-access"?/);
  });

  it("codex: --safe omits the approval/sandbox overrides (default codex behaviour)", () => {
    const out = buildLaunchArgs({ adapter: "codex" }, "system", "Hello", true);
    cleanupPaths.push(out.tempPromptFile!);
    const hasApproval = out.args.some((a) => a.startsWith("approval_policy="));
    const hasSandbox = out.args.some((a) => a.startsWith("sandbox_mode="));
    expect(hasApproval).toBe(false);
    expect(hasSandbox).toBe(false);
  });

  it("does NOT use Pattern B mechanics (no auto-loaded AGENTS.md / CLAUDE.md briefing)", () => {
    // claude-code path: prompt is in the --append flag, not in a file.
    const cc = buildLaunchArgs({ adapter: "claude-code" }, "PA", "Hello");
    expect(cc.tempPromptFile).toBeNull();

    // codex path: prompt is in the tempfile (which is per-session,
    // ephemeral, not in the user's repo).
    const cx = buildLaunchArgs({ adapter: "codex" }, "PA", "Hello");
    cleanupPaths.push(cx.tempPromptFile!);
    expect(cx.tempPromptFile).toContain("/cfcf-pa-");
    // NOT a path inside the user's repo (Pattern B v1 wrote to
    // <repo>/cfcf-docs/AGENTS.md).
    expect(cx.tempPromptFile).not.toContain("cfcf-docs");
  });
});
