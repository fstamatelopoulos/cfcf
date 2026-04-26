/**
 * Active-embedder persistence helpers.
 *
 * Reads/writes the single-row `clio_active_embedder` table. The active
 * embedder is DB-scoped (one per clio.db) so the vector corpus stays
 * coherent across the process lifetime. Switching embedders poisons
 * existing embeddings -- gated by `cfcf clio embedder set` (PR2+).
 */

import type { Database } from "bun:sqlite";
import { findEmbedderEntry, type EmbedderEntry } from "./catalogue.js";

export interface ActiveEmbedderRecord {
  name: string;
  dim: number;
  hfModelId: string;
  recommendedChunkMaxChars: number;
  recommendedExpansionRadius: number;
  installedAt: string;
}

interface RawRow {
  name: string;
  dim: number;
  hf_model_id: string;
  recommended_chunk_max_chars: number;
  recommended_expansion_radius: number;
  installed_at: string;
}

export function getActiveEmbedder(db: Database): ActiveEmbedderRecord | null {
  const row = db.query<RawRow, []>(
    `SELECT name, dim, hf_model_id, recommended_chunk_max_chars, recommended_expansion_radius, installed_at
       FROM clio_active_embedder WHERE id = 1 LIMIT 1`,
  ).get();
  if (!row) return null;
  return {
    name: row.name,
    dim: row.dim,
    hfModelId: row.hf_model_id,
    recommendedChunkMaxChars: row.recommended_chunk_max_chars,
    recommendedExpansionRadius: row.recommended_expansion_radius,
    installedAt: row.installed_at,
  };
}

/**
 * Install an embedder as the active one. Only allowed when:
 *   - No active embedder is set, OR
 *   - The new name matches the currently-active name (no-op refresh), OR
 *   - `opts.force` is true AND there are no existing embeddings in
 *     `clio_chunks` (otherwise a switch would poison the corpus).
 *
 * Returns the newly-active record.
 */
export function setActiveEmbedder(
  db: Database,
  entry: EmbedderEntry,
  opts: { force?: boolean } = {},
): ActiveEmbedderRecord {
  const existing = getActiveEmbedder(db);

  if (existing && existing.name !== entry.name) {
    // Check whether any embeddings exist. If yes, refuse unless --force
    // (which is currently only settable from the CLI; we validate here
    // regardless so the HTTP path stays safe).
    const row = db.query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM clio_chunks WHERE embedding IS NOT NULL`,
    ).get();
    const embeddedCount = row?.n ?? 0;
    if (embeddedCount > 0 && !opts.force) {
      throw new Error(
        `Refusing to switch active embedder from "${existing.name}" to "${entry.name}" -- ` +
        `${embeddedCount} chunk(s) already have embeddings from the old model. ` +
        `Run 'cfcf clio reindex' (v2) first, or re-install with --force after deleting existing chunks.`,
      );
    }
  }

  db.prepare(`
    INSERT INTO clio_active_embedder
      (id, name, dim, hf_model_id, recommended_chunk_max_chars, recommended_expansion_radius, installed_at)
    VALUES (1, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      dim = excluded.dim,
      hf_model_id = excluded.hf_model_id,
      recommended_chunk_max_chars = excluded.recommended_chunk_max_chars,
      recommended_expansion_radius = excluded.recommended_expansion_radius,
      installed_at = excluded.installed_at
  `).run(
    entry.name,
    entry.dim,
    entry.hfModelId,
    entry.recommendedChunkMaxChars,
    entry.recommendedExpansionRadius,
  );

  const record = getActiveEmbedder(db);
  if (!record) throw new Error("setActiveEmbedder: record write failed");
  return record;
}

/**
 * Clear the active embedder (used by tests + `reindex` code paths).
 */
export function clearActiveEmbedder(db: Database): void {
  db.exec("DELETE FROM clio_active_embedder");
}

/**
 * Resolve an active-embedder record to its full catalogue entry (with
 * description + approxSizeMb etc.). Falls back to the stored record
 * when the embedder is no longer in the shipped catalogue (possible on
 * downgrade).
 */
export function toCatalogueEntry(record: ActiveEmbedderRecord): EmbedderEntry {
  const fromCatalogue = findEmbedderEntry(record.name);
  if (fromCatalogue) return fromCatalogue;
  return {
    name: record.name,
    hfModelId: record.hfModelId,
    dim: record.dim,
    recommendedChunkMaxChars: record.recommendedChunkMaxChars,
    recommendedExpansionRadius: record.recommendedExpansionRadius,
    approxSizeMb: 0,
    description: `(installed but not in current catalogue)`,
  };
}
