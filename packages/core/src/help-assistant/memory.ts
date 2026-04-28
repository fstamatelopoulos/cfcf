/**
 * Help-Assistant Clio-memory reader.
 *
 * Reads short doc summaries from the two HA-relevant Clio Projects
 * (`cfcf-memory-ha` + `cfcf-memory-global`) so the system prompt can
 * include an inventory the agent uses to bootstrap its understanding
 * of the user's preferences. Best-effort: if either Project is empty
 * or doesn't exist yet, we just return an empty list -- the HA's
 * system prompt explicitly handles the "memory is empty" case.
 *
 * Plan item 5.8 PR4. See `docs/research/help-assistant.md` §"Clio
 * memory schema".
 */

import type { MemoryBackend } from "../clio/backend/types.js";

/**
 * Project names that scope HA memory. Convention recorded in
 * decisions-log.md (2026-04-27, brand-naming entry adjacent) and the
 * help-assistant.md design doc. Other roles use parallel naming
 * (`cfcf-memory-pa`, `cfcf-memory-dev`, etc.) when iter-6 lands.
 */
export const HA_MEMORY_PROJECT = "cfcf-memory-ha";
export const GLOBAL_MEMORY_PROJECT = "cfcf-memory-global";

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
