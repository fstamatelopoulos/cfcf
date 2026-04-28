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

  it("codex: invokes `codex --system-prompt <prompt>` interactively", () => {
    const { command, args } = buildLaunchArgs(
      { adapter: "codex" },
      "FAKE_SYSTEM_PROMPT",
    );
    expect(command).toBe("codex");
    expect(args).toContain("--system-prompt");
    expect(args).toContain("FAKE_SYSTEM_PROMPT");
  });

  it("codex: appends --model when provided", () => {
    const { args } = buildLaunchArgs(
      { adapter: "codex", model: "gpt-5" },
      "x",
    );
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("gpt-5");
  });

  it("rejects unknown adapters with an actionable error", () => {
    expect(() =>
      buildLaunchArgs({ adapter: "fake-agent" as "claude-code" }, "x"),
    ).toThrow(/Help Assistant doesn't support adapter "fake-agent"/);
  });
});
