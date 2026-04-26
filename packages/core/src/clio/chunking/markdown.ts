/**
 * Heading-aware Markdown chunker.
 *
 * Ported from cerefox/src/cerefox/chunking/markdown.py @2026-04.
 * Maintained independently in cf². Algorithm preserved 1:1 so Clio stays
 * semantically compatible with Cerefox's chunker (same chunk boundaries
 * for the same input).
 *
 * Strategy (see Cerefox docstring for the original rationale):
 * 1. Short-circuit: if the entire document fits within `maxChunkChars`,
 *    return it as one chunk. Splitting small docs at heading boundaries
 *    creates fragments too short to embed meaningfully.
 * 2. For larger docs, parse into (level, heading, body) sections where
 *    level ∈ {0=preamble, 1=H1, 2=H2, 3=H3}. H4+ stays inline as body
 *    text, no chunk boundary.
 * 3. Greedy accumulation: sections collect into a buffer until adding the
 *    next would exceed `maxChunkChars`. Flush when full. All of H1/H2/H3
 *    are treated equally -- size alone controls flush.
 * 4. Oversized sections (one section already > `maxChunkChars`) are split
 *    at paragraph boundaries. Pieces smaller than `minChunkChars` merge
 *    into the preceding piece.
 * 5. No overlap between chunks. The heading breadcrumb already provides
 *    per-chunk context; overlap would duplicate content on reconstruction.
 *
 * Note on embedder alignment (PR2+): the 4000-char default matches
 * Cerefox, which uses cloud embeddings with a long context. Local
 * bge-small has a ~2000-char window; the chunker will be made
 * embedder-aware in PR2 (see docs/research/clio-implementation-decisions.md).
 */

export interface ChunkData {
  /** Zero-indexed position within the document. */
  chunkIndex: number;
  /** Heading breadcrumb as an ordered list (e.g. ["Overview", "Architecture"]). */
  headingPath: string[];
  /** Deepest heading level of this chunk: 0 = preamble/merged; 1-3 = H1-H3. */
  headingLevel: number;
  /** Last element of headingPath, or "" for preamble/merged chunks. */
  title: string;
  /** Full chunk text. Includes heading lines for non-preamble chunks. */
  content: string;
  /** Character count of `content`. */
  charCount: number;
}

/** Matches H1, H2, or H3. Captures hash-count and heading text. */
const HEADING_RE = /^(#{1,3})\s+(.+)$/gm;

/** Two or more blank lines -> paragraph boundary. */
const PARAGRAPH_SEP = /\n{2,}/;

/**
 * Split `text` into heading-aware chunks via greedy size-based accumulation.
 *
 * @param text Raw markdown.
 * @param opts.maxChunkChars Target maximum characters per chunk. Sections
 *   accumulate greedily up to this limit. A single section that already
 *   exceeds the limit is split at paragraph boundaries.
 * @param opts.minChunkChars Minimum size for paragraph-level pieces
 *   produced when splitting an oversized section. Pieces smaller than this
 *   merge into the preceding piece.
 */
export function chunkMarkdown(
  text: string,
  opts: { maxChunkChars?: number; minChunkChars?: number } = {},
): ChunkData[] {
  const maxChunkChars = opts.maxChunkChars ?? 4000;
  const minChunkChars = opts.minChunkChars ?? 100;

  const stripped = text.trim();
  if (!stripped) return [];

  // Short-circuit for small docs.
  if (stripped.length <= maxChunkChars) {
    return [
      {
        chunkIndex: 0,
        headingPath: [],
        headingLevel: 0,
        title: "",
        content: stripped,
        charCount: stripped.length,
      },
    ];
  }

  const sections = parseSections(stripped);
  const chunks: ChunkData[] = [];
  let headingStack: string[] = [];

  // Greedy accumulation buffer.
  let bufParts: string[] = [];
  let bufPath: string[] = [];
  let bufLevel = 0;
  let bufHeading = "";
  let bufChars = 0;

  const flushBuf = () => {
    if (bufParts.length === 0) return;
    const content = bufParts.join("\n\n");
    appendChunk(chunks, content, bufPath, bufLevel, bufHeading, { forceNew: true });
    bufParts = [];
    bufPath = [];
    bufLevel = 0;
    bufHeading = "";
    bufChars = 0;
  };

  for (const { level, heading, body } of sections) {
    // Maintain the breadcrumb stack.
    let path: string[];
    if (level > 0) {
      headingStack = headingStack.slice(0, level - 1);
      headingStack.push(heading);
      path = [...headingStack];
    } else {
      path = [];
    }

    // Build the full content string for this section.
    let content: string;
    if (level > 0) {
      const headerLine = "#".repeat(level) + " " + heading;
      content = body ? headerLine + "\n\n" + body : headerLine;
    } else {
      content = body;
    }

    if (!content.trim()) continue;

    // Oversized single section: flush buffer, then paragraph-split.
    if (content.length > maxChunkChars) {
      flushBuf();
      const headerPrefix =
        level > 0 ? "#".repeat(level) + " " + heading + "\n\n" : "";
      const pieces = splitParagraphs(body, maxChunkChars);
      if (pieces.length === 0) {
        // Body was empty -- heading-only content exceeded max (very rare).
        appendChunk(chunks, content, path, level, heading, { forceNew: true });
      } else {
        pieces.forEach((rawPiece, i) => {
          const piece = (i === 0 ? headerPrefix + rawPiece : rawPiece).trim();
          if (!piece) return;
          appendChunk(chunks, piece, path, level, heading, {
            forceNew: i === 0,
            minChunkChars,
          });
        });
      }
      continue;
    }

    // Section fits within maxChunkChars. Try to accumulate.
    // +2 accounts for the "\n\n" separator between accumulated parts.
    const addition = content.length + (bufParts.length > 0 ? 2 : 0);

    if (bufChars + addition <= maxChunkChars) {
      // Fits -- accumulate.
      if (bufParts.length === 0) {
        // First section in a new buffer: capture its metadata.
        bufPath = path;
        bufLevel = level;
        bufHeading = heading;
      }
      bufParts.push(content);
      bufChars += addition;
    } else {
      // Would overflow -- flush + start a new buffer with this section.
      flushBuf();
      bufParts = [content];
      bufPath = path;
      bufLevel = level;
      bufHeading = heading;
      bufChars = content.length;
    }
  }

  flushBuf();

  // Re-number after any merges.
  for (let i = 0; i < chunks.length; i++) {
    chunks[i].chunkIndex = i;
  }

  return chunks;
}

// ── Internal helpers ──────────────────────────────────────────────────────

interface Section {
  /** 0 = preamble; 1-3 = H1-H3. */
  level: number;
  /** Heading text (empty for preamble). */
  heading: string;
  /** Body text below the heading (or all text for preamble). */
  body: string;
}

/**
 * Split text into (level, heading, body) sections. level === 0 represents
 * a preamble -- content before the first H1/H2/H3 heading. Heading string
 * is empty in that case.
 *
 * Matches the Python `re.split` semantics: the regex has two capture
 * groups (hashes, heading text), so the result comes as
 * [preamble, hashes1, heading1, body1, hashes2, heading2, body2, ...].
 */
function parseSections(text: string): Section[] {
  const segments: Section[] = [];

  // Reset the regex lastIndex since it's /g
  HEADING_RE.lastIndex = 0;

  // Find all heading match positions so we can reconstruct the split.
  const matches: { start: number; end: number; hashes: string; heading: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = HEADING_RE.exec(text)) !== null) {
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      hashes: m[1],
      heading: m[2].replace(/#+\s*$/, "").trim(),
    });
  }

  // Preamble (before first heading).
  const preambleEnd = matches.length > 0 ? matches[0].start : text.length;
  const preamble = text.slice(0, preambleEnd).trim();
  if (preamble) {
    segments.push({ level: 0, heading: "", body: preamble });
  }

  // Each heading's body = text between its end and the next heading's start.
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const bodyStart = current.end;
    const bodyEnd = i + 1 < matches.length ? matches[i + 1].start : text.length;
    const body = text.slice(bodyStart, bodyEnd).trim();
    segments.push({
      level: current.hashes.length,
      heading: current.heading,
      body,
    });
  }

  return segments;
}

interface AppendOpts {
  forceNew?: boolean;
  minChunkChars?: number;
}

/**
 * Append `content` as a new ChunkData. When forceNew is false and content
 * is shorter than minChunkChars, merge into the previous chunk instead.
 * Only used for paragraph-level pieces from oversized sections.
 */
function appendChunk(
  chunks: ChunkData[],
  content: string,
  path: string[],
  level: number,
  heading: string,
  opts: AppendOpts = {},
): void {
  const forceNew = opts.forceNew ?? true;
  const minChunkChars = opts.minChunkChars ?? 0;

  if (!forceNew && content.length < minChunkChars && chunks.length > 0) {
    const prev = chunks[chunks.length - 1];
    prev.content = prev.content + "\n\n" + content;
    prev.charCount = prev.content.length;
    return;
  }

  const title = level > 0 ? heading : path.length > 0 ? path[path.length - 1] : "";
  chunks.push({
    chunkIndex: chunks.length,
    headingPath: path,
    headingLevel: level,
    title,
    content,
    charCount: content.length,
  });
}

/**
 * Split text at paragraph boundaries, keeping each piece under maxChars.
 * No overlap between pieces -- the caller prepends the heading to the
 * first piece.
 *
 * If a single paragraph is longer than maxChars, it is hard-split by
 * character count (preserving the Cerefox `step = max_chars // 2` stride
 * which leaves room for recovery if a hard boundary lands awkwardly).
 */
function splitParagraphs(text: string, maxChars: number): string[] {
  const paragraphs = text.split(PARAGRAPH_SEP).filter((p) => p.trim());
  if (paragraphs.length === 0) return [];

  const result: string[] = [];
  let currentParts: string[] = [];
  let currentLen = 0;

  for (const para of paragraphs) {
    const addition = para.length + (currentParts.length > 0 ? 2 : 0);

    if (currentLen + addition <= maxChars) {
      currentParts.push(para);
      currentLen += addition;
    } else {
      if (currentParts.length > 0) {
        result.push(currentParts.join("\n\n"));
        currentParts = [para];
        currentLen = para.length;
      } else {
        // A single paragraph exceeds maxChars -- hard-split.
        const step = Math.max(1, Math.floor(maxChars / 2));
        for (let start = 0; start < para.length; start += step) {
          result.push(para.slice(start, start + maxChars));
        }
        currentParts = [];
        currentLen = 0;
      }
    }
  }

  if (currentParts.length > 0) {
    result.push(currentParts.join("\n\n"));
  }

  return result;
}
