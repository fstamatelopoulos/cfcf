import { describe, it, expect } from "bun:test";
import {
  getAdapter,
  getAdapterNames,
  detectAvailableAgents,
  claudeCodeAdapter,
  codexAdapter,
  opencodeAdapter,
  claudeCodeOllamaAdapter,
  opencodeOllamaAdapter,
  isClaudeCodeHarnessRisk,
  CLAUDE_CODE_HARNESS_WARNING,
  UNATTENDED_ROLE_NAMES,
} from "./index.js";

describe("agent adapter registry", () => {
  it("registers claude-code adapter", () => {
    const adapter = getAdapter("claude-code");
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe("claude-code");
    expect(adapter!.displayName).toBe("Claude Code");
  });

  it("registers codex adapter", () => {
    const adapter = getAdapter("codex");
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe("codex");
    expect(adapter!.displayName).toBe("Codex CLI");
  });

  it("registers opencode adapter", () => {
    const adapter = getAdapter("opencode");
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe("opencode");
    expect(adapter!.displayName).toBe("Opencode");
    expect(adapter!.modelSource).toBe("custom");
  });

  it("registers claude-code-ollama adapter", () => {
    const adapter = getAdapter("claude-code-ollama");
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe("claude-code-ollama");
    expect(adapter!.displayName).toBe("Claude Code (via ollama)");
    expect(adapter!.modelSource).toBe("ollama");
    expect(adapter!.instructionFilename).toBe("CLAUDE.md");
  });

  it("registers opencode-ollama adapter", () => {
    const adapter = getAdapter("opencode-ollama");
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe("opencode-ollama");
    expect(adapter!.displayName).toBe("Opencode (via ollama)");
    expect(adapter!.modelSource).toBe("ollama");
    expect(adapter!.instructionFilename).toBe("AGENTS.md");
  });

  it("returns undefined for unknown adapter", () => {
    expect(getAdapter("unknown-agent")).toBeUndefined();
  });

  it("lists all adapter names", () => {
    const names = getAdapterNames();
    expect(names).toContain("claude-code");
    expect(names).toContain("codex");
    expect(names).toContain("opencode");
    expect(names).toContain("claude-code-ollama");
    expect(names).toContain("opencode-ollama");
    expect(names.length).toBe(5);
  });
});

describe("claude-code adapter", () => {
  it("has correct unattended flags", () => {
    expect(claudeCodeAdapter.unattendedFlags()).toEqual([
      "--dangerously-skip-permissions",
    ]);
  });

  it("builds a valid command", () => {
    const { command, args } = claudeCodeAdapter.buildCommand(
      "/path/to/project",
      "read CLAUDE.md and execute",
    );
    expect(command).toBe("claude");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--verbose");
    expect(args).toContain("-p");
    expect(args).toContain("read CLAUDE.md and execute");
  });

  it("checkAvailability returns a result", async () => {
    const result = await claudeCodeAdapter.checkAvailability();
    // We don't assert available=true because CI may not have claude installed
    expect(result).toHaveProperty("available");
    expect(typeof result.available).toBe("boolean");
  });
});

describe("codex adapter", () => {
  it("has correct unattended flags", () => {
    expect(codexAdapter.unattendedFlags()).toEqual([
      "-a",
      "never",
      "exec",
      "-s",
      "danger-full-access",
    ]);
  });

  it("builds a valid command with global flags before subcommand", () => {
    const { command, args } = codexAdapter.buildCommand(
      "/path/to/project",
      "implement feature X",
    );
    expect(command).toBe("codex");
    // -a never must come BEFORE exec (global flag)
    expect(args[0]).toBe("-a");
    expect(args[1]).toBe("never");
    expect(args[2]).toBe("exec");
    expect(args).toContain("-s");
    expect(args).toContain("danger-full-access");
    expect(args[args.length - 1]).toBe("implement feature X");
  });

  it("passes model parameter", () => {
    const { args } = codexAdapter.buildCommand(
      "/path/to/project",
      "implement feature X",
      "o3",
    );
    expect(args).toContain("--model");
    expect(args).toContain("o3");
  });
});

describe("opencode adapter", () => {
  it("has run + dangerously-skip-permissions as the unattended flags", () => {
    // --dangerously-skip-permissions avoids the CI cancel-state
    // footgun documented at github/anomalyco/opencode#13851.
    expect(opencodeAdapter.unattendedFlags()).toEqual([
      "run",
      "--dangerously-skip-permissions",
    ]);
  });

  it("builds a `opencode run --dangerously-skip-permissions [--model X] <prompt>` command", () => {
    const { command, args } = opencodeAdapter.buildCommand(
      "/path/to/project",
      "implement feature X",
    );
    expect(command).toBe("opencode");
    expect(args[0]).toBe("run");
    expect(args).toContain("--dangerously-skip-permissions");
    // Last arg is the prompt
    expect(args[args.length - 1]).toBe("implement feature X");
    // No model flag when model is undefined
    expect(args).not.toContain("--model");
  });

  it("passes the model as `--model provider/model` shape", () => {
    const { args } = opencodeAdapter.buildCommand(
      "/path/to/project",
      "implement",
      "anthropic/claude-3-5-sonnet",
    );
    expect(args).toContain("--model");
    expect(args).toContain("anthropic/claude-3-5-sonnet");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args[args.length - 1]).toBe("implement");
  });

  it("uses AGENTS.md as the instruction filename", () => {
    expect(opencodeAdapter.instructionFilename).toBe("AGENTS.md");
  });
});

describe("claude-code-ollama adapter", () => {
  it("wraps the claude flags after `--`", () => {
    const flags = claudeCodeOllamaAdapter.unattendedFlags();
    expect(flags).toContain("launch");
    expect(flags).toContain("claude");
    expect(flags).toContain("--yes");
    expect(flags).toContain("--");
    expect(flags).toContain("--dangerously-skip-permissions");
  });

  it("builds a `ollama launch claude --model X --yes -- claude-flags -p prompt` command", () => {
    const { command, args } = claudeCodeOllamaAdapter.buildCommand(
      "/path/to/project",
      "implement feature X",
      "gemma4:31b",
    );
    expect(command).toBe("ollama");
    expect(args[0]).toBe("launch");
    expect(args[1]).toBe("claude");
    // ollama flags
    expect(args).toContain("--model");
    expect(args).toContain("gemma4:31b");
    expect(args).toContain("--yes");
    // Mandatory `--` separator must precede the claude pass-through.
    const sepIdx = args.indexOf("--");
    expect(sepIdx).toBeGreaterThan(0);
    // Claude args after `--`
    const passThrough = args.slice(sepIdx + 1);
    expect(passThrough).toContain("--dangerously-skip-permissions");
    expect(passThrough).toContain("--verbose");
    expect(passThrough).toContain("-p");
    expect(passThrough[passThrough.length - 1]).toBe("implement feature X");
  });

  it("omits --model when no model is given but still uses `--yes --` separator", () => {
    const { args } = claudeCodeOllamaAdapter.buildCommand(
      "/path/to/project",
      "implement",
    );
    // --model only appears in the ollama-side args (before --) when caller
    // passes it. The caller is expected to always pass one for production
    // use, but the adapter doesn't enforce that — it just omits the flag.
    const sepIdx = args.indexOf("--");
    expect(sepIdx).toBeGreaterThan(0);
    expect(args.slice(0, sepIdx)).not.toContain("--model");
    // --yes is always present (mandatory for unattended)
    expect(args.slice(0, sepIdx)).toContain("--yes");
  });

  it("uses CLAUDE.md (the launched agent's convention) as the instruction filename", () => {
    expect(claudeCodeOllamaAdapter.instructionFilename).toBe("CLAUDE.md");
  });
});

describe("opencode-ollama adapter", () => {
  it("builds a `ollama launch opencode --model X --yes -- run --dangerously-skip-permissions prompt` command", () => {
    const { command, args } = opencodeOllamaAdapter.buildCommand(
      "/path/to/project",
      "implement feature X",
      "qwen2.5-coder:32b",
    );
    expect(command).toBe("ollama");
    expect(args[0]).toBe("launch");
    expect(args[1]).toBe("opencode");
    expect(args).toContain("--model");
    expect(args).toContain("qwen2.5-coder:32b");
    expect(args).toContain("--yes");
    const sepIdx = args.indexOf("--");
    expect(sepIdx).toBeGreaterThan(0);
    const passThrough = args.slice(sepIdx + 1);
    expect(passThrough[0]).toBe("run");
    expect(passThrough).toContain("--dangerously-skip-permissions");
    expect(passThrough[passThrough.length - 1]).toBe("implement feature X");
  });

  it("uses AGENTS.md as the instruction filename (matches opencode docs)", () => {
    expect(opencodeOllamaAdapter.instructionFilename).toBe("AGENTS.md");
  });
});

describe("isClaudeCodeHarnessRisk", () => {
  it("returns true for direct `claude-code` adapter", () => {
    expect(isClaudeCodeHarnessRisk("claude-code")).toBe(true);
  });

  it("returns false for the *-ollama variants (no subscription OAuth involved)", () => {
    expect(isClaudeCodeHarnessRisk("claude-code-ollama")).toBe(false);
    expect(isClaudeCodeHarnessRisk("opencode-ollama")).toBe(false);
  });

  it("returns false for codex + opencode", () => {
    expect(isClaudeCodeHarnessRisk("codex")).toBe(false);
    expect(isClaudeCodeHarnessRisk("opencode")).toBe(false);
  });

  it("returns false for unknown adapter names", () => {
    expect(isClaudeCodeHarnessRisk("nonexistent")).toBe(false);
    expect(isClaudeCodeHarnessRisk("")).toBe(false);
  });
});

describe("UNATTENDED_ROLE_NAMES + CLAUDE_CODE_HARNESS_WARNING", () => {
  it("lists the four always-unattended iteration roles", () => {
    expect(UNATTENDED_ROLE_NAMES).toContain("dev");
    expect(UNATTENDED_ROLE_NAMES).toContain("judge");
    expect(UNATTENDED_ROLE_NAMES).toContain("reflection");
    expect(UNATTENDED_ROLE_NAMES).toContain("documenter");
    // architect is conditionally unattended; not in this constant
    expect(UNATTENDED_ROLE_NAMES).not.toContain("architect");
    expect(UNATTENDED_ROLE_NAMES).not.toContain("product-architect");
    expect(UNATTENDED_ROLE_NAMES).not.toContain("help-assistant");
  });

  it("CLAUDE_CODE_HARNESS_WARNING references the policy guide path", () => {
    expect(CLAUDE_CODE_HARNESS_WARNING).toContain("anthropic-policy.md");
    expect(CLAUDE_CODE_HARNESS_WARNING.toLowerCase()).toContain("anthropic");
    expect(CLAUDE_CODE_HARNESS_WARNING.toLowerCase()).toContain("harness");
  });
});

describe("detectAvailableAgents", () => {
  it("returns results for all five registered agents", async () => {
    const results = await detectAvailableAgents();
    expect(results.length).toBe(5);
    const names = results.map((r) => r.name);
    expect(names).toContain("claude-code");
    expect(names).toContain("codex");
    expect(names).toContain("opencode");
    expect(names).toContain("claude-code-ollama");
    expect(names).toContain("opencode-ollama");
    for (const result of results) {
      expect(result.availability).toHaveProperty("available");
    }
  });
});
