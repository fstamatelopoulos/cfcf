/**
 * Tests for the launcher's argv-construction logic. We don't actually
 * spawn the agent CLI here -- that's an integration concern. We
 * verify that buildLaunchArgs produces the correct shell command +
 * args for each supported adapter.
 */

import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { buildLaunchArgs } from "./launcher.js";

describe("buildLaunchArgs", () => {
  it("claude-code: invokes `claude --append-system-prompt <prompt>` interactively (no tempfile)", () => {
    const { command, args, tempPromptFile } = buildLaunchArgs(
      { adapter: "claude-code" },
      "FAKE_SYSTEM_PROMPT",
      "Hi",
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
    // claude-code passes the prompt inline; no tempfile needed.
    expect(tempPromptFile).toBeNull();
  });

  it("claude-code: defaults to haiku (HA's Q&A workload doesn't benefit from a top-tier model)", () => {
    const { args } = buildLaunchArgs(
      { adapter: "claude-code" },
      "x",
      "Hi",
    );
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("haiku");
  });

  it("claude-code: explicit model in config wins over the haiku default", () => {
    const { args } = buildLaunchArgs(
      { adapter: "claude-code", model: "sonnet-4.5" },
      "x",
      "Hi",
    );
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("sonnet-4.5");
  });

  it("claude-code: appends firstUserMessage as the LAST positional argv entry (Flavour A)", () => {
    const { args } = buildLaunchArgs(
      { adapter: "claude-code" },
      "system",
      "Please introduce yourself",
    );
    expect(args[args.length - 1]).toBe("Please introduce yourself");
    const modelIdx = args.indexOf("--model");
    expect(args.length - 1).toBeGreaterThan(modelIdx);
  });

  it("codex: invokes `codex -c model_instructions_file=<tempfile>` interactively", () => {
    const { command, args, tempPromptFile } = buildLaunchArgs(
      { adapter: "codex" },
      "FAKE_SYSTEM_PROMPT",
      "Hi",
    );
    expect(command).toBe("codex");

    // -c key=value override pointing at a tempfile.
    const cIdx = args.indexOf("-c");
    expect(cIdx).toBeGreaterThanOrEqual(0);
    const override = args[cIdx + 1];
    expect(override).toMatch(/^model_instructions_file="[^"]+"$/);

    // Tempfile actually exists with our content.
    expect(tempPromptFile).not.toBeNull();
    expect(existsSync(tempPromptFile!)).toBe(true);
    expect(readFileSync(tempPromptFile!, "utf-8")).toBe("FAKE_SYSTEM_PROMPT");

    // Overridden path matches the returned tempfile path.
    const expected = `model_instructions_file="${tempPromptFile!.replace(/"/g, '\\"')}"`;
    expect(override).toBe(expected);

    // No deprecation: we use the new key, not experimental_instructions_file.
    expect(override).not.toContain("experimental_instructions_file");

    // Cleanup the tempfile created during this test.
    rmSync(tempPromptFile!.replace(/\/[^/]+$/, ""), { recursive: true, force: true });
  });

  it("codex: appends --model when provided", () => {
    const { args, tempPromptFile } = buildLaunchArgs(
      { adapter: "codex", model: "gpt-5" },
      "x",
      "Hi",
    );
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("gpt-5");
    // Cleanup
    if (tempPromptFile) rmSync(tempPromptFile.replace(/\/[^/]+$/, ""), { recursive: true, force: true });
  });

  it("codex: appends firstUserMessage as the LAST positional argv entry (Flavour A)", () => {
    const { args, tempPromptFile } = buildLaunchArgs(
      { adapter: "codex" },
      "system",
      "Please introduce yourself",
    );
    expect(args[args.length - 1]).toBe("Please introduce yourself");
    if (tempPromptFile) rmSync(tempPromptFile.replace(/\/[^/]+$/, ""), { recursive: true, force: true });
  });

  it("rejects unknown adapters with an actionable error", () => {
    expect(() =>
      buildLaunchArgs({ adapter: "fake-agent" as "claude-code" }, "x", "Hi"),
    ).toThrow(/Help Assistant doesn't support adapter "fake-agent"/);
  });

  // claude-code-ollama (item 6.34)

  it("claude-code-ollama: wraps with `ollama launch claude --model X --yes --` then claude's flags", () => {
    const { command, args, tempPromptFile } = buildLaunchArgs(
      { adapter: "claude-code-ollama", model: "qwen3-coder:latest" },
      "HA system prompt",
      "Hello",
    );
    expect(command).toBe("ollama");
    // ollama-side flags
    expect(args[0]).toBe("launch");
    expect(args[1]).toBe("claude");
    const modelIdx = args.indexOf("--model");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe("qwen3-coder:latest");
    expect(args).toContain("--yes");
    // mandatory `--` separator
    const sepIdx = args.indexOf("--");
    expect(sepIdx).toBeGreaterThanOrEqual(0);
    // claude's flags AFTER the separator
    expect(args.slice(sepIdx + 1)).toContain("--append-system-prompt");
    expect(args.slice(sepIdx + 1)).toContain("HA system prompt");
    // No --dangerously-skip-permissions (HA is interactive)
    expect(args).not.toContain("--dangerously-skip-permissions");
    // firstUserMessage must be the LAST positional (Flavour A)
    expect(args[args.length - 1]).toBe("Hello");
    expect(tempPromptFile).toBeNull();
  });

  it("claude-code-ollama: omits --model when no agent.model is set", () => {
    const { args } = buildLaunchArgs(
      { adapter: "claude-code-ollama" },
      "x",
      "Hi",
    );
    expect(args).not.toContain("--model");
    // Still has `--yes --`
    expect(args).toContain("--yes");
    expect(args).toContain("--");
  });

  it("error message lists claude-code-ollama as supported (helps users on opencode-ollama)", () => {
    expect(() =>
      buildLaunchArgs({ adapter: "opencode-ollama" as "claude-code" }, "x", "Hi"),
    ).toThrow(/claude-code, codex, claude-code-ollama/);
  });
});
