/**
 * Tests for the Product Architect memory readers (v2).
 *
 * Mocks the MemoryBackend to verify the read patterns:
 *   - readWorkspaceMemory uses metadataSearch with workspace_id filter
 *   - readGlobalMemory uses findDocumentByTitle on cfcf-memory-global
 *   - readOtherRoleMemory iterates the standardised read-only projects
 *   - All readers are best-effort (errors → empty snapshots)
 *
 * Plan item 5.14 (v2).
 */
import { describe, expect, it } from "bun:test";
import {
  readWorkspaceMemory,
  readGlobalMemory,
  readOtherRoleMemory,
  readMemoryInventory,
  formatMemoryInventory,
  PA_PROJECT,
  PA_WORKSPACE_MEMORY_TITLE,
  PA_GLOBAL_MEMORY_TITLE,
  GLOBAL_PROJECT,
  READONLY_OTHER_ROLE_PROJECTS,
} from "./memory.js";
import type { MemoryBackend } from "../clio/backend/types.js";
import type { ClioDocument } from "../clio/types.js";

function makeDoc(id: string, title: string, content: string): ClioDocument {
  return {
    id,
    projectId: "proj-id",
    title,
    source: "agent-write",
    author: "pa",
    contentHash: "hash-" + id,
    metadata: {},
    reviewStatus: "approved",
    chunkCount: 1,
    totalChars: content.length,
    createdAt: "2026-04-28T10:00:00Z",
    updatedAt: "2026-04-28T15:00:00Z",
  };
}

function makeContent(doc: ClioDocument, content: string) {
  return {
    document: doc,
    content,
    chunkCount: doc.chunkCount,
    totalChars: content.length,
    versionId: null,
  };
}

function makeProject(id: string, name: string) {
  return {
    id,
    name,
    description: "",
    metadata: {},
    createdAt: "2026-04-28T10:00:00Z",
    updatedAt: "2026-04-28T10:00:00Z",
  };
}

function makeBackend(overrides: Partial<MemoryBackend> = {}): MemoryBackend {
  const stub: Partial<MemoryBackend> = {
    metadataSearch: async () => ({ documents: [], metadataFilter: {} }),
    findDocumentByTitle: async () => null,
    listDocuments: async () => [],
    getDocument: async () => null,
    getDocumentContent: async () => null,
    getProject: async () => null,
    listProjects: async () => [],
    resolveProject: async (name) => makeProject(`${name}-id`, name),
    ...overrides,
  };
  return stub as MemoryBackend;
}

describe("readWorkspaceMemory", () => {
  it("returns empty snapshot when workspace_id is null", async () => {
    const backend = makeBackend();
    const out = await readWorkspaceMemory(backend, null);
    expect(out.documentId).toBeNull();
    expect(out.content).toBeNull();
  });

  it("queries metadataSearch with the right filter shape AND no project scoping (v2.1 fix)", async () => {
    let receivedFilter: Record<string, unknown> | undefined;
    let receivedProject: string | undefined;
    const backend = makeBackend({
      metadataSearch: async (req) => {
        receivedFilter = req.metadataFilter as Record<string, unknown>;
        receivedProject = req.project;
        return { documents: [], metadataFilter: req.metadataFilter };
      },
    });
    await readWorkspaceMemory(backend, "ws-uuid-1");
    expect(receivedFilter).toEqual({
      role: "pa",
      artifact_type: "workspace-memory",
      workspace_id: "ws-uuid-1",
    });
    // No project filter — robust to docs that ended up in `default`
    // because the agent's ingest auto-routed before pre-create.
    expect(receivedProject).toBeUndefined();
  });

  it("returns the doc + content when found", async () => {
    const doc = makeDoc("doc-uuid-1", PA_WORKSPACE_MEMORY_TITLE, "# memory body");
    const backend = makeBackend({
      metadataSearch: async () => ({ documents: [doc], metadataFilter: {} }),
      getDocumentContent: async () => makeContent(doc, "# memory body"),
    });
    const out = await readWorkspaceMemory(backend, "ws-uuid-1");
    expect(out.documentId).toBe("doc-uuid-1");
    expect(out.content).toContain("memory body");
  });

  it("returns empty snapshot when the backend throws", async () => {
    const backend = makeBackend({
      metadataSearch: async () => { throw new Error("boom"); },
    });
    const out = await readWorkspaceMemory(backend, "ws-uuid-1");
    expect(out.documentId).toBeNull();
    expect(out.content).toBeNull();
  });
});

describe("readGlobalMemory", () => {
  it("looks up global memory by metadata (project-agnostic, v2.1)", async () => {
    let receivedFilter: Record<string, unknown> | undefined;
    let receivedProject: string | undefined;
    const doc = makeDoc("global-doc-1", PA_GLOBAL_MEMORY_TITLE, "# global");
    const backend = makeBackend({
      metadataSearch: async (req) => {
        receivedFilter = req.metadataFilter as Record<string, unknown>;
        receivedProject = req.project;
        return { documents: [doc], metadataFilter: req.metadataFilter };
      },
      getDocumentContent: async () => makeContent(doc, "# global"),
    });
    const out = await readGlobalMemory(backend);
    expect(receivedFilter).toEqual({
      role: "pa",
      artifact_type: "global-memory",
    });
    // No project scoping — same robustness rationale as workspace memory.
    expect(receivedProject).toBeUndefined();
    expect(out.documentId).toBe("global-doc-1");
    expect(out.content).toContain("global");
  });

  it("returns empty snapshot when no matching doc exists", async () => {
    const backend = makeBackend({
      metadataSearch: async () => ({ documents: [], metadataFilter: {} }),
    });
    const out = await readGlobalMemory(backend);
    expect(out.documentId).toBeNull();
  });
});

describe("ensurePaClioProjects", () => {
  it("calls resolveProject with createIfMissing for both PA Projects", async () => {
    const calls: { name: string; createIfMissing?: boolean }[] = [];
    const backend = makeBackend({
      resolveProject: async (name, opts) => {
        calls.push({ name, createIfMissing: opts?.createIfMissing });
        return makeProject(`${name}-id`, name);
      },
    });
    const { ensurePaClioProjects } = await import("./memory.js");
    await ensurePaClioProjects(backend);
    expect(calls).toHaveLength(2);
    expect(calls[0].name).toBe("cfcf-memory-pa");
    expect(calls[0].createIfMissing).toBe(true);
    expect(calls[1].name).toBe("cfcf-memory-global");
    expect(calls[1].createIfMissing).toBe(true);
  });

  it("doesn't throw when Clio is unreachable", async () => {
    const backend = makeBackend({
      resolveProject: async () => { throw new Error("clio down"); },
    });
    const { ensurePaClioProjects } = await import("./memory.js");
    // Should not throw — best-effort.
    await ensurePaClioProjects(backend);
  });
});

describe("readOtherRoleMemory", () => {
  it("iterates the three standardised read-only projects", async () => {
    const visited: string[] = [];
    const backend = makeBackend({
      metadataSearch: async (req) => {
        visited.push(req.project!);
        return { documents: [], metadataFilter: {} };
      },
      listDocuments: async (opts) => {
        if (opts?.project) visited.push(opts.project);
        return [];
      },
    });
    await readOtherRoleMemory(backend, "ws-uuid-1");
    expect(visited).toEqual([...READONLY_OTHER_ROLE_PROJECTS]);
  });

  it("falls back to listDocuments when workspace_id is null", async () => {
    let listCalled = false;
    let metadataCalled = false;
    const backend = makeBackend({
      listDocuments: async () => { listCalled = true; return []; },
      metadataSearch: async () => { metadataCalled = true; return { documents: [], metadataFilter: {} }; },
    });
    await readOtherRoleMemory(backend, null);
    expect(listCalled).toBe(true);
    expect(metadataCalled).toBe(false);
  });
});

describe("readMemoryInventory", () => {
  it("composes workspace + global + other-role into a single object", async () => {
    const backend = makeBackend();
    const inv = await readMemoryInventory(backend, "ws-uuid-1");
    expect(inv.workspace).toBeDefined();
    expect(inv.global).toBeDefined();
    expect(inv.otherRoles.length).toBe(READONLY_OTHER_ROLE_PROJECTS.length);
  });
});

describe("formatMemoryInventory", () => {
  it("renders empty branches when nothing is present", () => {
    const out = formatMemoryInventory({
      workspace: { documentId: null, updatedAt: null, content: null },
      global: { documentId: null, updatedAt: null, content: null },
      sessionArchives: [],
      otherRoles: [
        { project: "cfcf-memory-reflection", docs: [] },
        { project: "cfcf-memory-architect", docs: [] },
        { project: "cfcf-memory-ha", docs: [] },
      ],
    });
    expect(out).toContain("no workspace memory yet");
    expect(out).toContain("no global memory yet");
    expect(out).toContain("empty for this workspace");
  });

  it("renders the workspace memory content + doc id when present", () => {
    const out = formatMemoryInventory({
      workspace: {
        documentId: "doc-uuid-1",
        updatedAt: "2026-04-27T10:00:00Z",
        content: "# memory body\n\nsession 1",
      },
      global: { documentId: null, updatedAt: null, content: null },
      sessionArchives: [],
      otherRoles: [],
    });
    expect(out).toContain("doc-uuid-1");
    expect(out).toContain("memory body");
  });

  it("renders other-role docs when present", () => {
    const out = formatMemoryInventory({
      workspace: { documentId: null, updatedAt: null, content: null },
      global: { documentId: null, updatedAt: null, content: null },
      sessionArchives: [],
      otherRoles: [
        {
          project: "cfcf-memory-reflection",
          docs: [makeDoc("ref-1", "Iteration 3 reflection", "x")],
        },
      ],
    });
    expect(out).toContain("Iteration 3 reflection");
    expect(out).toContain("`ref-1`");
  });

  it("renders session-archive list when present (titles + outcomeSummary, not full content)", () => {
    const out = formatMemoryInventory({
      workspace: { documentId: null, updatedAt: null, content: null },
      global: { documentId: null, updatedAt: null, content: null },
      sessionArchives: [
        {
          documentId: "arch-1",
          sessionId: "pa-2026-04-29-foo",
          title: "pa-session-pa-2026-04-29-foo",
          updatedAt: "2026-04-29T10:00:00Z",
          outcomeSummary: "Drafted problem.md and success.md.",
        },
      ],
      otherRoles: [],
    });
    expect(out).toContain("Per-session archives");
    expect(out).toContain("pa-session-pa-2026-04-29-foo");
    expect(out).toContain("`arch-1`");
    expect(out).toContain("Drafted problem.md and success.md");
  });

  it("renders empty-archives state with first-save explainer", () => {
    const out = formatMemoryInventory({
      workspace: { documentId: null, updatedAt: null, content: null },
      global: { documentId: null, updatedAt: null, content: null },
      sessionArchives: [],
      otherRoles: [],
    });
    expect(out).toContain("no archives yet");
  });
});

describe("readSessionArchives", () => {
  it("returns empty when workspaceId is null", async () => {
    const { readSessionArchives } = await import("./memory.js");
    const backend = makeBackend();
    const out = await readSessionArchives(backend, null);
    expect(out).toEqual([]);
  });

  it("queries metadataSearch with role+artifact_type+workspace_id filter", async () => {
    const { readSessionArchives } = await import("./memory.js");
    let receivedFilter: Record<string, unknown> | undefined;
    const backend = makeBackend({
      metadataSearch: async (req) => {
        receivedFilter = req.metadataFilter as Record<string, unknown>;
        return { documents: [], metadataFilter: req.metadataFilter };
      },
    });
    await readSessionArchives(backend, "ws-uuid-1");
    expect(receivedFilter).toEqual({
      role: "pa",
      artifact_type: "session-archive",
      workspace_id: "ws-uuid-1",
    });
  });

  it("maps doc title + metadata.outcome_summary into a SessionArchiveSummary", async () => {
    const { readSessionArchives } = await import("./memory.js");
    const doc = makeDoc("arch-1", "pa-session-pa-2026-04-29-foo", "transcript");
    doc.metadata = {
      role: "pa",
      artifact_type: "session-archive",
      workspace_id: "ws-uuid-1",
      session_id: "pa-2026-04-29-foo",
      outcome_summary: "Drafted specs.",
    };
    const backend = makeBackend({
      metadataSearch: async () => ({ documents: [doc], metadataFilter: {} }),
    });
    const out = await readSessionArchives(backend, "ws-uuid-1");
    expect(out).toHaveLength(1);
    expect(out[0].documentId).toBe("arch-1");
    expect(out[0].sessionId).toBe("pa-2026-04-29-foo");
    expect(out[0].outcomeSummary).toBe("Drafted specs.");
  });

  it("falls back to title prefix when metadata.session_id is missing", async () => {
    const { readSessionArchives } = await import("./memory.js");
    const doc = makeDoc("arch-2", "pa-session-pa-2026-04-29-bar", "transcript");
    doc.metadata = {}; // no session_id in metadata
    const backend = makeBackend({
      metadataSearch: async () => ({ documents: [doc], metadataFilter: {} }),
    });
    const out = await readSessionArchives(backend, "ws-uuid-1");
    expect(out[0].sessionId).toBe("pa-2026-04-29-bar");
  });
});
