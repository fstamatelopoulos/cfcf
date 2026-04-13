import { describe, it, expect } from "bun:test";
import {
  getAdapter,
  getAdapterNames,
  detectAvailableAgents,
  claudeCodeAdapter,
  codexAdapter,
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

  it("returns undefined for unknown adapter", () => {
    expect(getAdapter("unknown-agent")).toBeUndefined();
  });

  it("lists all adapter names", () => {
    const names = getAdapterNames();
    expect(names).toContain("claude-code");
    expect(names).toContain("codex");
    expect(names.length).toBe(2);
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

describe("detectAvailableAgents", () => {
  it("returns results for all registered agents", async () => {
    const results = await detectAvailableAgents();
    expect(results.length).toBe(2);
    expect(results.map((r) => r.name)).toContain("claude-code");
    expect(results.map((r) => r.name)).toContain("codex");
    for (const result of results) {
      expect(result.availability).toHaveProperty("available");
    }
  });
});
