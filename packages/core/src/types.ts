/**
 * Core type definitions for cfcf (cf²).
 *
 * These types are shared across CLI, server, and adapters.
 */

// --- Agent Adapter Interface ---

export interface AgentAvailability {
  available: boolean;
  version?: string;
  error?: string;
}

export interface AgentAdapter {
  /** Unique identifier: "claude-code", "codex", etc. */
  name: string;

  /** Human-readable display name */
  displayName: string;

  /** Check if the agent CLI is installed and authenticated */
  checkAvailability(): Promise<AgentAvailability>;

  /** Agent-specific flags for unattended execution */
  unattendedFlags(): string[];

  /** Build the command + args to run the agent non-interactively */
  buildCommand(workspacePath: string, prompt: string, model?: string): { command: string; args: string[] };

  /** The filename this agent uses for its instruction file (e.g., "CLAUDE.md") */
  instructionFilename: string;
}

// --- Configuration ---

export interface AgentConfig {
  /** Adapter name: "claude-code", "codex", etc. */
  adapter: string;
  /** Optional model override (e.g., "opus", "sonnet", "o3") */
  model?: string;
  /** Additional CLI flags */
  flags?: string[];
}

export interface CfcfGlobalConfig {
  /** Config file format version */
  version: number;
  /** Default dev agent configuration */
  devAgent: AgentConfig;
  /** Default judge agent configuration */
  judgeAgent: AgentConfig;
  /** Default solution architect agent configuration */
  architectAgent: AgentConfig;
  /** Default documenter agent configuration */
  documenterAgent: AgentConfig;
  /**
   * Default reflection agent configuration (item 5.6 Tier 3 Strategic
   * Reflection role). The reflection role reviews the full run history
   * and may rewrite pending plan items. We recommend the strongest
   * available model. Backfilled to match devAgent when missing.
   */
  reflectionAgent?: AgentConfig;
  /**
   * Ceiling on the number of consecutive iterations the judge may skip
   * reflection via `reflection_needed: false`. On the (N+1)th consecutive
   * skip, cfcf forces reflection regardless. Default 3. (item 5.6 U1)
   */
  reflectSafeguardAfter?: number;
  /** Default max iterations */
  maxIterations: number;
  /** Default pause cadence (0 = no pauses) */
  pauseEvery: number;
  /** Detected available agents (populated during first-run) */
  availableAgents: string[];
  /** Whether the user acknowledged the permission flags */
  permissionsAcknowledged: boolean;
  /** Notification configuration (optional; defaults applied if missing) */
  notifications?: NotificationConfig;
  /**
   * Default for new workspaces' `cleanupMergedBranches`. When true, merged
   * iteration branches are deleted after a successful auto-merge. Default
   * false (keep for audit). (item 5.2)
   */
  cleanupMergedBranches?: boolean;
  /**
   * When true, the iteration loop runs the Solution Architect as a
   * pre-loop phase before entering iteration 1. The standalone Review
   * button is hidden from the web UI; Review becomes part of Start Loop.
   * Default `false` -- Review remains an optional user-invoked step.
   * (item 5.1)
   */
  autoReviewSpecs?: boolean;
  /**
   * When true, the iteration loop automatically runs the Documenter on
   * SUCCESS before entering its terminal state. Default `true` (current
   * behavior). When `false`, the loop skips the documenting phase and
   * the user may run `cfcf document` manually. (item 5.1)
   */
  autoDocumenter?: boolean;
  /**
   * Controls the pre-loop readiness check when `autoReviewSpecs` is true.
   * Mirrors `onStalled`'s three-level shape. (item 5.1)
   *   - "never":                        review always informational; loop proceeds regardless
   *   - "blocked" (default):            stop only on BLOCKED; proceed on NEEDS_REFINEMENT with warning
   *   - "needs_refinement_or_blocked":  stop on anything but READY
   */
  readinessGate?: "never" | "blocked" | "needs_refinement_or_blocked";
  /**
   * Global Clio defaults (item 5.7). Each workspace inherits these unless
   * it has its own `clio` override on `WorkspaceConfig`. See
   * `docs/design/clio-memory-layer.md` §5.2.
   */
  clio?: ClioGlobalConfig;
}

export interface ClioGlobalConfig {
  /** Default ingest policy applied to new workspaces. Defaults to "summaries-only". */
  ingestPolicy?: "summaries-only" | "all" | "off";
  /**
   * Embedder the user chose during `cfcf init` (or most recent
   * `cfcf clio embedder install <name>`). Used as the default when the
   * user runs `cfcf clio embedder install` with no arg -- lets the
   * "re-run after init failed" path work without re-specifying the
   * name. Cleared if the user opts to stay in FTS-only mode.
   */
  preferredEmbedder?: string;
  /**
   * Default search mode used by `cfcf clio search` (and by anyone
   * hitting `/api/clio/search` without an explicit `mode` query param).
   * Defaults to `"auto"`, which resolves at search time:
   *   - active embedder present → "hybrid" (RRF over FTS + vector)
   *   - no active embedder       → "fts"
   * Set to a concrete value (`fts`, `semantic`, `hybrid`) to force that
   * mode regardless of embedder state. Per-call `mode` (CLI flag /
   * query param) still wins when set.
   */
  defaultSearchMode?: "auto" | "fts" | "semantic" | "hybrid";
  /**
   * Minimum cosine similarity (raw, 0.0–1.0) for the vector-only branch
   * of hybrid search and for every result of semantic search. Ported
   * from Cerefox's `CEREFOX_MIN_SEARCH_SCORE`. Defaults to 0.5 when
   * unset. FTS-matched chunks bypass this filter in hybrid mode (the
   * threshold only filters vector-only candidates). Per-call values
   * win over this config. See `docs/decisions-log.md` 2026-04-25
   * "Hybrid search threshold" for rationale + calibration notes.
   */
  minSearchScore?: number;
  /**
   * Hybrid-search blend weight (0.0–1.0). Mirrors Cerefox's `p_alpha`
   * RPC parameter. The fused score is:
   *   score = α × normalised_vec_score + (1 − α) × normalised_fts_score
   * Higher α biases toward semantic similarity; lower α biases toward
   * keyword (FTS) match. Defaults to 0.7 (Cerefox parity). Per-call
   * value (`?alpha=` query param / `--alpha` CLI flag) wins over this
   * config. See `docs/decisions-log.md` 2026-04-27 "Hybrid algorithm:
   * RRF → alpha-weighted score blending" for the BM25 renormalisation
   * + algorithm rationale.
   */
  hybridAlpha?: number;
  /**
   * Per-document chunker target maximum chars. Mirrors Cerefox's
   * `CEREFOX_MAX_CHUNK_CHARS`. Defaults to 4000. Per-embedder
   * `recommendedChunkMaxChars` (from the catalogue) overrides this
   * when an embedder is active -- the embedder's context window
   * generally produces better retrieval quality than a hand-tuned
   * global default. Set this to bias new ingests toward smaller /
   * larger chunks regardless of embedder.
   */
  maxChunkChars?: number;
  /**
   * Minimum chunk size in chars. Pieces smaller than this are merged
   * into the previous chunk during oversized-section splitting.
   * Mirrors Cerefox's `CEREFOX_MIN_CHUNK_CHARS`. Defaults to 100.
   */
  minChunkChars?: number;
  /**
   * Document-size threshold (chars) for the search "small-to-big"
   * decision. Documents whose live content is at most this size get
   * the FULL doc returned in `bestChunkContent` of every search hit;
   * larger docs get the matched chunk + `contextWindow` neighbours on
   * each side. Mirrors Cerefox's `p_small_to_big_threshold`. Default
   * 20000. Set to 0 to disable the small-doc-full-content path
   * (always return chunk + neighbours).
   */
  smallDocThreshold?: number;
  /**
   * Context window for large-doc search hits: how many sibling chunks
   * to include on each side of the matched chunk. Mirrors Cerefox's
   * `p_context_window`. Default 1 (3-chunk window: prev + match +
   * next). Set to 0 to return only the matched chunk.
   */
  contextWindow?: number;
}

export type ReadinessGate = NonNullable<CfcfGlobalConfig["readinessGate"]>;

// --- Notifications ---

/** The kinds of events cfcf can emit */
export type NotificationEventType =
  | "loop.paused"
  | "loop.completed"
  | "agent.failed";

/** The channels available for notification delivery */
export type NotificationChannelName =
  | "terminal-bell"
  | "macos"
  | "linux"
  | "log";

export interface NotificationConfig {
  /** Master switch. When false, all notifications are suppressed */
  enabled: boolean;
  /** Per-event channel mappings. Key = event type, value = list of channels to fire */
  events: Partial<Record<NotificationEventType, NotificationChannelName[]>>;
}

/** Payload passed to channel dispatchers */
export interface NotificationEvent {
  /** Event kind */
  type: NotificationEventType;
  /** Short title (used in OS notification heading) */
  title: string;
  /** Longer body (used in OS notification body / log entry) */
  message: string;
  /** Workspace context */
  workspace: {
    id: string;
    name: string;
  };
  /** ISO timestamp when the event fired */
  timestamp: string;
  /** Event-specific details (e.g., iteration number, reason, determination) */
  details?: Record<string, unknown>;
}

export type WorkspaceStatus = "idle" | "running" | "paused" | "completed" | "failed" | "stopped";

export interface WorkspaceConfig {
  id: string;
  name: string;
  repoPath: string;
  devAgent: AgentConfig;
  judgeAgent: AgentConfig;
  architectAgent: AgentConfig;
  documenterAgent: AgentConfig;
  /** Reflection agent (item 5.6). Optional override -- defaults to the
   * global config's reflectionAgent, or devAgent if that is also unset. */
  reflectionAgent?: AgentConfig;
  /** Per-workspace override for the global reflectSafeguardAfter ceiling. */
  reflectSafeguardAfter?: number;
  maxIterations: number;
  pauseEvery: number;
  onStalled: "continue" | "stop" | "alert";
  mergeStrategy: "auto" | "pr";
  /**
   * When true, delete the `cfcf/iteration-N` branch after a successful
   * auto-merge to main. Default false: keeps branches so iteration diffs
   * remain accessible via `git diff main..cfcf/iteration-N` even after
   * merge. Enable this for long-running workspaces that would otherwise
   * accumulate many merged branches. (item 5.2)
   */
  cleanupMergedBranches?: boolean;
  /** Per-workspace override for the global `autoReviewSpecs` default. (item 5.1) */
  autoReviewSpecs?: boolean;
  /** Per-workspace override for the global `autoDocumenter` default. (item 5.1) */
  autoDocumenter?: boolean;
  /** Per-workspace override for the global `readinessGate` default. (item 5.1) */
  readinessGate?: ReadinessGate;
  processTemplate: string;
  /** Monotonically increasing iteration counter for this workspace */
  currentIteration: number;
  /** Current workspace status in the iteration loop */
  status?: WorkspaceStatus;
  /** Per-workspace notification override (defaults to global config) */
  notifications?: NotificationConfig;
  /**
   * Clio Project assignment (item 5.7). Name of the Clio Project this
   * workspace contributes memories to. Undefined → auto-route to the
   * named `"default"` Project on first ingest (user confirms the first
   * time). See `docs/design/clio-memory-layer.md` §2 for the
   * workspace-vs-Project distinction.
   */
  clioProject?: string;
  /**
   * Per-workspace Clio configuration override (item 5.7). When unset the
   * workspace inherits the global `CfcfGlobalConfig.clio` defaults.
   */
  clio?: ClioWorkspaceConfig;
}

export interface ClioWorkspaceConfig {
  /**
   * Controls which artifacts cf² auto-ingests at iteration boundaries.
   * See `docs/design/clio-memory-layer.md` §5.2.
   *   - "summaries-only" (default): curated signal -- reflection-analysis,
   *     architect-review, tagged decision-log entries, cfcf-generated
   *     iteration-summary. Good for cross-workspace transfer.
   *   - "all": above + every iteration-log, every iteration-handoff, every
   *     judge-assessment, every decision-log append. High-signal
   *     workspaces / dogfooding.
   *   - "off": no cfcf-auto ingest. User + agents can still push via
   *     `cfcf clio docs ingest` / `POST /api/clio/ingest` on demand.
   */
  ingestPolicy?: "summaries-only" | "all" | "off";
}

// --- Server Communication ---

export interface ServerStatus {
  status: "running" | "stopped";
  version: string;
  uptime?: number;
  pid?: number;
  port: number;
}

// --- Iteration Types ---

export interface DevSignals {
  iteration: number;
  agent: string;
  status: "completed" | "partial" | "blocked";
  user_input_needed: boolean;
  questions?: string[];
  tests_run: boolean;
  tests_passed?: number;
  tests_failed?: number;
  tests_total?: number;
  self_assessment: "high" | "medium" | "low";
  blockers?: string[];
}

export interface JudgeSignals {
  iteration: number;
  determination: "SUCCESS" | "PROGRESS" | "STALLED" | "ANOMALY";
  anomaly_type?:
    | "token_exhaustion"
    | "user_input_needed"
    | "circling"
    | "no_changes"
    | "regression";
  quality_score: number;
  tests_verified: boolean;
  tests_passed?: number;
  tests_failed?: number;
  tests_total?: number;
  should_continue: boolean;
  user_input_needed: boolean;
  key_concern?: string;
  /**
   * Judge opt-out for the reflection role (item 5.6 §2.3). When true or
   * missing, reflection runs. When `false`, the judge affirmatively claims
   * that (a) the iteration made clean on-plan progress, (b) no new risks
   * emerged, (c) no drift-across-iterations pattern. The harness still
   * forces reflection after `reflectSafeguardAfter` consecutive skips.
   */
  reflection_needed?: boolean;
  /**
   * Optional prompt / focus hint for the reflection agent when
   * `reflection_needed: true`.
   */
  reflection_reason?: string;
}

export type IterationHealth =
  | "converging"
  | "stable"
  | "stalled"
  | "diverging"
  | "inconclusive";

export interface ReflectionSignals {
  iteration: number;
  /** Did the reflection agent rewrite any pending plan items? */
  plan_modified: boolean;
  /** One-line categorical assessment of the overall trajectory. */
  iteration_health: IterationHealth;
  /** One-line summary captured into the iteration log / UI history. */
  key_observation: string;
  /**
   * When true, reflection believes the loop is fundamentally stuck and the
   * user should intervene. Never auto-stops -- always pauses + notifies.
   */
  recommend_stop?: boolean;
}

export interface ArchitectSignals {
  readiness: "READY" | "NEEDS_REFINEMENT" | "BLOCKED";
  gaps: string[];
  suggestions: string[];
  risks: string[];
  recommended_approach?: string;
}

export interface IterationRecord {
  number: number;
  status: "preparing" | "dev_executing" | "judging" | "completed";
  startedAt: string;
  completedAt?: string;
  devExitCode?: number;
  judgeExitCode?: number;
  signals?: DevSignals;
  judgeSignals?: JudgeSignals;
  summary?: string;
}

// --- SSE Events ---

export type CfcfEvent =
  | { type: "iteration.started"; iteration: number }
  | { type: "iteration.log"; line: string; source: "dev" | "judge" }
  | { type: "iteration.dev_completed"; iteration: number; exitCode: number }
  | {
      type: "iteration.judge_completed";
      iteration: number;
      determination: string;
    }
  | {
      type: "workspace.paused";
      reason: "cadence" | "anomaly" | "user_input_needed";
      questions?: string[];
    }
  | { type: "workspace.completed"; status: "success" | "failure" | "stopped" }
  | { type: "alert"; message: string };
