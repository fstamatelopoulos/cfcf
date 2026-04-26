/**
 * Clio iteration-loop auto-ingest (item 5.7 PR3).
 *
 * Ingest hooks called from `iteration-loop.ts` at iteration boundaries.
 * Each hook respects the workspace's effective `clio.ingestPolicy`:
 *   - "off":             do nothing
 *   - "summaries-only":  ingest curated artifacts only (default)
 *   - "all":             ingest curated + raw per-iteration traces
 *
 * All hooks swallow errors and log warnings. Clio ingest failures must
 * never break an iteration -- the loop is the product; Clio is an
 * adjunct service.
 */

import { readFile, access } from "fs/promises";
import { join } from "path";
import type { WorkspaceConfig, JudgeSignals, ReflectionSignals } from "../types.js";
import type { MemoryBackend } from "./backend/types.js";
import type { IngestResult } from "./types.js";
import { readConfig } from "../config.js";

export type IngestPolicy = "off" | "summaries-only" | "all";

/**
 * Resolve the effective ingest policy for a workspace. Priority:
 *   workspace.clio.ingestPolicy -> global.clio.ingestPolicy -> "summaries-only"
 */
export async function resolveIngestPolicy(workspace: WorkspaceConfig): Promise<IngestPolicy> {
  if (workspace.clio?.ingestPolicy) return workspace.clio.ingestPolicy;
  const global = await readConfig();
  if (global?.clio?.ingestPolicy) return global.clio.ingestPolicy;
  return "summaries-only";
}

/**
 * Resolve the Clio Project to ingest into. Uses the workspace's
 * `clioProject` when set; otherwise the named "default" Project (auto-
 * created by the backend on first ingest).
 */
function resolveClioProject(workspace: WorkspaceConfig): string {
  return workspace.clioProject?.trim() || "default";
}

// ── Shared metadata builder ───────────────────────────────────────────────

function baseMetadata(workspace: WorkspaceConfig, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    workspace_id: workspace.id,
    workspace_name: workspace.name,
    origin: "cfcf-auto",
    ...extra,
  };
}

// ── Try-read-file helper ──────────────────────────────────────────────────

async function readIfExists(path: string): Promise<string | null> {
  try {
    await access(path);
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

// ── Hook: reflection-analysis.md ingest ───────────────────────────────────

export async function ingestReflectionAnalysis(
  backend: MemoryBackend,
  workspace: WorkspaceConfig,
  iteration: number,
  signals: ReflectionSignals | null,
): Promise<IngestResult | null> {
  const policy = await resolveIngestPolicy(workspace);
  if (policy === "off") return null;
  // Always ingest under summaries-only + all (semantic artifact).

  const path = join(workspace.repoPath, "cfcf-docs", "reflection-analysis.md");
  const content = await readIfExists(path);
  if (!content || !content.trim()) return null;

  try {
    return await backend.ingest({
      project: resolveClioProject(workspace),
      title: `${workspace.name}: reflection iter ${iteration}`,
      content,
      source: `cfcf-auto:reflection-analysis:iter-${iteration}`,
      metadata: baseMetadata(workspace, {
        role: "reflection",
        artifact_type: "reflection-analysis",
        tier: "semantic",
        iteration,
        iteration_health: signals?.iteration_health ?? null,
        plan_modified: signals?.plan_modified ?? false,
        key_observation: signals?.key_observation ?? null,
      }),
    });
  } catch (err) {
    console.warn(
      `[clio] reflection ingest failed for iter ${iteration}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// ── Hook: architect-review.md ingest ──────────────────────────────────────

export async function ingestArchitectReview(
  backend: MemoryBackend,
  workspace: WorkspaceConfig,
  trigger: "loop" | "manual",
  readiness: string | undefined,
): Promise<IngestResult | null> {
  const policy = await resolveIngestPolicy(workspace);
  if (policy === "off") return null;

  const path = join(workspace.repoPath, "cfcf-docs", "architect-review.md");
  const content = await readIfExists(path);
  if (!content || !content.trim()) return null;

  try {
    return await backend.ingest({
      project: resolveClioProject(workspace),
      title: `${workspace.name}: architect review (${readiness ?? "unknown"})`,
      content,
      source: `cfcf-auto:architect-review:${trigger}`,
      metadata: baseMetadata(workspace, {
        role: "architect",
        artifact_type: "architect-review",
        tier: "semantic",
        trigger,
        readiness: readiness ?? null,
      }),
    });
  } catch (err) {
    console.warn(
      `[clio] architect-review ingest failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// ── Hook: decision-log.md (tagged semantic entries) ───────────────────────

const DECISION_LOG_HEADER_RE =
  /^##\s+(\S+)\s+\[role:\s*([^\]]+)\]\s+\[iter:\s*([^\]]+)\]\s+\[category:\s*([^\]]+)\]\s*$/gm;

const SEMANTIC_CATEGORIES = new Set(["lesson", "strategy", "resolved-question", "risk"]);

interface DecisionEntry {
  timestamp: string;
  role: string;
  iteration: string;
  category: string;
  body: string;
}

/**
 * Parse `cfcf-docs/decision-log.md` into structured entries. Returns only
 * entries matching the tagged format cf² writes.
 */
export function parseDecisionLog(raw: string): DecisionEntry[] {
  // Reset regex state for the /g flag.
  DECISION_LOG_HEADER_RE.lastIndex = 0;

  const headers: { start: number; end: number; ts: string; role: string; iter: string; cat: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = DECISION_LOG_HEADER_RE.exec(raw)) !== null) {
    headers.push({
      start: m.index,
      end: m.index + m[0].length,
      ts: m[1].trim(),
      role: m[2].trim(),
      iter: m[3].trim(),
      cat: m[4].trim(),
    });
  }

  const entries: DecisionEntry[] = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const next = i + 1 < headers.length ? headers[i + 1].start : raw.length;
    const body = raw.slice(h.end, next).trim();
    entries.push({
      timestamp: h.ts,
      role: h.role,
      iteration: h.iter,
      category: h.cat,
      body,
    });
  }

  return entries;
}

/**
 * Ingest decision-log entries that appended during the iteration. The
 * harness passes the raw file's content from BEFORE + AFTER the iteration;
 * we ingest any entries whose header block changed (simplest: ingest new
 * semantic entries only, by iteration number match).
 *
 * "Semantic" = category ∈ {lesson, strategy, resolved-question, risk}.
 *
 * In `summaries-only` mode only semantic entries are ingested. In `all`
 * mode every category is ingested.
 */
export async function ingestDecisionLogEntries(
  backend: MemoryBackend,
  workspace: WorkspaceConfig,
  iteration: number,
): Promise<number> {
  const policy = await resolveIngestPolicy(workspace);
  if (policy === "off") return 0;

  const path = join(workspace.repoPath, "cfcf-docs", "decision-log.md");
  const content = await readIfExists(path);
  if (!content) return 0;

  const iterLabel = String(iteration);
  const entries = parseDecisionLog(content).filter((e) => {
    if (e.iteration !== iterLabel) return false;
    if (policy === "all") return true;
    return SEMANTIC_CATEGORIES.has(e.category);
  });

  let count = 0;
  for (const e of entries) {
    try {
      // Build the ingested body so it stands alone: include the header in
      // the content for readability when the doc is retrieved via
      // `cfcf clio get`.
      const body = `## ${e.timestamp}  [role: ${e.role}]  [iter: ${e.iteration}]  [category: ${e.category}]\n\n${e.body}`;
      await backend.ingest({
        project: resolveClioProject(workspace),
        title: `${workspace.name}: decision-log ${e.category} (iter ${iteration}, ${e.role})`,
        content: body,
        source: `cfcf-auto:decision-log:iter-${iteration}:${e.timestamp}`,
        metadata: baseMetadata(workspace, {
          role: e.role,
          artifact_type: "decision-log-entry",
          tier: SEMANTIC_CATEGORIES.has(e.category) ? "semantic" : "episodic",
          iteration,
          category: e.category,
          timestamp: e.timestamp,
        }),
      });
      count++;
    } catch (err) {
      console.warn(
        `[clio] decision-log entry ingest failed (iter ${iteration}, ${e.category}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return count;
}

// ── Hook: end-of-iteration summary (cfcf-generated) ───────────────────────

export interface IterationSummaryInput {
  workspace: WorkspaceConfig;
  iteration: number;
  devSummary: string | null;           // pulled from iteration-log's ## Summary
  judgeSignals: JudgeSignals | null;
  reflectionSignals: ReflectionSignals | null;
}

/**
 * Build a small cfcf-generated "iteration summary" doc from the iteration
 * log's Summary section + the judge's determination/concerns + (if run)
 * reflection's key_observation. Ingested as artifact_type=iteration-summary,
 * tier=semantic. This is the single most transfer-friendly artifact per
 * iteration and runs under both summaries-only + all policies.
 *
 * Returns null when there's nothing meaningful to write (e.g. the dev
 * summary block is empty and there's no judge/reflection signal).
 */
export async function ingestIterationSummary(
  backend: MemoryBackend,
  input: IterationSummaryInput,
): Promise<IngestResult | null> {
  const policy = await resolveIngestPolicy(input.workspace);
  if (policy === "off") return null;

  const parts: string[] = [];
  parts.push(`# Iteration ${input.iteration} summary (${input.workspace.name})`);
  parts.push("");
  if (input.devSummary && input.devSummary.trim()) {
    parts.push("## Dev summary");
    parts.push(input.devSummary.trim());
    parts.push("");
  }
  if (input.judgeSignals) {
    parts.push("## Judge determination");
    parts.push(`${input.judgeSignals.determination} (quality ${input.judgeSignals.quality_score}/10)`);
    if (input.judgeSignals.key_concern) {
      parts.push(`Concern: ${input.judgeSignals.key_concern}`);
    }
    parts.push("");
  }
  if (input.reflectionSignals) {
    parts.push("## Reflection");
    parts.push(
      `Iteration health: ${input.reflectionSignals.iteration_health}${input.reflectionSignals.plan_modified ? " (plan modified)" : ""}`,
    );
    if (input.reflectionSignals.key_observation) {
      parts.push(`Observation: ${input.reflectionSignals.key_observation}`);
    }
    if (input.reflectionSignals.recommend_stop) {
      parts.push(`**Reflection recommends stopping the loop.**`);
    }
    parts.push("");
  }

  const content = parts.join("\n").trim();
  // Abort if effectively empty (just the header).
  const lineCount = content.split("\n").filter((l) => l.trim()).length;
  if (lineCount <= 1) return null;

  try {
    return await backend.ingest({
      project: resolveClioProject(input.workspace),
      title: `${input.workspace.name}: iteration ${input.iteration} summary`,
      content,
      source: `cfcf-auto:iteration-summary:iter-${input.iteration}`,
      metadata: baseMetadata(input.workspace, {
        role: "cfcf",
        artifact_type: "iteration-summary",
        tier: "semantic",
        iteration: input.iteration,
        judge_determination: input.judgeSignals?.determination ?? null,
        judge_quality: input.judgeSignals?.quality_score ?? null,
        iteration_health: input.reflectionSignals?.iteration_health ?? null,
      }),
    });
  } catch (err) {
    console.warn(
      `[clio] iteration-summary ingest failed for iter ${input.iteration}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// ── Hook: iteration-log + iteration-handoff + judge-assessment (policy="all" only) ──

export async function ingestRawIterationArtifacts(
  backend: MemoryBackend,
  workspace: WorkspaceConfig,
  iteration: number,
): Promise<number> {
  const policy = await resolveIngestPolicy(workspace);
  if (policy !== "all") return 0;

  const targets = [
    {
      path: join(workspace.repoPath, "cfcf-docs", "iteration-logs", `iteration-${iteration}.md`),
      title: `${workspace.name}: iteration-log iter ${iteration}`,
      source: `cfcf-auto:iteration-log:iter-${iteration}`,
      metadata: { role: "dev", artifact_type: "iteration-log", tier: "episodic", iteration },
    },
    {
      path: join(workspace.repoPath, "cfcf-docs", "iteration-handoffs", `iteration-${iteration}.md`),
      title: `${workspace.name}: iteration-handoff iter ${iteration}`,
      source: `cfcf-auto:iteration-handoff:iter-${iteration}`,
      metadata: { role: "dev", artifact_type: "iteration-handoff", tier: "episodic", iteration },
    },
    {
      path: join(workspace.repoPath, "cfcf-docs", "iteration-reviews", `iteration-${iteration}.md`),
      title: `${workspace.name}: judge-assessment iter ${iteration}`,
      source: `cfcf-auto:judge-assessment:iter-${iteration}`,
      metadata: { role: "judge", artifact_type: "judge-assessment", tier: "episodic", iteration },
    },
  ];

  let count = 0;
  for (const t of targets) {
    const content = await readIfExists(t.path);
    if (!content || !content.trim()) continue;
    try {
      await backend.ingest({
        project: resolveClioProject(workspace),
        title: t.title,
        content,
        source: t.source,
        metadata: baseMetadata(workspace, t.metadata),
      });
      count++;
    } catch (err) {
      console.warn(
        `[clio] raw artifact ingest failed (${t.source}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return count;
}

// ── Context preload: cfcf-docs/clio-relevant.md ───────────────────────────

/**
 * Generate the per-iteration `cfcf-docs/clio-relevant.md` preload file.
 *
 * Two queries (per design doc §5.3):
 * 1. Broad: top-k semantic hits for the Problem Pack's problem.md across
 *    all Clio Projects. PR1 uses FTS over problem.md tokens.
 * 2. Narrow: top-k hits filtered by artifact_type in
 *    {reflection-analysis, architect-review} scoped to the current
 *    workspace's Clio Project (when one is set).
 *
 * Called from the iteration-loop's prepare phase, right after
 * writeContextToRepo, so the new clio-relevant.md sits alongside the
 * other Tier-2 reads.
 */
export async function writeClioRelevant(
  backend: MemoryBackend,
  workspace: WorkspaceConfig,
  problemMd: string,
): Promise<{ path: string; hits: number }> {
  const { writeFile } = await import("fs/promises");
  const outPath = join(workspace.repoPath, "cfcf-docs", "clio-relevant.md");

  // Build a single compact query from the first chunk of problem.md. FTS5
  // can handle ~200 tokens fine; trim noise.
  const querySrc = problemMd
    .replace(/[\r\n]+/g, " ")
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 40)
    .join(" ");

  const lines: string[] = [];
  lines.push(`# Clio -- relevant cross-workspace context`);
  lines.push("");
  lines.push(`*Auto-generated by cfcf each iteration. Top-k hits from Clio matched`);
  lines.push(`against this workspace's problem definition. Read for cross-workspace`);
  lines.push(`lessons that might inform this iteration.*`);
  lines.push("");

  let totalHits = 0;
  if (querySrc) {
    // Broad cross-Project search
    try {
      const broad = await backend.search({ query: querySrc, matchCount: 5 });
      if (broad.hits.length > 0) {
        lines.push("## Broad matches (all Clio Projects)");
        lines.push("");
        broad.hits.forEach((h, i) => {
          lines.push(`### ${i + 1}. ${h.docTitle}  _(${h.docProjectName})_`);
          lines.push(`*${h.headingPath.length ? h.headingPath.join(" > ") : "preamble"} · chunk ${h.chunkIndex} · score ${h.score.toFixed(3)}*`);
          lines.push("");
          lines.push(h.content.split("\n").slice(0, 12).join("\n"));
          lines.push("");
        });
        totalHits += broad.hits.length;
      }
    } catch (err) {
      lines.push(`<!-- broad search failed: ${err instanceof Error ? err.message : String(err)} -->`);
    }

    // Narrow: same-Project reflection + architect-review only (when scoped).
    if (workspace.clioProject) {
      for (const type of ["reflection-analysis", "architect-review"] as const) {
        try {
          const narrow = await backend.search({
            query: querySrc,
            project: workspace.clioProject,
            matchCount: 3,
            metadata: { artifact_type: type },
          });
          if (narrow.hits.length > 0) {
            lines.push(`## ${type} -- same Clio Project (${workspace.clioProject})`);
            lines.push("");
            narrow.hits.forEach((h, i) => {
              lines.push(`### ${i + 1}. ${h.docTitle}`);
              lines.push(`*chunk ${h.chunkIndex} · score ${h.score.toFixed(3)}*`);
              lines.push("");
              lines.push(h.content.split("\n").slice(0, 8).join("\n"));
              lines.push("");
            });
            totalHits += narrow.hits.length;
          }
        } catch (err) {
          lines.push(`<!-- narrow ${type} search failed: ${err instanceof Error ? err.message : String(err)} -->`);
        }
      }
    }
  }

  if (totalHits === 0) {
    lines.push("*No relevant cross-workspace context yet. This file populates as sibling workspaces accumulate reflection analyses, architect reviews, and semantic decision-log entries.*");
  }

  await writeFile(outPath, lines.join("\n") + "\n", "utf-8");
  return { path: outPath, hits: totalHits };
}
