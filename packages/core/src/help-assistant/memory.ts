/**
 * Help-Assistant Clio-memory reader.
 *
 * Reads short doc summaries from the two HA-relevant Clio Projects
 * (`cf-system-ha-memory` + `cf-system-memory-global`) so the system
 * prompt can include an inventory the agent uses to bootstrap its
 * understanding of the user's preferences. Best-effort: if either
 * Project is empty or doesn't exist yet, we just return an empty
 * list -- the HA's system prompt explicitly handles the "memory is
 * empty" case.
 *
 * Plan item 5.8 PR4. See `docs/research/help-assistant.md` §"Clio
 * memory schema".
 *
 * Project name constants are re-exported from `clio/system-projects`
 * (item 6.18 round-2) so the system-managed set stays in one place.
 */

import type { MemoryBackend } from "../clio/backend/types.js";
import { HA_MEMORY_PROJECT, GLOBAL_MEMORY_PROJECT } from "../clio/system-projects.js";

// HA_MEMORY_PROJECT + GLOBAL_MEMORY_PROJECT are the canonical exports
// from `clio/system-projects` (the single source of truth for cfcf-
// owned Clio Project names). They're imported here for use by the HA
// memory reader below; consumers should import them directly from
// `@cfcf/core` (which re-exports clio/system-projects).

/**
 * Maximum chars per doc body included in the inventory. Each
 * inventory entry has a header (slug + title) plus this much body
 * preview; lets the agent see what's there without dumping the full
 * memory corpus into the system prompt.
 */
const MEMORY_PREVIEW_CHARS = 800;

/**
 * Maximum number of memory docs included in the inventory across both
 * Projects. Cap is generous because memory entries are typically
 * small (a few hundred chars each) and the system prompt has plenty
 * of headroom in modern context windows.
 */
const MAX_MEMORY_DOCS = 50;

export async function loadMemoryInventory(backend: MemoryBackend): Promise<string[]> {
  const inventory: string[] = [];
  for (const project of [GLOBAL_MEMORY_PROJECT, HA_MEMORY_PROJECT]) {
    try {
      const docs = await backend.listDocuments({
        project,
        limit: MAX_MEMORY_DOCS,
        deletedFilter: "exclude",
      });
      if (docs.length === 0) continue;
      const lines: string[] = [`### Project: \`${project}\` (${docs.length} doc${docs.length === 1 ? "" : "s"})`, ""];
      for (const doc of docs) {
        const content = await backend.getDocumentContent(doc.id);
        const preview = content
          ? content.content.slice(0, MEMORY_PREVIEW_CHARS).replace(/\n+/g, " ").trim()
          : "(content unavailable)";
        const truncated = content && content.content.length > MEMORY_PREVIEW_CHARS ? "…" : "";
        lines.push(`- **${doc.title}** (\`${doc.id}\`)`);
        lines.push(`  ${preview}${truncated}`);
        lines.push("");
      }
      inventory.push(lines.join("\n"));
    } catch (err) {
      // Best-effort: a missing project, a permissions issue, or any
      // other Clio failure shouldn't block the HA from launching.
      // Surface a one-line note + continue.
      inventory.push(`### Project: \`${project}\` -- unable to read (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return inventory;
}
