/**
 * Product-Architect Clio memory readers.
 *
 * v2 model: PA uses a disk-as-cache + Clio-as-canonical hybrid. cfcf
 * (this module) reads the Clio docs at PA launch time and injects them
 * into the system prompt; the AGENT does the actual disk I/O + sync
 * during the session.
 *
 * Two standardised Clio docs:
 *   - `pa-workspace-memory` in Project `cfcf-memory-pa`
 *     ONE doc per workspace (identified by metadata `workspace_id`).
 *     Contains workspace summary + chronological session entries +
 *     decisions inline. Updated by PA on each session end.
 *   - `pa-global-memory` in Project `cfcf-memory-global`
 *     ONE doc cross-workspace. User preferences spanning all
 *     workspaces. Lives ONLY in Clio (no local cache). Updated by PA
 *     when cross-cutting preferences emerge.
 *
 * Plus read-only access to other roles' Clio Projects for context
 * (filtered by `workspace_id`):
 *   - cfcf-memory-reflection
 *   - cfcf-memory-architect
 *   - cfcf-memory-ha
 *
 * Plan item 5.14. Design: docs/research/product-architect-design.md
 * §"Memory protocol".
 */
import type { MemoryBackend } from "../clio/backend/types.js";
import type { ClioDocument } from "../clio/types.js";

// ── Standardised doc titles ──────────────────────────────────────────
//
// PA always reads/writes to these exact titles. cfcf injects them into
// the system prompt so PA can use --document-id ingest semantics for
// guaranteed update-not-create behaviour.

/** Per-workspace PA memory doc. Lives in cfcf-memory-pa Project. */
export const PA_WORKSPACE_MEMORY_TITLE = "pa-workspace-memory";

/** Cross-workspace PA memory doc. Lives in cfcf-memory-global Project. */
export const PA_GLOBAL_MEMORY_TITLE = "pa-global-memory";

// ── Standardised Project names ───────────────────────────────────────

export const PA_PROJECT = "cfcf-memory-pa";
export const GLOBAL_PROJECT = "cfcf-memory-global";

/** Other roles' Clio Projects PA reads (READ-ONLY) for cross-role context. */
export const READONLY_OTHER_ROLE_PROJECTS = [
  "cfcf-memory-reflection",
  "cfcf-memory-architect",
  "cfcf-memory-ha",
] as const;

/** How many recent docs to surface per other-role project. */
const OTHER_ROLE_DOC_LIMIT = 10;

// ── Result shapes ────────────────────────────────────────────────────

export interface WorkspaceMemorySnapshot {
  /** Clio doc ID — null if the doc doesn't exist yet. */
  documentId: string | null;
  /** Last update timestamp (ISO) — null if the doc doesn't exist. */
  updatedAt: string | null;
  /** Full doc content — null if the doc doesn't exist. */
  content: string | null;
}

export interface GlobalMemorySnapshot {
  /** Clio doc ID — null if the doc doesn't exist yet. */
  documentId: string | null;
  /** Last update timestamp (ISO) — null if the doc doesn't exist. */
  updatedAt: string | null;
  /** Full doc content — null if the doc doesn't exist. */
  content: string | null;
}

export interface OtherRoleMemoryEntry {
  /** Project name (e.g. cfcf-memory-reflection). */
  project: string;
  /** Most-recent docs scoped to the workspace (or all if workspaceId is null). */
  docs: ClioDocument[];
}

export interface MemoryInventory {
  workspace: WorkspaceMemorySnapshot;
  global: GlobalMemorySnapshot;
  /** Read-only context: other roles' recent memory for this workspace. */
  otherRoles: OtherRoleMemoryEntry[];
}

// ── Readers ──────────────────────────────────────────────────────────

/**
 * Look up the per-workspace PA memory doc, scoped via metadata. The
 * doc title is fixed (`pa-workspace-memory`) — every workspace's PA
 * memory uses the same title in the same Project. Per-workspace
 * scoping is via metadata, NOT title.
 *
 * Returns an empty snapshot when:
 *   - workspaceId is null (workspace not registered yet — PA will
 *     instruct the user to register before any memory ops)
 *   - No matching doc exists yet (first session for this workspace)
 *   - Clio is unreachable (best-effort; agent still launches)
 */
export async function readWorkspaceMemory(
  backend: MemoryBackend,
  workspaceId: string | null,
): Promise<WorkspaceMemorySnapshot> {
  if (workspaceId === null) {
    return { documentId: null, updatedAt: null, content: null };
  }
  try {
    const result = await backend.metadataSearch({
      metadataFilter: {
        role: "pa",
        artifact_type: "workspace-memory",
        workspace_id: workspaceId,
      },
      project: PA_PROJECT,
    });
    const matches = result.documents;
    if (matches.length === 0) {
      return { documentId: null, updatedAt: null, content: null };
    }
    // Newest first; if there's somehow more than one, take the most
    // recent. (There should never be more than one per workspace.)
    const doc = matches[0];
    const content = await backend.getDocumentContent(doc.id);
    return {
      documentId: doc.id,
      updatedAt: doc.updatedAt,
      content: content?.content ?? null,
    };
  } catch {
    return { documentId: null, updatedAt: null, content: null };
  }
}

/**
 * Look up the global cross-workspace PA memory doc by title. There's
 * exactly one of these per cf² install (no scoping by workspace_id).
 */
export async function readGlobalMemory(
  backend: MemoryBackend,
): Promise<GlobalMemorySnapshot> {
  try {
    const project = await backend.getProject(GLOBAL_PROJECT);
    if (!project) {
      return { documentId: null, updatedAt: null, content: null };
    }
    const doc = await backend.findDocumentByTitle(project.id, PA_GLOBAL_MEMORY_TITLE);
    if (!doc) {
      return { documentId: null, updatedAt: null, content: null };
    }
    const content = await backend.getDocumentContent(doc.id);
    return {
      documentId: doc.id,
      updatedAt: doc.updatedAt,
      content: content?.content ?? null,
    };
  } catch {
    return { documentId: null, updatedAt: null, content: null };
  }
}

/**
 * Read top-N most recent docs from each of the other-role Clio
 * Projects, optionally scoped to the workspace_id. Read-only — PA
 * never writes to these projects, but uses their content for
 * cross-role context (e.g. "what did reflection observe last
 * iteration?").
 */
export async function readOtherRoleMemory(
  backend: MemoryBackend,
  workspaceId: string | null,
): Promise<OtherRoleMemoryEntry[]> {
  const entries: OtherRoleMemoryEntry[] = [];
  for (const project of READONLY_OTHER_ROLE_PROJECTS) {
    try {
      let docs: ClioDocument[] = [];
      if (workspaceId !== null) {
        const result = await backend.metadataSearch({
          metadataFilter: { workspace_id: workspaceId },
          project,
        });
        docs = result.documents.slice(0, OTHER_ROLE_DOC_LIMIT);
      } else {
        docs = await backend.listDocuments({
          project,
          limit: OTHER_ROLE_DOC_LIMIT,
          deletedFilter: "exclude",
        });
      }
      entries.push({ project, docs });
    } catch {
      entries.push({ project, docs: [] });
    }
  }
  return entries;
}

/**
 * Compose the full memory inventory in one call.
 */
export async function readMemoryInventory(
  backend: MemoryBackend,
  workspaceId: string | null,
): Promise<MemoryInventory> {
  const [workspace, global, otherRoles] = await Promise.all([
    readWorkspaceMemory(backend, workspaceId),
    readGlobalMemory(backend),
    readOtherRoleMemory(backend, workspaceId),
  ]);
  return { workspace, global, otherRoles };
}

// ── Formatters (for the system prompt) ───────────────────────────────

/**
 * Format the memory inventory into a Markdown section embedded in PA's
 * system prompt. Pure function.
 */
export function formatMemoryInventory(inv: MemoryInventory): string {
  const sections: string[] = [];
  sections.push("# Memory inventory (snapshot at session start)");
  sections.push("");

  sections.push("## Per-workspace PA memory (`pa-workspace-memory`)");
  sections.push("");
  if (inv.workspace.content === null) {
    sections.push(
      "_(no workspace memory yet — either this workspace isn't registered, " +
      "or this is the first session. You'll create the doc on first save.)_",
    );
  } else {
    sections.push(`**Doc ID**: \`${inv.workspace.documentId}\`  `);
    sections.push(`**Last updated**: ${inv.workspace.updatedAt}`);
    sections.push("");
    sections.push("```markdown");
    sections.push(inv.workspace.content);
    sections.push("```");
  }
  sections.push("");

  sections.push("## Global PA memory (`pa-global-memory`)");
  sections.push("");
  if (inv.global.content === null) {
    sections.push("_(no global memory yet — first session, or no cross-cutting preferences captured.)_");
  } else {
    sections.push(`**Doc ID**: \`${inv.global.documentId}\`  `);
    sections.push(`**Last updated**: ${inv.global.updatedAt}`);
    sections.push("");
    sections.push("```markdown");
    sections.push(inv.global.content);
    sections.push("```");
  }
  sections.push("");

  sections.push("## Other roles' memory (read-only)");
  sections.push("");
  sections.push("Cross-role context PA reads but does NOT write to. Filtered by this workspace where applicable.");
  sections.push("");
  for (const entry of inv.otherRoles) {
    if (entry.docs.length === 0) {
      sections.push(`### \`${entry.project}\` — _(empty for this workspace)_`);
      sections.push("");
      continue;
    }
    sections.push(`### \`${entry.project}\` (${entry.docs.length} doc${entry.docs.length === 1 ? "" : "s"})`);
    sections.push("");
    for (const doc of entry.docs) {
      sections.push(`- **${doc.title}** \`${doc.id}\` — updated ${doc.updatedAt}`);
    }
    sections.push("");
  }

  return sections.join("\n");
}

/**
 * Convenience: read + format in one call.
 */
export async function loadMemoryInventoryFormatted(
  backend: MemoryBackend,
  workspaceId: string | null,
): Promise<{ inventory: MemoryInventory; markdown: string }> {
  const inventory = await readMemoryInventory(backend, workspaceId);
  return { inventory, markdown: formatMemoryInventory(inventory) };
}

// ── Backwards-compat exports preserved for callers that imported v1 ──

/**
 * Legacy export from v1. The new public surface uses
 * `readMemoryInventory` / `formatMemoryInventory`. Kept for any
 * external callers; returns the formatted Markdown wrapped in an array
 * to match the v1 shape.
 *
 * @deprecated use readMemoryInventory + formatMemoryInventory.
 */
export async function loadMemoryInventory(
  backend: MemoryBackend,
  workspaceId: string | null = null,
): Promise<string[]> {
  const { markdown } = await loadMemoryInventoryFormatted(backend, workspaceId);
  return [markdown];
}

export const PA_MEMORY_PROJECT = PA_PROJECT;
export const GLOBAL_MEMORY_PROJECT = GLOBAL_PROJECT;
