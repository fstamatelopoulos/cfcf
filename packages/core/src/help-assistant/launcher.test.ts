/**
 * Tests for the launcher's argv-construction logic. We don't actually
 * spawn the agent CLI here -- that's an integration concern. We
 * verify that buildLaunchArgs produces the correct shell command +
 * args for each supported adapter.
 */

import { describe, it, expect } from "bun:test";
import { buildLaunchArgs } from "./launcher.js";

describe("buildLaunchArgs", () => {
  it("claude-code: invokes `claude --append-system-prompt <prompt>` interactively", () => {
    const { command, args } = buildLaunchArgs(
      { adapter: "claude-code" },
      "FAKE_SYSTEM_PROMPT",
    );
    expect(command).toBe("claude");
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("FAKE_SYSTEM_PROMPT");
    // No --dangerously-skip-permissions: HA runs in default permission
    // mode (per-command prompts).
    expect(args).not.toContain("--dangerously-skip-permissions");
    // Default doesn't include `-p`/`--prompt`: HA is interactive,
    // not one-shot print mode.
    expect(args).not.toContain("-p");
    expect(args).not.toContain("--prompt");
  });

  it("claude-code: appends --model when provided", () => {
    const { args } = buildLaunchArgs(
      { adapter: "claude-code", model: "sonnet-4.5" },
      "x",
    );
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("sonnet-4.5");
  });

  it("codex: bails with an actionable error (no system-prompt CLI flag in codex v1)", () => {
    // codex doesn't expose --system-prompt at the CLI; injecting via
    // config.toml is iter-6 work. v1 explicitly fails with a hint
    // pointing the user at claude-code as the HA agent.
    expect(() =>
      buildLaunchArgs({ adapter: "codex" }, "FAKE_SYSTEM_PROMPT"),
    ).toThrow(/codex/);
    expect(() =>
      buildLaunchArgs({ adapter: "codex" }, "x"),
    ).toThrow(/cfcf config edit/);
  });

  it("rejects unknown adapters with an actionable error", () => {
    expect(() =>
      buildLaunchArgs({ adapter: "fake-agent" as "claude-code" }, "x"),
    ).toThrow(/Help Assistant doesn't support adapter "fake-agent"/);
  });
});
