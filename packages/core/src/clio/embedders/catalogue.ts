/**
 * Embedder catalogue.
 *
 * Single source of truth for the embedders Clio knows about. Each entry
 * declares the HuggingFace model id, dimension, recommended chunk-size,
 * and recommended small-to-big expansion radius. The current default is
 * `nomic-embed-text-v1.5`: its 8k token context comfortably fits the
 * Cerefox chunker's default 4k-token effective chunk window, so design
 * docs + iteration logs embed as one coherent passage rather than being
 * split across many small chunks. Users can still pick a lighter model
 * (bge-small / MiniLM) at install time via
 * `cfcf clio embedder set <name>`. Actual downloading + loading is
 * handled by @huggingface/transformers from the HuggingFace model hub;
 * we only declare identity here.
 *
 * Design-doc §6 + `docs/research/clio-implementation-decisions.md`:
 *   - Chunk size + expansion radius are owned by the embedder manifest,
 *     NOT the user config. Getting this wrong silently breaks search.
 *   - Switching embedders after ingestion poisons the vector corpus
 *     (dim change + token-window change invalidate old chunk boundaries).
 *     PR2 locks the active embedder in clio.db; reindex is v2.
 */

export interface EmbedderEntry {
  /** Stable slug used in CLI + clio.db. */
  name: string;
  /** HuggingFace model id consumed by @huggingface/transformers. */
  hfModelId: string;
  /** Output vector dimension. */
  dim: number;
  /**
   * Chunker `max_chunk_chars` paired with this embedder. Roughly 4 chars
   * per token × 0.9 safety margin × effective context window.
   */
  recommendedChunkMaxChars: number;
  /**
   * Small-to-big expansion: pull N neighbors on each side of every hit
   * chunk for the full passage. Smaller chunks -> more neighbors.
   */
  recommendedExpansionRadius: number;
  /** Approximate on-disk size of model weights + tokenizer. */
  approxSizeMb: number;
  /** Human-readable one-liner. */
  description: string;
}

/**
 * Built-in catalogue. Update this list to add a new installable embedder.
 */
export const EMBEDDER_CATALOGUE: EmbedderEntry[] = [
  {
    name: "bge-small-en-v1.5",
    hfModelId: "Xenova/bge-small-en-v1.5",
    dim: 384,
    recommendedChunkMaxChars: 1800,
    recommendedExpansionRadius: 2,
    approxSizeMb: 120,
    description: "Compact. BAAI bge-small-en-v1.5, 384 dims, ~512 token context. Good retrieval quality for its size, MIT licence. Pick this over the default when disk space / RAM is tight.",
  },
  {
    name: "all-MiniLM-L6-v2",
    hfModelId: "Xenova/all-MiniLM-L6-v2",
    dim: 384,
    recommendedChunkMaxChars: 1000,
    recommendedExpansionRadius: 3,
    approxSizeMb: 23,
    description: "Small footprint. Sentence-transformers all-MiniLM-L6-v2, 384 dims, ~256 token context. Use when disk space is tight.",
  },
  {
    name: "nomic-embed-text-v1.5",
    hfModelId: "Xenova/nomic-embed-text-v1.5",
    dim: 768,
    recommendedChunkMaxChars: 7000,
    recommendedExpansionRadius: 1,
    approxSizeMb: 140,
    description: "Default. Nomic Embed Text v1.5, 768 dims, ~8k token context. Comfortably fits the Cerefox chunker's 4k-token effective window, so long design docs and iteration logs embed as one coherent passage.",
  },
  {
    name: "bge-base-en-v1.5",
    hfModelId: "Xenova/bge-base-en-v1.5",
    dim: 768,
    recommendedChunkMaxChars: 1800,
    recommendedExpansionRadius: 2,
    approxSizeMb: 430,
    description: "Quality bump over bge-small. 768 dims. Use when retrieval quality matters more than disk size.",
  },
];

export const DEFAULT_EMBEDDER_NAME = "nomic-embed-text-v1.5";

export function findEmbedderEntry(name: string): EmbedderEntry | undefined {
  return EMBEDDER_CATALOGUE.find((e) => e.name === name);
}

export function getDefaultEmbedderEntry(): EmbedderEntry {
  const e = findEmbedderEntry(DEFAULT_EMBEDDER_NAME);
  if (!e) throw new Error(`Embedder catalogue is missing the default "${DEFAULT_EMBEDDER_NAME}"`);
  return e;
}
