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
import { effectiveClioProject } from "./system-projects.js";
import { formatClioActor } from "./actor.js";

/**
 * Resolve the canonical Clio actor stamp for a role-tagged auto-ingest
 * (item 6.18 round-3). Maps the role name to the workspace's per-role
 * AgentConfig and formats `<role>|<adapter>|<model>`. For roles
 * without a per-workspace agent config (e.g. "cfcf" itself for
 * iteration-summary writes, or arbitrary decision-log roles), falls
 * back to `<role>|cfcf|system` so the audit-log still distinguishes
 * cfcf-system writes from agent writes.
 */
function actorForRole(workspace: WorkspaceConfig, role: string): string {
  switch (role) {
    case "dev":         return formatClioActor(role, workspace.devAgent.adapter,        workspace.devAgent.model);
    case "judge":       return formatClioActor(role, workspace.judgeAgent.adapter,      workspace.judgeAgent.model);
    case "architect":   return formatClioActor(role, workspace.architectAgent.adapter,  workspace.architectAgent.model);
    case "documenter":  return formatClioActor(role, workspace.documenterAgent.adapter, workspace.documenterAgent.model);
    case "reflection":
      if (workspace.reflectionAgent) return formatClioActor(role, workspace.reflectionAgent.adapter, workspace.reflectionAgent.model);
      return formatClioActor(role, workspace.architectAgent.adapter, workspace.architectAgent.model); // backfill match
    default: return `${role}|cfcf|system`;
  }
}

export type IngestPolicy = "off" | "summaries-only" | "all";

/**
 * Resolve the effective ingest policy for a workspace. Priority:
 *   workspace.clio.ingestPolicy -> global.clio.ingestPolicy -> "all"
 *
 * Default flipped from "summaries-only" to "all" 2026-05-09 (item 6.9).
 * Disk is cheap (~20-50 KB per iteration); cross-iteration full-history
 * search is high-value, especially for the multi-loop-over-time use
 * case where users come back to the same workspace months later.
 * Existing workspaces auto-pick-up the new default since none have an
 * explicit override.
 */
export async function resolveIngestPolicy(workspace: WorkspaceConfig): Promise<IngestPolicy> {
  if (workspace.clio?.ingestPolicy) return workspace.clio.ingestPolicy;
  const global = await readConfig();
  if (global?.clio?.ingestPolicy) return global.clio.ingestPolicy;
  return "all";
}

/**
 * Resolve the Clio Project to ingest into.
 *
 * Item 6.9 (2026-05-09): per-workspace memory now lives in
 * `cf-workspace-<id>` by default. New workspaces get this set
 * explicitly at `createWorkspace()` time; pre-6.9 workspaces with
 * `clioProject` still unset get the SAME effective project via
 * `effectiveClioProject()`, so auto-ingest routes consistently
 * regardless of when the workspace was registered. The pre-6.9
 * fallback to `cf-system-default` (the global "everyone's stuff"
 * bucket) is gone — per-workspace artefacts no longer pollute the
 * global default project.
 */
function resolveClioProject(workspace: WorkspaceConfig): string {
  return effectiveClioProject(workspace);
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

// ── Internal-path usage logging (item 6.35 follow-up) ─────────────────────

/**
 * Auto-ingest hooks call `backend.ingest(...)` directly (not via
 * HTTP), so they bypass the `/api/clio/*` middleware that writes the
 * `clio_usage_log` row for HTTP-path activity. Without an explicit
 * call here, the Usage tab + `cfcf clio usage list` would miss
 * every cfcf-driven write — a confusing inconsistency vs the Audit
 * tab which DOES capture them (LocalClio writes audit rows
 * internally). This helper restores symmetry: after every
 * auto-ingest, log the same operation to the usage log with
 * `accessPath: "internal"` so the row is distinguishable from the
 * three HTTP-path values (`cli` / `agent-cli` / `web`).
 *
 * Best-effort: logging failures never break the auto-ingest flow.
 * The backend's `logUsage()` already swallows errors internally,
 * but we double-wrap defensively in case future implementations
 * tighten that.
 */
function recordInternalUsage(
  backend: MemoryBackend,
  args: {
    operation:
      | "ingest"
      | "edit-document"
      | "delete"
      | "restore"
      | "purge"
      | "create-project";
    requestor: string;
    documentId?: string | null;
    projectId?: string | null;
    extra?: Record<string, unknown>;
  },
): void {
  try {
    backend.logUsage({
      operation: args.operation,
      accessPath: "internal",
      requestor: args.requestor,
      documentId: args.documentId ?? null,
      projectId: args.projectId ?? null,
      queryText: null,
      resultCount: null,
      extra: args.extra ?? null,
    });
  } catch { /* best-effort */ }
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
    const result = await backend.ingest({
      project: resolveClioProject(workspace),
      title: `${workspace.name}: reflection iter ${iteration}`,
      content,
      author: actorForRole(workspace, "reflection"),
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
    recordInternalUsage(backend, {
      operation: "ingest",
      requestor: actorForRole(workspace, "reflection"),
      documentId: result.document?.id,
      projectId: result.document?.projectId,
      extra: { artifact_type: "reflection-analysis", iteration, action: result.action },
    });
    return result;
  } catch (err) {
    console.warn(
      `[clio] reflection ingest failed for iter ${iteration}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// ── Hook: architect-review.md ingest ──────────────────────────────────────

/**
 * Mirror `cfcf-docs/architect-review.md` to Clio.
 *
 * Pre-v0.24: every architect run created a NEW Clio document (title
 * varied by readiness — "architect review (READY)" vs "(NEEDS_REFINEMENT)" —
 * and source varied by trigger). A re-review-heavy workspace accumulated
 * dozens of architect-review docs in Clio for what's a single living
 * artifact on disk (`cfcf-docs/architect-review.md` is rewritten each
 * time, not appended).
 *
 * v0.24: single growing doc with `updateIfExists: true`. Title +
 * source are stable across runs; readiness + trigger move to
 * doc-level metadata (still searchable, still auditable, but the doc
 * count stays at 1 per workspace). Version snapshots in
 * `clio_document_versions` capture the audit trail.
 */
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
    const result = await backend.ingest({
      project: resolveClioProject(workspace),
      title: `${workspace.name}: architect-review`,
      content,
      author: actorForRole(workspace, "architect"),
      source: `cfcf-auto:architect-review`,
      updateIfExists: true,
      metadata: baseMetadata(workspace, {
        role: "architect",
        artifact_type: "architect-review",
        tier: "semantic",
        last_trigger: trigger,
        readiness: readiness ?? null,
        last_updated_at: new Date().toISOString(),
      }),
    });
    recordInternalUsage(backend, {
      operation: "ingest",
      requestor: actorForRole(workspace, "architect"),
      documentId: result.document?.id,
      projectId: result.document?.projectId,
      extra: { artifact_type: "architect-review", trigger, readiness, action: result.action },
    });
    return result;
  } catch (err) {
    console.warn(
      `[clio] architect-review ingest failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// ── Hook: plan.md (the implementation plan; living doc) ──────────────────

/**
 * Mirror `cfcf-docs/plan.md` to Clio. Item 6.35 follow-up after
 * dogfood: SA creates plan.md but the harness wasn't auto-ingesting
 * it — only architect-review.md (the readiness assessment) was
 * mirrored. Plan.md is high-value living content (SA authors it,
 * reflection optionally rewrites pending items, dev marks `[x]`
 * each iteration). Cross-workspace search benefits: "show me
 * implementation plans for similar problems".
 *
 * One Clio doc per workspace, mutable, accumulating edits via
 * `--update-if-exists` (lookup by title within the project) +
 * sha256 dedup (unchanged file = no-op).
 *
 * Trigger points (mirrors `ingestProblemPack`):
 *   - `workspace-init`: catches a pre-fab plan.md the user already
 *     authored before registering the workspace
 *   - `iteration-start`: catches dev's `[x]` marks from the prior
 *     iteration + any out-of-band user edits
 *   - `post-architect`: SA just wrote/refined the plan
 *   - `post-reflection`: reflection may have rewritten pending items
 *
 * `actorOverride` carries the WRITER stamp for accurate audit-log
 * attribution (`architect|<adapter>|<model>` after SA, etc.); the
 * default `cfcf|system` covers cfcf-driven triggers.
 */
export async function ingestPlanMd(
  backend: MemoryBackend,
  workspace: WorkspaceConfig,
  trigger:
    | "workspace-init"
    | "iteration-start"
    | "post-architect"
    | "post-reflection"
    | "manual",
  actorOverride?: string,
): Promise<IngestResult | null> {
  const policy = await resolveIngestPolicy(workspace);
  if (policy === "off") return null;

  const path = join(workspace.repoPath, "cfcf-docs", "plan.md");
  const content = await readIfExists(path);
  if (!content || !content.trim()) return null;

  const project = resolveClioProject(workspace);
  const author = actorOverride ?? actorForRole(workspace, "architect");

  try {
    const result = await backend.ingest({
      project,
      title: `${workspace.name}: plan.md`,
      content,
      author,
      source: `cfcf-auto:plan-md:${trigger}`,
      // Singleton-per-workspace doc — `--update-if-exists` looks up
      // by title within the project and updates in place. sha256
      // dedup makes unchanged content a no-op.
      updateIfExists: true,
      metadata: baseMetadata(workspace, {
        // `architect` is the canonical author (SA creates it); reflection
        // and dev modify but the role stamp tracks ownership semantically.
        // The actual writer of the current revision is in `author`.
        role: "architect",
        artifact_type: "plan",
        tier: "semantic",
        ingest_trigger: trigger,
      }),
    });
    recordInternalUsage(backend, {
      operation: "ingest",
      requestor: author,
      documentId: result.document?.id,
      projectId: result.document?.projectId,
      extra: { artifact_type: "plan", ingest_trigger: trigger, action: result.action },
    });
    return result;
  } catch (err) {
    console.warn(
      `[clio] plan.md ingest failed (${trigger}): ${err instanceof Error ? err.message : String(err)}`,
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
 * Mirror `cfcf-docs/decision-log.md` to Clio.
 *
 * Pre-v0.24: each entry in the file was ingested as a SEPARATE Clio
 * document (title varied by category + iter + role; source varied
 * by entry timestamp). A 5-iteration loop produced 7+ separate
 * decision-log docs in Clio — fragmenting what's one growing file
 * on disk. Search noise: "what decisions has this project made?"
 * returned N hits to read in order. Lost narrative continuity (each
 * entry was authored aware of prior ones; the collective is the
 * value). Did not mirror the on-disk source.
 *
 * v0.24: single growing doc with `updateIfExists: true`. Per-entry
 * metadata (role, iter, category, timestamp) lives INSIDE the
 * content via the existing `## <ts>  [role: …]  [iter: N]  [category: …]`
 * markdown header that cf² writes in the file — chunker + FTS
 * preserve those for search. Doc-level metadata captures aggregate
 * info: entry_count, categories present, last_iter_updated.
 *
 * Policy still honoured: in `summaries-only` we ingest only the
 * semantic entries (lesson / strategy / resolved-question / risk).
 * In `all` we ingest the full file as-is.
 *
 * Returns 1 when a doc was created/updated, 0 when no-op.
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

  const allEntries = parseDecisionLog(content);
  if (allEntries.length === 0) return 0;

  // In summaries-only mode, build a filtered file containing only
  // semantic entries. In `all`, ingest the original file content
  // unchanged so search hits reflect what's on disk.
  let body: string;
  let entries: DecisionEntry[];
  if (policy === "summaries-only") {
    entries = allEntries.filter((e) => SEMANTIC_CATEGORIES.has(e.category));
    if (entries.length === 0) return 0;
    body = renderDecisionLog(entries);
  } else {
    entries = allEntries;
    body = content;
  }

  const categories = Array.from(new Set(entries.map((e) => e.category))).sort();
  const author = actorForRole(workspace, "cfcf");

  try {
    const result = await backend.ingest({
      project: resolveClioProject(workspace),
      title: `${workspace.name}: decision-log`,
      content: body,
      author,
      source: `cfcf-auto:decision-log`,
      updateIfExists: true,
      metadata: baseMetadata(workspace, {
        artifact_type: "decision-log",
        tier: "semantic",
        last_iter_updated: iteration,
        entry_count: entries.length,
        categories,
        last_updated_at: new Date().toISOString(),
      }),
    });
    recordInternalUsage(backend, {
      operation: "ingest",
      requestor: author,
      documentId: result.document?.id,
      projectId: result.document?.projectId,
      extra: {
        artifact_type: "decision-log",
        last_iter_updated: iteration,
        entry_count: entries.length,
        action: result.action,
      },
    });
    return 1;
  } catch (err) {
    console.warn(
      `[clio] decision-log ingest failed (iter ${iteration}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}

/**
 * Reconstruct a markdown decision-log file from parsed entries.
 * Used by `ingestDecisionLogEntries` in `summaries-only` mode to
 * build a filtered version containing only semantic entries.
 */
function renderDecisionLog(entries: DecisionEntry[]): string {
  return entries
    .map(
      (e) =>
        `## ${e.timestamp}  [role: ${e.role}]  [iter: ${e.iteration}]  [category: ${e.category}]\n\n${e.body}`,
    )
    .join("\n\n");
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
    const itrResult = await backend.ingest({
      project: resolveClioProject(input.workspace),
      title: `${input.workspace.name}: iteration ${input.iteration} summary`,
      content,
      author: actorForRole(input.workspace, "cfcf"), // → cfcf|system
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
    recordInternalUsage(backend, {
      operation: "ingest",
      requestor: actorForRole(input.workspace, "cfcf"),
      documentId: itrResult.document?.id,
      projectId: itrResult.document?.projectId,
      extra: { artifact_type: "iteration-summary", iteration: input.iteration, action: itrResult.action },
    });
    return itrResult;
  } catch (err) {
    console.warn(
      `[clio] iteration-summary ingest failed for iter ${input.iteration}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// ── Hook: problem-pack files (item 6.9 follow-up) ─────────────────────────

/**
 * The five canonical problem-pack files cfcf auto-ingests into Clio.
 * Order is stable for deterministic iteration in tests + logs.
 *
 * cfcf treats these as **read-only by convention** for agents (PA edits
 * them; the loop roles cite them); ingesting them gives sibling
 * workspaces in a shared Clio Project + future iterations of THIS
 * workspace cross-cutting visibility.
 */
export const PROBLEM_PACK_FILES = [
  "problem.md",
  "success.md",
  "constraints.md",
  "hints.md",
  "style-guide.md",
] as const;

export type ProblemPackFilename = (typeof PROBLEM_PACK_FILES)[number];

export interface ProblemPackIngestResult {
  /** Number of files newly created OR materially updated (action !== "skipped"). */
  ingested: number;
  /** Number of files where the on-disk content matched the live Clio doc (sha256-deduped). */
  skipped: number;
  /** Number of files that didn't exist on disk (or were empty). */
  missing: number;
  /** Per-file detail for logging / tests. */
  perFile: Array<{
    filename: ProblemPackFilename;
    action: "created" | "updated" | "skipped" | "missing" | "failed";
    documentId?: string;
    error?: string;
  }>;
}

/**
 * Ingest the workspace's problem-pack files into Clio. ONE Clio doc
 * per file, identified by `(role: "user", artifact_type: "problem-pack",
 * filename: <one-of-the-five>, workspace_id)` metadata + matching
 * title `<workspace-name>: problem-pack <filename>`.
 *
 * Runs at three trigger points:
 *   - `workspace-init`: server's POST `/api/workspaces` after the
 *     workspace gets created (catches Problem Packs that already
 *     existed in the repo when the user registered).
 *   - `iteration-start`: iteration loop's pre-dev hook (each iteration
 *     re-checks; sha256 dedup means unchanged files are no-ops).
 *   - `pa-session-end`: PA launcher's fallback (PA's primary job is
 *     editing these files, so re-ingesting at session end captures
 *     the freshest version).
 *
 * Idempotent: `--update-if-exists` looks up the doc by title within
 * the workspace's effective Clio Project. The backend's sha256 dedup
 * skips ingest when the file's content hash matches the live version's
 * hash, so cost-per-call is a single SQL lookup for unchanged files.
 *
 * Subject to the same `clio.ingestPolicy` gate as other auto-ingests:
 * `"off"` skips everything; `"summaries-only"` and `"all"` both
 * include problem-pack (these files ARE the workspace's "summary"
 * of intent, so no value in scoping them tighter).
 *
 * Best-effort: any single-file failure is logged + the loop continues
 * to the next file. Returns a summary the caller can surface.
 */
export async function ingestProblemPack(
  backend: MemoryBackend,
  workspace: WorkspaceConfig,
  trigger: "workspace-init" | "iteration-start" | "pa-session-end" | "pa-boot-reconcile" | "manual",
  actorOverride?: string,
): Promise<ProblemPackIngestResult> {
  const result: ProblemPackIngestResult = {
    ingested: 0,
    skipped: 0,
    missing: 0,
    perFile: [],
  };

  const policy = await resolveIngestPolicy(workspace);
  if (policy === "off") return result;

  const project = resolveClioProject(workspace);
  // Two-layer attribution:
  //   - `role: "user"` (set in metadata below) — STAKEHOLDER of the
  //     spec content. Problem-pack files describe what the user wants
  //     built; that's the semantic owner regardless of keystroke author.
  //   - `author` — actual WRITER. Default `user|cfcf|system` for
  //     workspace-init / iteration-start (cfcf-driven, no role agent
  //     specifically triggered). PA fallback / boot-reconcile pass an
  //     override like `product-architect|<adapter>|<model>` so the
  //     audit log can distinguish PA-driven edits from user-only ones.
  const author = actorOverride ?? actorForRole(workspace, "user");

  for (const filename of PROBLEM_PACK_FILES) {
    const path = join(workspace.repoPath, "cfcf-docs", filename);
    const content = await readIfExists(path);
    if (!content || !content.trim()) {
      result.missing++;
      result.perFile.push({ filename, action: "missing" });
      continue;
    }

    try {
      const ingestResult = await backend.ingest({
        project,
        title: `${workspace.name}: problem-pack ${filename}`,
        content,
        author,
        source: `cfcf-auto:problem-pack:${filename}:${trigger}`,
        // Workspace-singleton doc per file — look up by title inside
        // the project + update in place when content changed. Backend
        // dedups by sha256 so unchanged content is a fast no-op.
        updateIfExists: true,
        metadata: baseMetadata(workspace, {
          role: "user",
          artifact_type: "problem-pack",
          filename,
          tier: "semantic",
          ingest_trigger: trigger,
        }),
      });
      if (ingestResult.action === "skipped") {
        result.skipped++;
        result.perFile.push({
          filename,
          action: "skipped",
          documentId: ingestResult.document?.id,
        });
      } else {
        result.ingested++;
        result.perFile.push({
          filename,
          action: ingestResult.action, // "created" | "updated"
          documentId: ingestResult.document?.id,
        });
      }
      // Internal-path usage log entry so the Usage tab sees these
      // writes (problem-pack auto-ingest fires from iteration-start
      // / pa-session-end / pa-boot-reconcile / workspace-init —
      // none of which go through the HTTP middleware).
      recordInternalUsage(backend, {
        operation: "ingest",
        requestor: author,
        documentId: ingestResult.document?.id,
        projectId: ingestResult.document?.projectId,
        extra: {
          artifact_type: "problem-pack",
          filename,
          ingest_trigger: trigger,
          action: ingestResult.action,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[clio] problem-pack ingest failed for ${filename}: ${msg}`);
      result.perFile.push({ filename, action: "failed", error: msg });
    }
  }

  return result;
}

// ── Hook: iteration-log + iteration-handoff + judge-assessment (policy="all" only) ──

interface IterationArtifactTarget {
  path: string;
  title: string;
  source: string;
  metadata: Record<string, unknown>;
}

/**
 * Ingest one iteration-artifact target via the standard
 * single-doc-per-iteration pattern. Idempotent (uses
 * `--update-if-exists`) so calling this multiple times during an
 * iteration is safe — re-runs no-op when content is unchanged + update
 * the existing doc when content has grown / been edited.
 *
 * Item 6.35 follow-up (2026-05-10): split out from the original
 * `ingestRawIterationArtifacts` batch so per-role hooks (after dev
 * commit, after judge commit) can ingest just their own artifacts
 * for real-time visibility — rather than waiting for the
 * end-of-iteration batch.
 */
async function ingestSingleIterationArtifact(
  backend: MemoryBackend,
  workspace: WorkspaceConfig,
  t: IterationArtifactTarget,
): Promise<boolean> {
  const content = await readIfExists(t.path);
  if (!content || !content.trim()) return false;
  try {
    const requestor = actorForRole(workspace, String(t.metadata.role ?? "cfcf"));
    const rawResult = await backend.ingest({
      project: resolveClioProject(workspace),
      title: t.title,
      content,
      author: requestor,
      source: t.source,
      // Idempotent: same title + same content → action="skipped" via
      // sha256 dedup. Same title + different content (file grew) →
      // updates the existing doc in place rather than creating a
      // duplicate.
      updateIfExists: true,
      metadata: baseMetadata(workspace, t.metadata),
    });
    recordInternalUsage(backend, {
      operation: "ingest",
      requestor,
      documentId: rawResult.document?.id,
      projectId: rawResult.document?.projectId,
      extra: {
        artifact_type: t.metadata.artifact_type,
        iteration: t.metadata.iteration,
        action: rawResult.action,
      },
    });
    return true;
  } catch (err) {
    console.warn(
      `[clio] iteration-artifact ingest failed (${t.source}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Ingest dev's iteration artifacts: iteration-log-N.md +
 * iteration-handoff-N.md. Called immediately after the dev commit
 * lands so the user sees activity in Clio in real time rather than
 * waiting for end-of-iteration. Item 6.35 follow-up.
 */
export async function ingestDevIterationArtifacts(
  backend: MemoryBackend,
  workspace: WorkspaceConfig,
  iteration: number,
): Promise<number> {
  const policy = await resolveIngestPolicy(workspace);
  if (policy !== "all") return 0;

  const targets: IterationArtifactTarget[] = [
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
  ];

  let count = 0;
  for (const t of targets) {
    if (await ingestSingleIterationArtifact(backend, workspace, t)) count++;
  }
  return count;
}

/**
 * Ingest judge's iteration artifact: judge-assessment-N.md (archived
 * to iteration-reviews/iteration-N.md). Called immediately after the
 * judge commit lands. Item 6.35 follow-up.
 */
export async function ingestJudgeArtifact(
  backend: MemoryBackend,
  workspace: WorkspaceConfig,
  iteration: number,
): Promise<boolean> {
  const policy = await resolveIngestPolicy(workspace);
  if (policy !== "all") return false;

  return ingestSingleIterationArtifact(backend, workspace, {
    path: join(workspace.repoPath, "cfcf-docs", "iteration-reviews", `iteration-${iteration}.md`),
    title: `${workspace.name}: judge-assessment iter ${iteration}`,
    source: `cfcf-auto:judge-assessment:iter-${iteration}`,
    metadata: { role: "judge", artifact_type: "judge-assessment", tier: "episodic", iteration },
  });
}

/**
 * Backwards-compat: end-of-iteration safety-net batch. Calls both
 * per-role helpers; each is idempotent via sha256 dedup. After the
 * 6.35 refactor (per-role hooks fire after each commit), this is
 * usually a no-op at end-of-iteration — every artifact has already
 * been ingested. Kept as a defensive catch-all in case a per-role
 * hook ever fails.
 */
export async function ingestRawIterationArtifacts(
  backend: MemoryBackend,
  workspace: WorkspaceConfig,
  iteration: number,
): Promise<number> {
  const dev = await ingestDevIterationArtifacts(backend, workspace, iteration);
  const judge = await ingestJudgeArtifact(backend, workspace, iteration);
  return dev + (judge ? 1 : 0);
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
