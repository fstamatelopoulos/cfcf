/**
 * Tests for the Product Architect system-prompt assembler (v2).
 *
 * Verifies the assembler produces a stable, role-scoped prompt:
 *   - Product Architect/Owner preamble + scope (primary/secondary/out)
 *   - Cost-and-control framing (control primary, cost dimension)
 *   - State assessment + memory inventory sections present
 *   - Memory protocol with session_id substituted
 *   - Embedded full docs bundle
 *   - Initial-task section conditional
 *
 * Plan item 5.14 (v2).
 */
import { describe, expect, it } from "bun:test";
import { assembleProductArchitectPrompt } from "./prompt-assembler.js";
import type { AssessedState } from "./state-assessor.js";
import type { MemoryInventory } from "./memory.js";

const baseState: AssessedState = {
  repoPath: "/repo",
  sessionId: "pa-2026-04-28T15-49-10-abc123",
  assessedAt: "2026-04-28T15:49:10.000Z",
  git: { isGitRepo: true, latestCommit: "abc1234 init" },
  workspace: {
    registered: true,
    workspaceId: "ws-uuid-1",
    name: "my-project",
    clioProject: "default",
    currentIteration: 0,
  },
  server: { running: false, pid: null, port: null },
  iterations: { exists: false, iterationCount: 0, tail: null },
  problemPack: {
    packPath: "/repo/problem-pack",
    exists: true,
    files: [
      { filename: "problem.md", exists: true, content: "# Problem\nbuild a thing", size: 22 },
      { filename: "success.md", exists: false, content: null, size: 0 },
      { filename: "constraints.md", exists: false, content: null, size: 0 },
      { filename: "hints.md", exists: false, content: null, size: 0 },
      { filename: "style-guide.md", exists: false, content: null, size: 0 },
    ],
    contextFiles: [],
  },
  paCache: {
    cachePath: "/repo/.cfcf-pa",
    exists: false,
    workspaceSummary: null,
    meta: null,
    sessionFiles: [],
  },
};

const emptyMemory: MemoryInventory = {
  workspace: { documentId: null, updatedAt: null, content: null },
  global: { documentId: null, updatedAt: null, content: null },
  otherRoles: [],
};

describe("assembleProductArchitectPrompt", () => {
  it("includes the Product Architect/Owner preamble", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory });
    expect(out).toContain("You are the cf² Product Architect");
    expect(out).toContain("Product Architect / Owner / Manager");
  });

  it("includes the primary scope (setup + specs)", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory });
    expect(out).toContain("Primary scope");
    expect(out).toContain("Repo setup");
    expect(out).toContain("Workspace registration");
    expect(out).toContain("Problem Pack authoring + iteration");
  });

  it("includes the hard refusals for other SDLC roles", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory });
    expect(out).toContain("HARD REFUSE");
    expect(out).toContain("That's the dev role");
    expect(out).toContain("That's the Solution Architect");
    expect(out).toContain("Run `cfcf reflect`");
    expect(out).toContain("Run `cfcf document`");
  });

  it("frames cost as a secondary dimension, not the primary concern", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory });
    expect(out).toContain("control + visibility");
    expect(out).toContain("Don't make this a refrain");
  });

  it("embeds the session_id in the memory protocol section", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory });
    expect(out).toContain("pa-2026-04-28T15-49-10-abc123");
    expect(out).toContain("session-pa-2026-04-28T15-49-10-abc123.md");
  });

  it("renders empty memory branches when both Clio docs are absent", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory });
    expect(out).toContain("no workspace memory yet");
    expect(out).toContain("no global memory yet");
  });

  it("renders the workspace memory content when present", () => {
    const memory: MemoryInventory = {
      workspace: {
        documentId: "doc-uuid-1",
        updatedAt: "2026-04-27T10:00:00Z",
        content: "# PA workspace memory\n\nLast session we drafted problem.md.",
      },
      global: { documentId: null, updatedAt: null, content: null },
      otherRoles: [],
    };
    const out = assembleProductArchitectPrompt({ state: baseState, memory });
    expect(out).toContain("doc-uuid-1");
    expect(out).toContain("Last session we drafted problem.md");
  });

  it("includes the embedded help bundle (full cfcf docs)", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory });
    expect(out).toContain("# cf² documentation (full bundle)");
    // The bundle includes the manual topic.
    expect(out).toContain("manual");
  });

  it("does NOT include an 'Initial task' section anymore (Flavour A — task flows in as first user message instead)", () => {
    const withTask = assembleProductArchitectPrompt({
      state: baseState,
      memory: emptyMemory,
      initialTask: "Tighten the success.md auth criteria",
    });
    expect(withTask).not.toContain("Initial task (from CLI invocation)");
    // The task itself isn't in the prompt body either — the launcher passes
    // it as the agent CLI's positional [PROMPT].
    expect(withTask).not.toContain("Tighten the success.md auth criteria");
  });

  it("includes the cf² interfaces section (CLI + web UI)", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory });
    expect(out).toContain("cf² has two user interfaces");
    expect(out).toContain("CLI");
    expect(out).toContain("Web UI");
    expect(out).toContain("http://localhost:");
  });

  it("includes the hand-off guidance with both CLI commands and web UI URLs", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory });
    expect(out).toContain("Hand-off");
    expect(out).toContain("cfcf review");
    expect(out).toContain("cfcf run");
    expect(out).toContain("http://localhost:<port>/#/workspaces/<id>");
  });

  it("includes the server-status branching in session-start protocol", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory });
    expect(out).toContain("Mention the cfcf server status");
    expect(out).toContain("cfcf server start");
  });

  it("redirects general cfcf usage questions to the Help Assistant", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory });
    // PA should know it's not the help-assistant; mentioning HA is fine
    // but the system-prompt behaviour about it is: PA runs interactively
    // + has the docs in-prompt, so it answers cfcf questions itself.
    expect(out).toContain("full cf² documentation embedded in this prompt");
  });

  it("includes session-start branching: insists on git init + workspace registration", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory });
    expect(out).toContain("session start");
    expect(out).toContain("Not a git repo");
    expect(out).toContain("Not registered");
    expect(out).toContain("INSIST");
  });

  it("includes the session-end save protocol", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory });
    expect(out).toContain("Want me to save this session's work before you go?");
    expect(out).toContain("ASK PROACTIVELY");
  });

  it("renders state assessment with workspace registration when registered", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory });
    expect(out).toContain("Workspace ID: `ws-uuid-1`");
    expect(out).toContain("my-project");
  });

  it("renders state assessment with workspace-not-registered guidance when missing", () => {
    const stateNoWs: AssessedState = {
      ...baseState,
      workspace: {
        registered: false,
        workspaceId: null,
        name: null,
        clioProject: null,
        currentIteration: null,
      },
    };
    const out = assembleProductArchitectPrompt({ state: stateNoWs, memory: emptyMemory });
    expect(out).toContain("No cfcf workspace registered");
    expect(out).toContain("FIRST priority");
  });

  it("renders the Pattern B section as historical (no longer used) — i.e. doesn't mention briefing files at all", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory });
    // Pattern B hallmarks should be ABSENT in the prompt (the prompt is
    // about how PA operates, not about how cfcf injects it).
    expect(out).not.toContain("AGENTS.md auto-load");
    expect(out).not.toContain("sentinel-marked briefing");
  });
});
