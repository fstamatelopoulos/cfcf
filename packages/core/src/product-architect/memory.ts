/**
 * Product-Architect Clio memory readers.
 *
 * v2 model: PA uses a disk-as-cache + Clio-as-canonical hybrid. cfcf
 * (this module) reads the Clio docs at PA launch time and injects them
 * into the system prompt; the AGENT does the actual disk I/O + sync
 * during the session.
 *
 * Two standardised Clio docs:
 *   - `pa-workspace-memory` in Project `cf-system-pa-memory`
 *     ONE doc per workspace (identified by metadata `workspace_id`).
 *     Contains workspace summary + chronological session entries +
 *     decisions inline. Updated by PA on each session end.
 *   - `pa-global-memory` in Project `cf-system-memory-global`
 *     ONE doc cross-workspace. User preferences spanning all
 *     workspaces. Lives ONLY in Clio (no local cache). Updated by PA
 *     when cross-cutting preferences emerge.
 *
 * Plus read-only access to other roles' Clio Projects for context
 * (filtered by `workspace_id`):
 *   - cf-system-reflection-memory
 *   - cf-system-architect-memory
 *   - cf-system-ha-memory
 *
 * Plan item 5.14. Design: docs/research/product-architect-design.md
 * §"Memory protocol".
 */
import type { MemoryBackend } from "../clio/backend/types.js";
import type { ClioDocument } from "../clio/types.js";
import { PA_MEMORY_PROJECT, GLOBAL_MEMORY_PROJECT, HA_MEMORY_PROJECT } from "../clio/system-projects.js";

// ── Standardised doc titles ──────────────────────────────────────────
//
// PA always reads/writes to these exact titles. cfcf injects them into
// the system prompt so PA can use --document-id ingest semantics for
// guaranteed update-not-create behaviour.

/** Per-workspace PA memory doc. Lives in cf-system-pa-memory Project. */
export const PA_WORKSPACE_MEMORY_TITLE = "pa-workspace-memory";

/** Cross-workspace PA memory doc. Lives in cf-system-memory-global Project. */
export const PA_GLOBAL_MEMORY_TITLE = "pa-global-memory";

/**
 * Per-session archive doc title pattern. PA writes one of these per
 * session at save time, containing the full transcript. Naming
 * convention: `pa-session-<sessionId>` (matches the disk file
 * `.cfcf-pa/session-<sessionId>.md`). These are NEVER compacted —
 * they're the canonical immutable history. The launcher reads the
 * list (titles + outcomeSummary) at session start so the agent can
 * see what's archived without hitting Clio per query.
 */
export const PA_SESSION_ARCHIVE_TITLE_PREFIX = "pa-session-";

// ── Standardised Project names ───────────────────────────────────────
//
// Re-exports from `clio/system-projects` so the cfcf-owned set stays
// in one place (item 6.18 round-2). The `cf-system-*` naming
// convention replaces the prior `cfcf-memory-*` names; see the
// CHANGELOG for the migration note.

export const PA_PROJECT = PA_MEMORY_PROJECT;
export const GLOBAL_PROJECT = GLOBAL_MEMORY_PROJECT;

/** Other roles' Clio Projects PA reads (READ-ONLY) for cross-role context. */
export const READONLY_OTHER_ROLE_PROJECTS = [
  "cf-system-reflection-memory",
  "cf-system-architect-memory",
  HA_MEMORY_PROJECT,
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
  /** Project name (e.g. cf-system-reflection-memory). */
  project: string;
  /** Most-recent docs scoped to the workspace (or all if workspaceId is null). */
  docs: ClioDocument[];
}

/**
 * One per-session archive doc summary (title + dates +
 * agent-supplied outcomeSummary from metadata). Surfaced in the
 * memory inventory so the agent can see what archives exist
 * without retrieving each. Title follows
 * `pa-session-<sessionId>`.
 */
export interface SessionArchiveSummary {
  documentId: string;
  sessionId: string;
  title: string;
  /** Clio's updatedAt for this archive doc (immutable, so == createdAt typically). */
  updatedAt: string;
  /** Agent-supplied one-line summary; pulled from metadata.outcomeSummary if present. */
  outcomeSummary: string | null;
}

export interface MemoryInventory {
  workspace: WorkspaceMemorySnapshot;
  global: GlobalMemorySnapshot;
  /** Per-session archive docs for this workspace (title + summary; no full content). */
  sessionArchives: SessionArchiveSummary[];
  /** Read-only context: other roles' recent memory for this workspace. */
  otherRoles: OtherRoleMemoryEntry[];
}

// ── Readers ──────────────────────────────────────────────────────────

/**
 * Look up the per-workspace PA memory doc by metadata only — NOT
 * scoped to a specific Clio Project.
 *
 * Why metadata-only (not project-scoped): the metadata triple
 * (`role`, `artifact_type`, `workspace_id`) uniquely identifies PA's
 * per-workspace memory across the whole Clio DB. Pre-v2.1 the search
 * was scoped to `cf-system-pa-memory`, but if the agent's ingest landed
 * in a different project (e.g. `default` because cf-system-pa-memory
 * didn't exist at write time), this scoped search missed the doc
 * entirely — producing the "Clio says no memory" / "disk has memory"
 * discrepancy users hit in dogfood. Metadata-only search is robust
 * to that mismatch.
 *
 * The launcher pre-creates `cf-system-pa-memory` Project at every PA
 * launch so future writes land in the right place; this dropped
 * scope is mostly a backstop for already-misplaced docs (and any
 * future schema drift).
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
      // No `project` filter — see header comment.
    });
    const matches = result.documents;
    if (matches.length === 0) {
      return { documentId: null, updatedAt: null, content: null };
    }
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
 * Look up the global cross-workspace PA memory doc by metadata. There's
 * exactly one of these per cf² install. Same project-agnostic search
 * pattern as `readWorkspaceMemory` — robust to docs landing in the
 * "wrong" Clio Project before the launcher's pre-create runs.
 */
export async function readGlobalMemory(
  backend: MemoryBackend,
): Promise<GlobalMemorySnapshot> {
  try {
    const result = await backend.metadataSearch({
      metadataFilter: {
        role: "pa",
        artifact_type: "global-memory",
      },
      // No `project` filter — see readWorkspaceMemory header comment.
    });
    const matches = result.documents;
    if (matches.length === 0) {
      return { documentId: null, updatedAt: null, content: null };
    }
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
 * List per-session archive docs for this workspace. Each session
 * archive is a separate Clio doc with title `pa-session-<sessionId>`
 * and metadata `{role:"pa", artifact_type:"session-archive",
 * workspace_id:<id>, session_id:<id>, outcome_summary:"..."?}`.
 *
 * Returns a list of summaries (title + dates + outcomeSummary), NOT
 * full content. The agent retrieves full content on demand via
 * `cfcf clio docs get <id>` or `cfcf clio search`.
 *
 * Project-agnostic search (same robustness rationale as
 * readWorkspaceMemory). Cap at 50 archives to keep the prompt
 * manageable; older archives still exist + are searchable, just
 * not pre-listed.
 */
export async function readSessionArchives(
  backend: MemoryBackend,
  workspaceId: string | null,
): Promise<SessionArchiveSummary[]> {
  if (workspaceId === null) return [];
  try {
    const result = await backend.metadataSearch({
      metadataFilter: {
        role: "pa",
        artifact_type: "session-archive",
        workspace_id: workspaceId,
      },
    });
    const docs = result.documents.slice(0, 50);
    return docs.map((doc) => {
      const md = (doc.metadata ?? {}) as Record<string, unknown>;
      const sessionIdFromMetadata = typeof md.session_id === "string" ? md.session_id : "";
      // Title is `pa-session-<sessionId>`; strip prefix as a fallback.
      const sessionId = sessionIdFromMetadata
        || (doc.title.startsWith(PA_SESSION_ARCHIVE_TITLE_PREFIX)
            ? doc.title.slice(PA_SESSION_ARCHIVE_TITLE_PREFIX.length)
            : doc.title);
      return {
        documentId: doc.id,
        sessionId,
        title: doc.title,
        updatedAt: doc.updatedAt,
        outcomeSummary: typeof md.outcome_summary === "string" ? md.outcome_summary : null,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Compose the full memory inventory in one call.
 */
export async function readMemoryInventory(
  backend: MemoryBackend,
  workspaceId: string | null,
): Promise<MemoryInventory> {
  const [workspace, global, sessionArchives, otherRoles] = await Promise.all([
    readWorkspaceMemory(backend, workspaceId),
    readGlobalMemory(backend),
    readSessionArchives(backend, workspaceId),
    readOtherRoleMemory(backend, workspaceId),
  ]);
  return { workspace, global, sessionArchives, otherRoles };
}

/**
 * Ensure the two PA Clio Projects (`cf-system-pa-memory`, `cf-system-memory-global`)
 * exist before the agent runs. Without this, the agent's ingest with
 * `--project cf-system-pa-memory` may auto-route to the `default` Project
 * (cfcf's auto-route-on-missing semantics), producing the discrepancy
 * we hit in dogfood: doc-in-Clio-but-wrong-project.
 *
 * Idempotent: `resolveProject(name, { createIfMissing: true })` is a
 * no-op when the project already exists.
 *
 * Best-effort: any failure (Clio unreachable, etc.) just logs to
 * stderr; PA still launches.
 */
export async function ensurePaClioProjects(backend: MemoryBackend): Promise<void> {
  try {
    await backend.resolveProject(PA_PROJECT, {
      createIfMissing: true,
      description: "Product Architect per-workspace memory (pa-workspace-memory docs)",
    });
    await backend.resolveProject(GLOBAL_PROJECT, {
      createIfMissing: true,
      description: "Cross-role global memory (PA + HA user preferences)",
    });
  } catch (err) {
    console.error(
      `[pa] note: couldn't pre-create Clio Projects (${err instanceof Error ? err.message : String(err)}). ` +
      `Agent ingests may auto-route to the 'default' project.`,
    );
  }
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

  sections.push("## Per-session archives (`pa-session-<sessionId>` docs in `cf-system-pa-memory`)");
  sections.push("");
  if (inv.sessionArchives.length === 0) {
    sections.push("_(no archives yet — the first session save creates the first archive)_");
  } else {
    sections.push(
      `${inv.sessionArchives.length} archived session${inv.sessionArchives.length === 1 ? "" : "s"} (full transcripts; immutable; never compacted). ` +
      `Use \`cfcf clio docs get <id>\` to retrieve any in full, or \`cfcf clio search "<query>" --project cf-system-pa-memory\` to grep across archives:`,
    );
    sections.push("");
    for (const a of inv.sessionArchives) {
      const summary = a.outcomeSummary ? ` — ${a.outcomeSummary}` : "";
      sections.push(`- **${a.title}** \`${a.documentId}\` (${a.updatedAt})${summary}`);
    }
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

// PA_MEMORY_PROJECT + GLOBAL_MEMORY_PROJECT are re-exported via the
// import + the PA_PROJECT / GLOBAL_PROJECT aliases above. After 6.18
// round-2 the canonical names live in clio/system-projects.
