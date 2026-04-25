/**
 * Embedder interface.
 *
 * Swap point between the default local `OnnxEmbedder` (via
 * @huggingface/transformers) and any future remote / alternative
 * embedder. Kept narrow -- callers only ever embed text.
 */

export interface Embedder {
  /** Embedder slug (e.g. "bge-small-en-v1.5"). */
  readonly name: string;
  /** Output vector dimension. */
  readonly dim: number;
  /** Chunker `max_chunk_chars` paired with this embedder. */
  readonly recommendedChunkMaxChars: number;

  /**
   * Embed a batch of strings. Returns one Float32Array per input text.
   * Each vector is L2-normalised so cosine similarity == dot product.
   */
  embed(texts: string[]): Promise<Float32Array[]>;

  /**
   * Force the underlying model to load NOW (download from HF if not
   * cached, materialise the inference pipeline). Without this, OnnxEmbedder
   * defers all I/O to the first `embed()` call, which means
   * `installActiveEmbedder({ loadNow: true })` would otherwise silently
   * skip the download. Optional because in-memory test embedders don't
   * have anything to warm.
   */
  warmup?(): Promise<void>;

  /**
   * Release native resources. Callers don't usually need this, but the
   * shutdown path does.
   */
  close?(): Promise<void>;
}

/**
 * Cosine similarity on L2-normalised vectors is dot product. Exported so
 * the search path can reuse it without importing the full Embedder.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * L2-normalise a vector in place. Returns the input array for chaining.
 */
export function l2Normalise(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

/**
 * Serialise a Float32Array to the `BLOB` column shape sqlite-vec will
 * use in the future: little-endian IEEE-754 floats back-to-back.
 */
export function embeddingToBlob(v: Float32Array): Uint8Array {
  const buf = new ArrayBuffer(v.length * 4);
  const dv = new DataView(buf);
  for (let i = 0; i < v.length; i++) dv.setFloat32(i * 4, v[i], true);
  return new Uint8Array(buf);
}

/**
 * Deserialise a BLOB to a Float32Array.
 */
export function blobToEmbedding(blob: Uint8Array, dim: number): Float32Array {
  if (blob.length !== dim * 4) {
    throw new Error(`embedding blob length ${blob.length} does not match dim ${dim} * 4`);
  }
  const out = new Float32Array(dim);
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  for (let i = 0; i < dim; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}
