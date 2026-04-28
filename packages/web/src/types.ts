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
  determination: "SUCCESS" | "PROGRESS" | "STALLED" | "ANOMALY";
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
  pauseReason?: "cadence" | "anomaly" | "user_input_needed" | "max_iterations";
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

export type HistoryEventType = "review" | "iteration" | "document" | "reflection";

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
  logFile: string;
  agent: string;
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
}

export type HistoryEvent =
  | ReviewHistoryEvent
  | IterationHistoryEvent
  | DocumentHistoryEvent
  | ReflectionHistoryEvent;
