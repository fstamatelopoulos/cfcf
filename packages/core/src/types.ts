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
  buildCommand(workspacePath: string, prompt: string): { command: string; args: string[] };

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
  /** Default max iterations */
  maxIterations: number;
  /** Default pause cadence (0 = no pauses) */
  pauseEvery: number;
  /** Detected available agents (populated during first-run) */
  availableAgents: string[];
  /** Whether the user acknowledged the permission flags */
  permissionsAcknowledged: boolean;
}

export interface ProjectConfig {
  id: string;
  name: string;
  repoPath: string;
  repoUrl?: string;
  devAgent: AgentConfig;
  judgeAgent: AgentConfig;
  maxIterations: number;
  pauseEvery: number;
  onStalled: "continue" | "stop" | "alert";
  mergeStrategy: "auto" | "pr";
  processTemplate: string;
  /** Monotonically increasing iteration counter for this project */
  currentIteration: number;
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
