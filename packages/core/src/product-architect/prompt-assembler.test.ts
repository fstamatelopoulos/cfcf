/**
 * Tests for the Product Architect system-prompt assembler.
 *
 * Verifies the assembler produces a stable, role-scoped prompt:
 *   - PA preamble + scope + boundary present (never silently mutated)
 *   - Memory section reflects inventory state (empty vs populated)
 *   - Workspace state delegates to formatProblemPackState
 *   - Initial-task section appears only when an initialTask is given
 *
 * Plan item 5.14.
 */
import { describe, expect, it } from "bun:test";
import { assembleProductArchitectPrompt } from "./prompt-assembler.js";
import type { ProblemPackState } from "./workspace-state.js";

const emptyState: ProblemPackState = {
  cfcfDocsPath: "/repo/cfcf-docs",
  exists: true,
  problem: null,
  success: null,
  process: null,
  constraints: null,
  decisionLog: null,
};

describe("assembleProductArchitectPrompt", () => {
  it("includes the PA role preamble + hard boundary", () => {
    const out = assembleProductArchitectPrompt({
      workspace: emptyState,
      memoryInventory: [],
    });
    expect(out).toContain("You are the cf² Product Architect");
    expect(out).toContain("hard \"no implementation drift\"");
    expect(out).toContain("That's the dev role's job");
    expect(out).toContain("That's the Solution Architect's job");
  });

  it("renders an empty memory inventory hint when none provided", () => {
    const out = assembleProductArchitectPrompt({
      workspace: emptyState,
      memoryInventory: [],
    });
    expect(out).toContain("(empty -- memory Projects don't exist yet");
  });

  it("renders memory inventory verbatim when provided", () => {
    const inventory = [
      "### Project: `cfcf-memory-pa` (1 doc)\n\n- **Spec session: 2026-04-28**",
    ];
    const out = assembleProductArchitectPrompt({
      workspace: emptyState,
      memoryInventory: inventory,
    });
    expect(out).toContain("Spec session: 2026-04-28");
  });

  it("delegates workspace formatting to formatProblemPackState (missing dir branch)", () => {
    const out = assembleProductArchitectPrompt({
      workspace: { ...emptyState, exists: false },
      memoryInventory: [],
    });
    expect(out).toContain("does NOT exist");
    expect(out).toContain("cfcf workspace init");
  });

  it("includes the initial task when provided + omits otherwise", () => {
    const withTask = assembleProductArchitectPrompt({
      workspace: emptyState,
      memoryInventory: [],
      initialTask: "Tighten the success.md auth criteria",
    });
    expect(withTask).toContain("Initial task (from CLI invocation)");
    expect(withTask).toContain("Tighten the success.md auth criteria");

    const without = assembleProductArchitectPrompt({
      workspace: emptyState,
      memoryInventory: [],
    });
    expect(without).not.toContain("Initial task (from CLI invocation)");
  });

  it("instructs the agent to redirect cf² usage questions to HA", () => {
    const out = assembleProductArchitectPrompt({
      workspace: emptyState,
      memoryInventory: [],
    });
    expect(out).toContain("cfcf help assistant");
  });

  it("instructs the agent on memory schema (PA + global Projects)", () => {
    const out = assembleProductArchitectPrompt({
      workspace: emptyState,
      memoryInventory: [],
    });
    expect(out).toContain("cfcf-memory-pa");
    expect(out).toContain("cfcf-memory-global");
    expect(out).toContain("spec-session");
    expect(out).toContain("user-preference");
  });
});
