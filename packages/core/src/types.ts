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
   * Default for new projects' `cleanupMergedBranches`. When true, merged
   * iteration branches are deleted after a successful auto-merge. Default
   * false (keep for audit). (item 5.2)
   */
  cleanupMergedBranches?: boolean;
}

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
  /** Project context */
  project: {
    id: string;
    name: string;
  };
  /** ISO timestamp when the event fired */
  timestamp: string;
  /** Event-specific details (e.g., iteration number, reason, determination) */
  details?: Record<string, unknown>;
}

export type ProjectStatus = "idle" | "running" | "paused" | "completed" | "failed" | "stopped";

export interface ProjectConfig {
  id: string;
  name: string;
  repoPath: string;
  repoUrl?: string;
  devAgent: AgentConfig;
  judgeAgent: AgentConfig;
  architectAgent: AgentConfig;
  documenterAgent: AgentConfig;
  maxIterations: number;
  pauseEvery: number;
  onStalled: "continue" | "stop" | "alert";
  mergeStrategy: "auto" | "pr";
  /**
   * When true, delete the `cfcf/iteration-N` branch after a successful
   * auto-merge to main. Default false: keeps branches so iteration diffs
   * remain accessible via `git diff main..cfcf/iteration-N` even after
   * merge. Enable this for long-running projects that would otherwise
   * accumulate many merged branches. (item 5.2)
   */
  cleanupMergedBranches?: boolean;
  processTemplate: string;
  /** Monotonically increasing iteration counter for this project */
  currentIteration: number;
  /** Current project status in the iteration loop */
  status?: ProjectStatus;
  /** Per-project notification override (defaults to global config) */
  notifications?: NotificationConfig;
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
      type: "project.paused";
      reason: "cadence" | "anomaly" | "user_input_needed";
      questions?: string[];
    }
  | { type: "project.completed"; status: "success" | "failure" | "stopped" }
  | { type: "alert"; message: string };
