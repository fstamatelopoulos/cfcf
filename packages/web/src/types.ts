/**
 * API response types for the cfcf web GUI.
 * These mirror the JSON shapes returned by the server API.
 */

export interface AgentConfig {
  adapter: string;
  model?: string;
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
  processTemplate: string;
  currentIteration: number;
  status?: ProjectStatus;
}

export type LoopPhase =
  | "idle"
  | "preparing"
  | "dev_executing"
  | "judging"
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
  projectId: string;
  projectName: string;
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
  projectId: string;
  projectName: string;
  status: "preparing" | "executing" | "collecting" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  logFile: string;
  signals?: {
    readiness: string;
    gaps: string[];
    suggestions: string[];
    risks: string[];
    recommended_approach?: string;
  };
  error?: string;
}

export interface DocumentState {
  projectId: string;
  projectName: string;
  status: "preparing" | "executing" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  logFile: string;
  error?: string;
}

export interface HealthResponse {
  status: string;
  version: string;
  uptime: number;
}
