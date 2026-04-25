/**
 * ONNX-backed Embedder via @huggingface/transformers.
 *
 * Lazy model download on first `embed()` call. Progress is written to
 * stderr so first-use latency is visible to the user. Models cached to
 * `~/.cfcf/models/` (overridable via CFCF_CLIO_MODELS_DIR).
 *
 * Fails loudly on network errors so callers can fall back to FTS-only
 * mode (see LocalClio.search's mode handling).
 */

import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import type { Embedder } from "./types.js";
import { l2Normalise } from "./types.js";
import { findEmbedderEntry, type EmbedderEntry } from "./catalogue.js";

// We import transformers lazily because the package is ~30 MB and we
// want to keep the cold-start path cheap when Clio isn't used.
type TransformersModule = typeof import("@huggingface/transformers");

function getCacheDir(): string {
  if (process.env.CFCF_CLIO_MODELS_DIR) return process.env.CFCF_CLIO_MODELS_DIR;
  return join(homedir(), ".cfcf", "models");
}

function makeBar(pct: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

/**
 * Lazy-load + configure the transformers runtime. Exported for tests
 * that want to reuse the same runtime handle.
 */
let cached: TransformersModule | null = null;
async function loadTransformers(): Promise<TransformersModule> {
  if (cached) return cached;
  // Dynamic import keeps the ~30 MB transformers package out of the
  // non-Clio cold path.
  cached = await import("@huggingface/transformers");

  // Cache models locally so subsequent runs don't re-download.
  const dir = getCacheDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  cached.env.cacheDir = dir;
  // Prefer local-only when the model is already cached (avoids a network
  // check on every run); falls back to download when the model is
  // missing. transformers.js reads this flag at pipeline-load time.
  cached.env.allowLocalModels = true;
  cached.env.allowRemoteModels = true;
  return cached;
}

/**
 * Reset the cached transformers module. Tests use this between runs so
 * embedder state doesn't leak. Not part of the public API.
 */
export function __resetTransformersCache(): void {
  cached = null;
}

export class OnnxEmbedder implements Embedder {
  readonly name: string;
  readonly dim: number;
  readonly recommendedChunkMaxChars: number;
  private readonly entry: EmbedderEntry;
  // transformers.js `pipeline()` is a factory that returns a callable.
  // Typing it precisely needs type-juggling -- treat it as a generic
  // feature-extraction function.
  private pipeline: ((texts: string[], opts?: unknown) => Promise<{ data: Float32Array; dims: number[] }>) | null = null;

  constructor(entry: EmbedderEntry) {
    this.entry = entry;
    this.name = entry.name;
    this.dim = entry.dim;
    this.recommendedChunkMaxChars = entry.recommendedChunkMaxChars;
  }

  private async ensurePipeline(): Promise<void> {
    if (this.pipeline) return;
    const transformers = await loadTransformers();
    // `pipeline("feature-extraction", ...)` returns a FeatureExtractionPipeline.
    // transformers.js loads the model + tokenizer from the HF hub on first
    // use; subsequent calls are cached to disk (see loadTransformers()).
    // Bandwidth hint lets the user decide whether to wait or cancel before
    // the download starts. We anchor the ETA at two realistic link speeds
    // (50 Mbps "good home broadband" / 10 Mbps "slow café wifi") so a
    // single number doesn't mislead in either direction.
    const mb = this.entry.approxSizeMb;
    const fastSec = Math.round((mb * 8) / 50);
    const slowSec = Math.round((mb * 8) / 10);
    const fmt = (s: number) => (s < 60 ? `${s}s` : `${Math.round(s / 60)}m`);
    process.stderr.write(
      `[clio] loading embedder "${this.entry.name}" from HuggingFace (~${mb} MB; est. ${fmt(fastSec)}-${fmt(slowSec)} at 50-10 Mbps; first-run only)…\n`,
    );

    // Progress callback for the model download. transformers.js calls
    // this with per-file status updates. We render a minimal
    // one-line-per-file progress bar on stderr so the user sees the
    // download ticking rather than staring at a silent terminal for
    // 60 seconds.
    const progressState = new Map<string, { loaded: number; total: number; done: boolean; lastPct: number }>();
    const progressCallback = (info: {
      status?: string;
      file?: string;
      name?: string;
      loaded?: number;
      total?: number;
      progress?: number;
    }) => {
      const file = info.file ?? info.name ?? "(unknown)";
      if (info.status === "progress") {
        const total = info.total ?? 0;
        const loaded = info.loaded ?? 0;
        const pct = total > 0 ? Math.floor((loaded / total) * 100) : 0;
        const prior = progressState.get(file) ?? { loaded: 0, total: 0, done: false, lastPct: -1 };
        // Only re-render when the percentage advances by ≥5 so we
        // don't flood stderr.
        if (pct >= prior.lastPct + 5 || pct === 100) {
          const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
          const bar = makeBar(pct);
          process.stderr.write(
            `[clio] ${bar} ${pct.toString().padStart(3)}%  ${mb(loaded)}/${mb(total)} MB  ${file}\n`,
          );
          progressState.set(file, { loaded, total, done: pct >= 100, lastPct: pct });
        } else {
          progressState.set(file, { ...prior, loaded, total });
        }
      } else if (info.status === "done") {
        const prior = progressState.get(file);
        if (prior && !prior.done) {
          process.stderr.write(`[clio] ✓ ${file}\n`);
          progressState.set(file, { ...prior, done: true, lastPct: 100 });
        }
      }
    };

    const pipe = await transformers.pipeline(
      "feature-extraction",
      this.entry.hfModelId,
      { progress_callback: progressCallback },
    );
    // Stash the callable pipeline. Cast through unknown because the real
    // type uses complex generics we don't need to reproduce here.
    this.pipeline = pipe as unknown as typeof this.pipeline;
    process.stderr.write(`[clio] embedder ready.\n`);
  }

  /**
   * Force the model to download + materialise the inference pipeline now.
   * Without this, OnnxEmbedder defers all I/O to the first `embed()` call
   * (so `installActiveEmbedder({ loadNow: true })` would silently skip the
   * download and the user's first `cfcf clio search` pays the multi-minute
   * cost mid-query).
   */
  async warmup(): Promise<void> {
    await this.ensurePipeline();
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.ensurePipeline();
    if (!this.pipeline) throw new Error("OnnxEmbedder: pipeline failed to initialise");

    // transformers.js batches internally. We pass pooling=mean + normalize=true
    // which mirrors sentence-transformers behaviour (bge + MiniLM + nomic all
    // expect mean-pooled normalised embeddings).
    const out = await this.pipeline(texts, { pooling: "mean", normalize: true });
    // `out.data` is a flat Float32Array of length batch * dim.
    // `out.dims` is [batch, dim].
    const dim = out.dims[out.dims.length - 1];
    if (dim !== this.dim) {
      throw new Error(
        `OnnxEmbedder "${this.name}": expected dim=${this.dim} from catalogue, got ${dim} from model`,
      );
    }
    const vectors: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      const slice = out.data.slice(i * dim, (i + 1) * dim);
      // transformers.js normalize=true already L2-normalises; belt and
      // braces for the next embedder that doesn't.
      vectors.push(l2Normalise(slice));
    }
    return vectors;
  }

  async close(): Promise<void> {
    // transformers.js pipelines expose `.dispose()` which releases the
    // backing InferenceSession. Release is best-effort.
    try {
      const pipe = this.pipeline as unknown as { dispose?: () => Promise<void> } | null;
      if (pipe && typeof pipe.dispose === "function") await pipe.dispose();
    } catch { /* best-effort */ }
    this.pipeline = null;
  }
}

/**
 * Construct an `OnnxEmbedder` from an embedder slug. Throws if the name
 * is not in the catalogue.
 */
export function makeOnnxEmbedder(name: string): OnnxEmbedder {
  const entry = findEmbedderEntry(name);
  if (!entry) {
    throw new Error(
      `Unknown embedder "${name}". Run 'cfcf clio embedder list' to see supported embedders.`,
    );
  }
  return new OnnxEmbedder(entry);
}
