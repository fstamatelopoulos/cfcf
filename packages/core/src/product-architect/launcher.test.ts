/**
 * Tests for the Product Architect launcher (Pattern B argv builder).
 *
 * The actual spawn isn't covered (the launcher inherits stdio + waits
 * for an interactive agent CLI -- not testable in unit form). These
 * tests cover argv construction + cwd selection + adapter dispatch.
 *
 * Plan item 5.14.
 */
import { describe, expect, it } from "bun:test";
import { buildLaunchArgs } from "./launcher.js";

describe("buildLaunchArgs", () => {
  it("dispatches claude-code with --cd <repo>/cfcf-docs/ + sonnet default", () => {
    const out = buildLaunchArgs({ adapter: "claude-code" }, "/repo");
    expect(out.command).toBe("claude");
    expect(out.cwd).toBe("/repo/cfcf-docs");
    expect(out.args).toContain("--model");
    const idx = out.args.indexOf("--model");
    expect(out.args[idx + 1]).toBe("sonnet");
  });

  it("respects the configured model override for claude-code", () => {
    const out = buildLaunchArgs({ adapter: "claude-code", model: "opus" }, "/repo");
    const idx = out.args.indexOf("--model");
    expect(out.args[idx + 1]).toBe("opus");
  });

  it("dispatches codex with no --model when none configured (account-tied)", () => {
    const out = buildLaunchArgs({ adapter: "codex" }, "/repo");
    expect(out.command).toBe("codex");
    expect(out.cwd).toBe("/repo/cfcf-docs");
    expect(out.args).not.toContain("--model");
  });

  it("respects the configured model for codex when set", () => {
    const out = buildLaunchArgs({ adapter: "codex", model: "gpt-5" }, "/repo");
    const idx = out.args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(out.args[idx + 1]).toBe("gpt-5");
  });

  it("throws on unknown adapters with a config-edit hint", () => {
    expect(() => buildLaunchArgs({ adapter: "aider" }, "/repo")).toThrow(
      /Product Architect doesn't support adapter "aider"/,
    );
    expect(() => buildLaunchArgs({ adapter: "aider" }, "/repo")).toThrow(
      /helpArchitectAgent/,
    );
  });

  it("does NOT pass --append-system-prompt -- Pattern B uses CLAUDE.md auto-load", () => {
    const out = buildLaunchArgs({ adapter: "claude-code" }, "/repo");
    expect(out.args).not.toContain("--append-system-prompt");
  });

  it("does NOT pass model_instructions_file -- Pattern B uses AGENTS.md auto-load", () => {
    const out = buildLaunchArgs({ adapter: "codex" }, "/repo");
    for (const arg of out.args) {
      expect(arg).not.toContain("model_instructions_file");
    }
  });
});
