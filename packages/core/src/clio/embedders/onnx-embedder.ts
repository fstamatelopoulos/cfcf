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

/**
 * Best-effort check: does this embedder's main weights file already
 * exist in the local transformers cache? Used by `cfcf init` to skip
 * the full warmup-with-progress-bar dance on re-runs (avoids the
 * misleading "Installing embedder: ... ~130 MB download" line + the
 * network re-validation flicker for tiny config files).
 *
 * Conservative: if the file exists, we assume it's intact. transformers
 * itself does the real integrity check on load. Worst case, a corrupt
 * cache makes us skip the "downloading" message but the load still
 * succeeds (or fails loudly). We do NOT try to parse transformers'
 * manifest.json -- the structure varies across versions.
 *
 * Cache layout (pinned for v0.10.0): `~/.cfcf/models/<hf-model-id>/`
 * with `onnx/<weights>.onnx` inside. Filename depends on `dtype`:
 *   - q8        → onnx/model_quantized.onnx
 *   - q4        → onnx/model_q4.onnx
 *   - fp16      → onnx/model_fp16.onnx
 *   - undefined → onnx/model.onnx (fp32 fallback)
 */
export function isEmbedderCached(entry: EmbedderEntry): boolean {
  const dir = getCacheDir();
  const fname =
    entry.dtype === "q8"   ? "model_quantized.onnx" :
    entry.dtype === "q4"   ? "model_q4.onnx" :
    entry.dtype === "fp16" ? "model_fp16.onnx" :
    entry.dtype === "int8" ? "model_int8.onnx" :
    entry.dtype === "uint8" ? "model_uint8.onnx" :
                              "model.onnx";
  const candidate = join(dir, entry.hfModelId, "onnx", fname);
  return existsSync(candidate);
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
    // this with per-file status updates. We render a single in-place
    // progress line that overwrites itself (\r + ANSI clear-EOL) instead
    // of a new line per tick. Only stderr renders are TTY-aware; if
    // stderr isn't a TTY (CI, log redirection) we fall back to one
    // line per file's final state so logs stay readable.
    //
    // Two shapes of upstream events this has to survive:
    //   1. Known content-length: total stays constant, loaded grows.
    //      Standard percentage bar.
    //   2. Unknown content-length (Bun + some CDN responses): each event
    //      reports total === loaded with growing values. Without special
    //      handling, every event looks like "100%" with a different size
    //      and we'd spam the terminal -- which is exactly what the
    //      previous implementation did. We detect this via the `total`
    //      growing across events and render an indeterminate bar
    //      (fixed-width 50% pulse + "?? MB" so the user knows it's
    //      streaming) updated at most every ~250ms.
    type FileState = {
      loaded: number;
      total: number;
      done: boolean;
      indeterminate: boolean;     // total kept growing → unknown size
      lastRenderAt: number;       // ms timestamp of last stderr write
      lastRenderedPct: number;    // for the determinate path's 5% throttle
    };
    const progressState = new Map<string, FileState>();
    let activeFile: string | null = null;        // file currently on the in-place line
    const isTty = !!process.stderr.isTTY;
    const RENDER_INTERVAL_MS = 250;

    const renderInPlace = (line: string): void => {
      if (isTty) {
        // \r + ANSI clear-EOL; previous line's tail is wiped no matter
        // how short the new one is.
        process.stderr.write(`\r\x1b[K${line}`);
      } else {
        // No TTY: append-only, but still useful as a coarse log.
        process.stderr.write(`${line}\n`);
      }
    };
    // Cap off the current in-place line (newline) so the next append-
    // only write lands cleanly on its own line. Idempotent. Use this
    // before ANY append-only write, regardless of which file owns the
    // active line — that's the bug fix for "[clio] ✓ X" being
    // concatenated onto the previous file's progress bar.
    const finalizeLine = (): void => {
      if (isTty && activeFile !== null) {
        process.stderr.write("\n");
      }
      activeFile = null;
    };

    const fmtMb = (n: number) => (n / 1024 / 1024).toFixed(1);

    const progressCallback = (info: {
      status?: string;
      file?: string;
      name?: string;
      loaded?: number;
      total?: number;
      progress?: number;
    }) => {
      const file = info.file ?? info.name ?? "(unknown)";
      const now = Date.now();

      if (info.status === "progress") {
        const total = info.total ?? 0;
        const loaded = info.loaded ?? 0;
        // No useful state to render yet (HF often emits a 0/0 priming
        // event before any real bytes). Skip until we have either a
        // known total or some loaded bytes.
        if (total === 0 && loaded === 0) return;

        const prior = progressState.get(file) ?? {
          loaded: 0, total: 0, done: false,
          indeterminate: false, lastRenderAt: 0, lastRenderedPct: -1,
        };
        // Indeterminate signal: total grew between events (the upstream
        // is streaming with unknown final size). Latches once tripped.
        // Cheap files that complete in a single progress event are NOT
        // indeterminate — the previous `total === loaded` heuristic
        // misclassified them, leading to bogus "[streaming...] 0.0 MB"
        // lines for tiny config files.
        const indeterminate = prior.indeterminate || (prior.total > 0 && total > prior.total);
        const next: FileState = {
          loaded, total, done: false,
          indeterminate, lastRenderAt: prior.lastRenderAt, lastRenderedPct: prior.lastRenderedPct,
        };

        // Switch the active in-place line to this file if needed.
        if (activeFile !== file) {
          finalizeLine();
          activeFile = file;
        }

        if (indeterminate) {
          // Time-throttled spinner-style progress with just the byte count.
          if (now - prior.lastRenderAt >= RENDER_INTERVAL_MS) {
            renderInPlace(
              `[clio] [streaming...]  ${fmtMb(loaded)} MB  ${file}`,
            );
            next.lastRenderAt = now;
          }
        } else if (total > 0) {
          const pct = Math.floor((loaded / total) * 100);
          // TTY: fine-grained updates every 250ms feel snappy because they
          // overwrite in place. Non-TTY (CI / log redirect): each render
          // is its own line in the log, so we want strictly 5% steps to
          // avoid noise. The time-based fallback only fires under TTY.
          const stepBumped = pct >= prior.lastRenderedPct + 5;
          const timeBumped = isTty
            && now - prior.lastRenderAt >= RENDER_INTERVAL_MS
            && pct !== prior.lastRenderedPct;
          if (stepBumped || timeBumped) {
            renderInPlace(
              `[clio] ${makeBar(pct)} ${pct.toString().padStart(3)}%  ${fmtMb(loaded)}/${fmtMb(total)} MB  ${file}`,
            );
            next.lastRenderedPct = pct;
            next.lastRenderAt = now;
          }
        }

        progressState.set(file, next);
      } else if (info.status === "done") {
        const prior = progressState.get(file);
        // Finalize ANY in-place line first so the ✓ line lands cleanly
        // on its own row -- regardless of which file owned the bar.
        // Previously this only fired when activeFile === file, so a
        // "done" event for file A while file B was rendering would
        // concatenate "[clio] ✓ A" onto B's progress bar.
        finalizeLine();
        // Pick the best size we can: prior progress events → loaded;
        // else done event's own total → total; else "cached" because
        // the file was already on disk and HF emitted no progress
        // events at all (most common for tokenizer.json + already-
        // downloaded model files).
        const finalSize = prior && prior.loaded > 0
          ? `${fmtMb(prior.loaded)} MB`
          : info.total && info.total > 0
          ? `${fmtMb(info.total)} MB`
          : "cached";
        process.stderr.write(`[clio] ✓ ${file}  (${finalSize})\n`);
        if (prior) progressState.set(file, { ...prior, done: true });
      }
    };

    // Build pipeline opts. `dtype` (e.g. "q8") selects which ONNX file is
    // downloaded -- see catalogue's per-entry comment. Omitted → transformers
    // picks the default (fp32 in Node), which means the full unquantized
    // model.onnx (often much larger than the catalogue's `approxSizeMb`).
    const pipelineOpts: Record<string, unknown> = { progress_callback: progressCallback };
    if (this.entry.dtype) pipelineOpts.dtype = this.entry.dtype;
    const pipe = await transformers.pipeline(
      "feature-extraction",
      this.entry.hfModelId,
      pipelineOpts,
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
