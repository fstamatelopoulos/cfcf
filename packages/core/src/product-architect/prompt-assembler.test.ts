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
  sessionArchives: [],
  otherRoles: [],
};

describe("assembleProductArchitectPrompt", () => {
  it("includes the Product Architect/Owner preamble", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory, clioActor: "product-architect|claude-code|opus" });
    expect(out).toContain("You are the cf² Product Architect");
    expect(out).toContain("Product Architect / Owner / Manager");
  });

  it("includes the primary scope (setup + specs)", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory, clioActor: "product-architect|claude-code|opus" });
    expect(out).toContain("Primary scope");
    expect(out).toContain("Repo setup");
    expect(out).toContain("Workspace registration");
    expect(out).toContain("Problem Pack authoring + iteration");
  });

  it("includes the hard refusals for other SDLC roles", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory, clioActor: "product-architect|claude-code|opus" });
    expect(out).toContain("HARD REFUSE");
    expect(out).toContain("That's the dev role");
    expect(out).toContain("That's the Solution Architect");
    expect(out).toContain("Run `cfcf reflect`");
    expect(out).toContain("Run `cfcf document`");
  });

  it("frames cost as a secondary dimension, not the primary concern", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory, clioActor: "product-architect|claude-code|opus" });
    expect(out).toContain("control + visibility");
    expect(out).toContain("Don't make this a refrain");
  });

  it("embeds the session_id in the memory protocol section", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory, clioActor: "product-architect|claude-code|opus" });
    expect(out).toContain("pa-2026-04-28T15-49-10-abc123");
    expect(out).toContain("session-pa-2026-04-28T15-49-10-abc123.md");
  });

  it("renders empty memory branches when both Clio docs are absent", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory, clioActor: "product-architect|claude-code|opus" });
    expect(out).toContain("no workspace memory yet");
    expect(out).toContain("no global memory yet");
  });

  it("uses the per-workspace default project (cf-workspace-<id>) in --project flags when clioProject is unset (item 6.9)", () => {
    // Pre-6.9 workspaces have `clioProject: null` on the registration —
    // the prompt should still tell the agent to write to
    // `cf-workspace-<id>`, not auto-route to default.
    const stateNoExplicit: AssessedState = {
      ...baseState,
      workspace: { ...baseState.workspace, clioProject: null },
    };
    const out = assembleProductArchitectPrompt({
      state: stateNoExplicit,
      memory: emptyMemory,
      clioActor: "product-architect|claude-code|opus",
    });
    expect(out).toContain("--project cf-workspace-ws-uuid-1");
    // The PA-memory.md write specifically should target the workspace's
    // own project, not cf-system-pa-memory or cf-system-default.
    expect(out).toContain("--title PA-memory.md --project cf-workspace-ws-uuid-1");
  });

  it("respects an explicit shared clioProject (e.g. backend-services) over the per-workspace default", () => {
    // When the user has assigned the workspace to a shared project,
    // PA's writes should land there — pooling memory with siblings.
    const stateShared: AssessedState = {
      ...baseState,
      workspace: { ...baseState.workspace, clioProject: "backend-services" },
    };
    const out = assembleProductArchitectPrompt({
      state: stateShared,
      memory: emptyMemory,
      clioActor: "product-architect|claude-code|opus",
    });
    expect(out).toContain("--project backend-services");
    // And NOT the per-workspace default — explicit wins.
    expect(out).not.toContain("--project cf-workspace-ws-uuid-1");
  });

  it("renders the workspace memory content when present", () => {
    const memory: MemoryInventory = {
      workspace: {
        documentId: "doc-uuid-1",
        updatedAt: "2026-04-27T10:00:00Z",
        content: "# PA workspace memory\n\nLast session we drafted problem.md.",
      },
      global: { documentId: null, updatedAt: null, content: null },
      sessionArchives: [],
  otherRoles: [],
    };
    const out = assembleProductArchitectPrompt({ state: baseState, memory, clioActor: "product-architect|claude-code|opus" });
    expect(out).toContain("doc-uuid-1");
    expect(out).toContain("Last session we drafted problem.md");
  });

  it("includes the embedded help bundle (full cfcf docs)", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory, clioActor: "product-architect|claude-code|opus" });
    expect(out).toContain("# cf² documentation (full bundle)");
    // The bundle includes the manual topic.
    expect(out).toContain("manual");
  });

  it("does NOT include an 'Initial task' section anymore (Flavour A — task flows in as first user message instead)", () => {
    // Use a unique nonsense phrase that won't accidentally appear in
    // the embedded help bundle.
    const uniqueMarker = "ZZ-PA-ASSEMBLER-TEST-MARKER-7Q3";
    const withTask = assembleProductArchitectPrompt({
      state: baseState,
      memory: emptyMemory,
      initialTask: uniqueMarker,
      clioActor: "product-architect|claude-code|opus",
    });
    expect(withTask).not.toContain("Initial task (from CLI invocation)");
    // The task itself isn't in the prompt body either — the launcher passes
    // it as the agent CLI's positional [PROMPT].
    expect(withTask).not.toContain(uniqueMarker);
  });

  it("includes the cf² interfaces section (CLI + web UI)", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory, clioActor: "product-architect|claude-code|opus" });
    expect(out).toContain("cf² has two user interfaces");
    expect(out).toContain("CLI");
    expect(out).toContain("Web UI");
    expect(out).toContain("http://localhost:");
  });

  it("includes the hand-off guidance with both CLI commands and web UI URLs", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory, clioActor: "product-architect|claude-code|opus" });
    expect(out).toContain("Hand-off");
    expect(out).toContain("cfcf review");
    expect(out).toContain("cfcf run");
    expect(out).toContain("http://localhost:<port>/#/workspaces/<id>");
  });

  it("includes the server-status branching in session-start protocol", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory, clioActor: "product-architect|claude-code|opus" });
    expect(out).toContain("Mention the cfcf server status");
    expect(out).toContain("cfcf server start");
  });

  it("redirects general cfcf usage questions to the Help Assistant", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory, clioActor: "product-architect|claude-code|opus" });
    // PA should know it's not the help-assistant; mentioning HA is fine
    // but the system-prompt behaviour about it is: PA runs interactively
    // + has the docs in-prompt, so it answers cfcf questions itself.
    expect(out).toContain("full cf² documentation embedded in this prompt");
  });

  it("includes session-start branching: insists on git init + workspace registration", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory, clioActor: "product-architect|claude-code|opus" });
    expect(out).toContain("session start");
    expect(out).toContain("Not a git repo");
    expect(out).toContain("Not registered");
    expect(out).toContain("INSIST");
  });

  it("teaches the continuous-mirror memory model (no approval-gated 'session end save' dance — refactor 2026-05-10)", () => {
    // The PA prompt used to instruct the agent to ASK the user before
    // pushing to Clio at session end. Real dogfood (testgame, three
    // sessions, no PA-memory.md ever pushed) proved that gate was
    // friction without protection — disk and Clio are both local files
    // under ~/.cfcf-pa/ and ~/.cfcf/, mirroring is a wire concern not
    // a content concern. Refactored to teach a continuous-mirror model:
    // disk + Clio together, no approval needed for the local→Clio
    // direction, asymmetric for Clio→local (still asks before clobber).
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory, clioActor: "product-architect|claude-code|opus" });
    // The new model is named explicitly so the agent reads it.
    expect(out).toContain("continuous mirror");
    // The asymmetry is the load-bearing distinction — pin it.
    expect(out).toContain("Clio→local pull asks");
    expect(out).toContain("Local→Clio push is silent");
    // Anti-regression: the old "ASK PROACTIVELY" framing should be
    // GONE from the SESSION_END section. (`ASK PROACTIVELY` may still
    // appear elsewhere — e.g. for git-init prompting — but not for
    // memory writes.)
    expect(out).not.toMatch(/Want me to \*\*sync this session to Clio\*\* before you go/);
    expect(out).not.toContain("DO NOT silently sync without asking");
  });

  it("teaches `--update-if-exists` on every ingest example (item 6.35 round-7 fix)", () => {
    // Real dogfood: PA agent followed the prompt's session-archive
    // example literally → created a duplicate doc when the disk file
    // grew between turns → caught itself, deleted the duplicate,
    // re-pushed with --update-if-exists. The example was missing the
    // flag. Pin it explicitly so future edits don't drop it.
    const out = assembleProductArchitectPrompt({
      state: baseState,
      memory: emptyMemory,
      clioActor: "product-architect|claude-code|opus",
    });

    // Session archive: the flag should appear in the ingest block
    // for `pa-session-<sessionId>`. Use multi-line-friendly regex.
    expect(out).toMatch(/cfcf clio docs ingest --file [\s\S]+?--update-if-exists[\s\S]+?--title pa-session-/);
    // PA-memory.md digest: same.
    expect(out).toMatch(/--update-if-exists[\s\S]+?--title PA-memory\.md/);
    // pa-global-memory: same.
    expect(out).toMatch(/--update-if-exists[\s\S]+?--title pa-global-memory/);
    // The flag is mentioned as "load-bearing" in the explanatory text
    // so future edits can't accidentally drop the rule.
    expect(out).toContain("load-bearing");
  });

  it("session-end behaviour describes 'all set' rather than asking 'did you save?'", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory, clioActor: "product-architect|claude-code|opus" });
    expect(out).toContain("All set. Disk + Clio are both up to date.");
    // The lastSession-block courtesy note should still be present —
    // it's not a save action, just metadata for the history entry.
    expect(out).toContain("lastSession");
  });

  it("renders state assessment with workspace registration when registered", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory, clioActor: "product-architect|claude-code|opus" });
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
    const out = assembleProductArchitectPrompt({ state: stateNoWs, memory: emptyMemory, clioActor: "product-architect|claude-code|opus" });
    expect(out).toContain("No cfcf workspace registered");
    expect(out).toContain("FIRST priority");
  });

  it("renders the Pattern B section as historical (no longer used) — i.e. doesn't mention briefing files at all", () => {
    const out = assembleProductArchitectPrompt({ state: baseState, memory: emptyMemory, clioActor: "product-architect|claude-code|opus" });
    // Pattern B hallmarks should be ABSENT in the prompt (the prompt is
    // about how PA operates, not about how cfcf injects it).
    expect(out).not.toContain("AGENTS.md auto-load");
    expect(out).not.toContain("sentinel-marked briefing");
  });

  // --- v0.24.1 PA-memory-discipline refresh (dogfood feedback) ---

  it("leads with the digest write rules, NOT the session log (v0.24.1)", () => {
    const out = assembleProductArchitectPrompt({
      state: baseState,
      memory: emptyMemory,
      clioActor: "product-architect|claude-code|opus",
    });
    // The "When to write" section now leads with the digest
    // (workspace-summary.md / PA-memory.md) — the load-bearing
    // artifact that future sessions read — and the session log
    // appears AFTER it as a durability scratchpad. This is the
    // ordering inversion from the gmbot dogfood feedback (digest
    // had been treated as afterthought; PA missed updates).
    const digestHeader = out.indexOf("### Digest (");
    const sessionLogHeader = out.indexOf("### Session log");
    expect(digestHeader).toBeGreaterThan(0);
    expect(sessionLogHeader).toBeGreaterThan(0);
    expect(digestHeader).toBeLessThan(sessionLogHeader);
  });

  it("encodes a sharp testable digest-write trigger (v0.24.1)", () => {
    const out = assembleProductArchitectPrompt({
      state: baseState,
      memory: emptyMemory,
      clioActor: "product-architect|claude-code|opus",
    });
    // The trigger is no longer "on major decision/rejection/preference"
    // (judgment call). It's now a four-clause testable rule that
    // names the Problem Pack files explicitly + supersession +
    // preference + rejection.
    expect(out).toMatch(/substantive edit.+Problem Pack/i);
    expect(out).toMatch(/problem\.md.+success\.md.+constraints\.md/);
    expect(out).toContain("BEFORE responding");
    expect(out).toContain("contradicts or supersedes");
  });

  it("teaches the supersession pattern with strikethrough + date (v0.24.1)", () => {
    const out = assembleProductArchitectPrompt({
      state: baseState,
      memory: emptyMemory,
      clioActor: "product-architect|claude-code|opus",
    });
    // The Supersession pattern section is mandatory teaching now —
    // include the SUPERSEDED literal + an example bullet.
    expect(out).toContain("Supersession pattern");
    expect(out).toContain("SUPERSEDED");
    // Strikethrough markdown (~~text~~) example.
    expect(out).toMatch(/~~[^~]+~~/);
  });

  it("mandates a turn-start self-check ritual (v0.24.1)", () => {
    const out = assembleProductArchitectPrompt({
      state: baseState,
      memory: emptyMemory,
      clioActor: "product-architect|claude-code|opus",
    });
    // The pre-response ritual: scan the session log for entries
    // since the last digest update; flush to the digest if 2+
    // have accumulated. Names the threshold so it's a testable
    // rule, not a vibe.
    expect(out).toContain("Turn-start self-check");
    expect(out).toContain("2+"); // explicit threshold appears literally
    expect(out).toContain("BEFORE generating your reply");
  });
});
