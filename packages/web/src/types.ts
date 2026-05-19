/**
 * API response types for the cfcf web GUI.
 * These mirror the JSON shapes returned by the server API.
 */

export interface AgentConfig {
  adapter: string;
  model?: string;
}

export type WorkspaceStatus = "idle" | "running" | "paused" | "completed" | "failed" | "stopped";

export type NotificationEventType = "loop.paused" | "loop.completed" | "agent.failed";
export type NotificationChannelName = "terminal-bell" | "macos" | "linux" | "log";

export interface NotificationConfig {
  enabled: boolean;
  events: Partial<Record<NotificationEventType, NotificationChannelName[]>>;
}

export interface WorkspaceConfig {
  id: string;
  name: string;
  repoPath: string;
  devAgent: AgentConfig;
  judgeAgent: AgentConfig;
  architectAgent: AgentConfig;
  documenterAgent: AgentConfig;
  reflectionAgent?: AgentConfig;
  helpAssistantAgent?: AgentConfig;
  reflectSafeguardAfter?: number;
  maxIterations: number;
  pauseEvery: number;
  onStalled: "continue" | "stop" | "alert";
  mergeStrategy: "auto" | "pr";
  cleanupMergedBranches?: boolean;
  /** item 5.1 */
  autoReviewSpecs?: boolean;
  /** item 5.1 */
  autoDocumenter?: boolean;
  /** item 5.1 */
  readinessGate?: "never" | "blocked" | "needs_refinement_or_blocked";
  processTemplate: string;
  currentIteration: number;
  status?: WorkspaceStatus;
  notifications?: NotificationConfig;
  /** Clio Project name this workspace ingests into (item 5.7). */
  clioProject?: string;
  /**
   * Which agent (if any) is actively running on this workspace right
   * now. Computed server-side from the per-runner state stores; sent
   * inline by the `/api/workspaces` list endpoint so the dashboard
   * card can render an "<agent> running" chip without a per-card
   * status fetch (item F.22, v0.24.0). Absent on the per-workspace
   * detail endpoint where the dedicated state objects are fetched
   * separately.
   */
  activeAgent?: "loop" | "review" | "document" | "reflect" | null;
  /**
   * Server-computed liveness of any active PA session for this
   * workspace (v0.24.5). Independent of `activeAgent` — PA can run
   * concurrently with the loop / standalone runs. Null when no PA
   * is alive. See `packages/core/src/product-architect/pa-liveness.ts`.
   */
  paSession?: {
    active: true;
    sessionId: string;
    startedAt: string;
    launcherPid: number;
    eventId: string;
  } | null;
}

// Keep in sync with packages/core/src/iteration-loop.ts
export type LoopPhase =
  | "idle"
  | "pre_loop_reviewing"
  | "preparing"
  | "dev_executing"
  | "judging"
  | "reflecting"
  | "deciding"
  | "documenting"
  | "paused"
  | "completed"
  | "failed"
  | "stopped";

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
  determination: "SUCCESS" | "PROGRESS" | "STALLED" | "ANOMALY" | "MILESTONE_SUCCESS";
  milestone_note?: string;
  anomaly_type?: string;
  quality_score: number;
  tests_verified: boolean;
  tests_passed?: number;
  tests_failed?: number;
  tests_total?: number;
  should_continue: boolean;
  user_input_needed: boolean;
  key_concern?: string;
}

export interface LoopIterationRecord {
  number: number;
  branch: string;
  devExitCode?: number;
  devSignals?: DevSignals;
  judgeExitCode?: number;
  judgeSignals?: JudgeSignals;
  judgeError?: string;
  devLogFile: string;
  judgeLogFile: string;
  startedAt: string;
  completedAt?: string;
  merged: boolean;
}

export interface LoopState {
  workspaceId: string;
  workspaceName: string;
  phase: LoopPhase;
  currentIteration: number;
  maxIterations: number;
  pauseEvery: number;
  startedAt: string;
  completedAt?: string;
  pauseReason?:
    | "cadence"
    | "anomaly"
    | "user_input_needed"
    | "max_iterations"
    | "scope_complete"  // item 6.25 follow-up: architect SCOPE_COMPLETE
    | "missing_signals";  // harness-missing-signals: dev/judge exited without writing signals file
  pendingQuestions?: string[];
  userFeedback?: string;
  iterations: LoopIterationRecord[];
  error?: string;
  outcome?: "success" | "failure" | "stopped" | "max_iterations";
  consecutiveStalled: number;
  retryJudge?: boolean;
}

export interface ReviewState {
  workspaceId: string;
  workspaceName: string;
  status: "preparing" | "executing" | "collecting" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  logFile: string;
  logFileName?: string;
  sequence?: number;
  historyEventId?: string;
  signals?: ArchitectSignals;
  error?: string;
}

export interface DocumentState {
  workspaceId: string;
  workspaceName: string;
  status: "preparing" | "executing" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  logFile: string;
  logFileName?: string;
  sequence?: number;
  historyEventId?: string;
  error?: string;
}

export interface HealthResponse {
  status: string;
  version: string;
  uptime: number;
}

// --- Workspace history ---

export type HistoryEventType =
  | "review"
  | "iteration"
  | "document"
  | "reflection"
  | "pa-session"
  | "loop-stopped";  // item 6.25 — user-initiated stop_loop_now

export type IterationHealth =
  | "converging"
  | "stable"
  | "stalled"
  | "diverging"
  | "inconclusive";

export interface ReflectionSignals {
  iteration: number;
  plan_modified: boolean;
  iteration_health: IterationHealth;
  key_observation: string;
  recommend_stop?: boolean;
  /**
   * Cross-iteration override of the judge's determination (F.31,
   * v0.24+). Set to "MILESTONE_SUCCESS" when reflection — with
   * multi-iteration context — recognises judge's SUCCESS verdict
   * was milestone-scoped. `milestone_note` must accompany.
   */
  override_determination?: "MILESTONE_SUCCESS";
  milestone_note?: string;
}

export interface DevSignalsWeb {
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

export interface JudgeSignalsWeb {
  iteration: number;
  /**
   * `MILESTONE_SUCCESS` (item F.31, v0.24+) — judge says "applicable
   * criteria met for THIS milestone, but more milestones remain in
   * success.md". Harness continues the loop, skips documenter,
   * surfaces `milestone_note` in history.
   */
  determination: "SUCCESS" | "PROGRESS" | "STALLED" | "ANOMALY" | "MILESTONE_SUCCESS";
  /**
   * Free-form milestone explanation, required when
   * `determination === "MILESTONE_SUCCESS"` (item F.31, v0.24+).
   */
  milestone_note?: string;
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
  reflection_needed?: boolean;
  reflection_reason?: string;
}
export type HistoryEventStatus = "running" | "completed" | "failed";

export interface BaseHistoryEvent {
  id: string;
  type: HistoryEventType;
  status: HistoryEventStatus;
  startedAt: string;
  completedAt?: string;
  /**
   * Optional because user-action events (e.g. `loop-stopped`) don't
   * spawn an agent and have no log file.
   */
  logFile?: string;
  /**
   * Optional because user-action events (e.g. `loop-stopped`) don't
   * involve an agent.
   */
  agent?: string;
  model?: string;
  error?: string;
}

export interface ArchitectSignals {
  readiness: "READY" | "NEEDS_REFINEMENT" | "BLOCKED";
  gaps: string[];
  suggestions: string[];
  risks: string[];
  recommended_approach?: string;
}

export interface ReviewHistoryEvent extends BaseHistoryEvent {
  type: "review";
  readiness?: string;
  /** Full parsed architect signals (added in 0.4.0) */
  signals?: ArchitectSignals;
  /** Added in 0.7.2: `"loop"` = pre-loop review phase; `"manual"` = user-invoked. */
  trigger?: "loop" | "manual";
  /**
   * Whether the standalone (`trigger: "manual"`) review committed its
   * on-disk outputs to the current branch. Set by architect-runner.ts
   * since v0.24 (F.1). Absent / undefined on in-loop pre-loop review
   * events — those commit via the iteration-loop driver itself.
   */
  committed?: boolean;
}

export interface IterationHistoryEvent extends BaseHistoryEvent {
  type: "iteration";
  iteration: number;
  branch: string;
  devLogFile: string;
  judgeLogFile: string;
  devAgent: string;
  judgeAgent: string;
  devExitCode?: number;
  judgeExitCode?: number;
  judgeDetermination?: string;
  judgeQuality?: number;
  merged?: boolean;
  /** Full parsed dev signals (added in 0.6.0) -- lets the History row expand. */
  devSignals?: DevSignalsWeb;
  /** Full parsed judge signals (added in 0.6.0). */
  judgeSignals?: JudgeSignalsWeb;
  /**
   * Dev-only completion timestamp (F.21, v0.24+). `completedAt`
   * (inherited from BaseHistoryEvent) is the JUDGE'S (= iteration's)
   * completion time. Together they let the History tab show
   * per-half durations on the separated Dev / Judge rows. Absent on
   * iteration events written by pre-F.21 servers; the web falls
   * back to "—" for the dev row's duration in that case.
   */
  devCompletedAt?: string;
  /**
   * Milestone explanation surfaced when `judgeDetermination ===
   * "MILESTONE_SUCCESS"` (F.31, v0.24+). Free-form markdown.
   */
  milestoneNote?: string;
  /**
   * Who set the MILESTONE_SUCCESS determination — `"judge"` when
   * judge emitted it directly, `"reflection"` when reflection
   * overrode a judge-SUCCESS via `override_determination`.
   * Undefined for non-milestone determinations.
   */
  milestoneSetBy?: "judge" | "reflection";
}

export interface DocumentHistoryEvent extends BaseHistoryEvent {
  type: "document";
  docsFileCount?: number;
  committed?: boolean;
  exitCode?: number;
}

export interface ReflectionHistoryEvent extends BaseHistoryEvent {
  type: "reflection";
  iteration: number;
  trigger: "loop" | "manual";
  signals?: ReflectionSignals;
  iterationHealth?: IterationHealth;
  planModified?: boolean;
  /** Reason the non-destructive validator rejected a rewrite (added in 0.6.0). */
  planRejectionReason?: string;
  exitCode?: number;
  /**
   * Whether the standalone (`trigger: "manual"`) reflection committed
   * its on-disk outputs to the current branch. Set by reflection-
   * runner.ts since v0.24 (F.1). Absent / undefined on in-loop
   * reflection events — those commit via the iteration-loop driver
   * itself.
   */
  committed?: boolean;
}

/**
 * Product Architect interactive session. Plan item 5.14 v2.
 * Mirrors PaSessionHistoryEvent in @cfcf/core's workspace-history.ts.
 */
export interface PaSessionHistoryEvent extends BaseHistoryEvent {
  type: "pa-session";
  /** PA's session_id (e.g. `pa-2026-04-29T06-07-13-abc123`). */
  sessionId: string;
  /** Path to the session scratchpad relative to the workspace's repo. */
  sessionFilePath: string;
  /** One-line summary written by PA on session save. */
  outcomeSummary?: string;
  /** Decisions/rejections/preferences captured this session. */
  decisionsCount?: number;
  /** Clio doc ID for `pa-workspace-memory` (link to the canonical store). */
  clioWorkspaceMemoryDocId?: string;
  exitCode?: number;
  workspaceRegisteredAtStart: boolean;
  gitInitializedAtStart: boolean;
  problemPackFilesAtStart: number;
  /** PA launcher PID — used server-side for boot-time liveness checks (F.28, v0.24). */
  launcherPid?: number;
}

/**
 * Item 6.25: user-initiated `stop_loop_now` event. Captures the
 * iteration the loop stopped at + the user's free-text feedback as
 * an audit note. No agent runs — `logFile` / `agent` from the base
 * are absent. Mirrors `LoopStoppedHistoryEvent` in @cfcf/core's
 * `workspace-history.ts`.
 */
export interface LoopStoppedHistoryEvent extends BaseHistoryEvent {
  type: "loop-stopped";
  iteration: number;
  /** User's free-text feedback at the time of stopping. Audit-only. */
  userFeedback?: string;
}

export type HistoryEvent =
  | ReviewHistoryEvent
  | IterationHistoryEvent
  | DocumentHistoryEvent
  | ReflectionHistoryEvent
  | PaSessionHistoryEvent
  | LoopStoppedHistoryEvent;
