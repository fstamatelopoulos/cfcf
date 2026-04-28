/**
 * Product-Architect Clio-memory reader.
 *
 * Reads short doc summaries from the two PA-relevant Clio Projects
 * (`cfcf-memory-pa` + `cfcf-memory-global`) so the system prompt can
 * include an inventory the agent uses to bootstrap its understanding
 * of the user's accumulated spec context + cross-role preferences.
 *
 * Mirrors `help-assistant/memory.ts` -- same shape, different Project
 * name. Best-effort: missing Projects, permissions errors, and any
 * other Clio failure surface as a one-line note + don't block the PA
 * from launching.
 *
 * Plan item 5.14. See `docs/research/product-architect.md` §"Clio
 * memory schema".
 */
import type { MemoryBackend } from "../clio/backend/types.js";
import { GLOBAL_MEMORY_PROJECT } from "../help-assistant/memory.js";

/**
 * PA's Clio Project. Convention: `cfcf-memory-<role>`. Recorded in
 * `docs/research/product-architect.md` and the decisions log.
 *
 * Workspace-scoping is layered on top of the Project (each PA write
 * carries `workspace_id` in its metadata, so a multi-workspace user
 * sees only the entries relevant to the current workspace at session
 * start). v1 inventory is unfiltered Project-wide; workspace-scoped
 * filtering is a follow-up.
 */
export const PA_MEMORY_PROJECT = "cfcf-memory-pa";

// Re-export for callers that want a single import site.
export { GLOBAL_MEMORY_PROJECT };

/**
 * Maximum chars per doc body included in the inventory. Each
 * inventory entry has a header (slug + title) plus this much body
 * preview; lets the agent see what's there without dumping the full
 * spec corpus into the system prompt.
 */
const MEMORY_PREVIEW_CHARS = 800;

/**
 * Maximum number of memory docs included in the inventory across both
 * Projects. Generous cap because memory entries are typically small
 * (a few hundred chars each) and the system prompt has plenty of
 * headroom in modern context windows.
 */
const MAX_MEMORY_DOCS = 50;

export async function loadMemoryInventory(backend: MemoryBackend): Promise<string[]> {
  const inventory: string[] = [];
  for (const project of [GLOBAL_MEMORY_PROJECT, PA_MEMORY_PROJECT]) {
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
      inventory.push(`### Project: \`${project}\` -- unable to read (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return inventory;
}
