/**
 * API client for communicating with the cfcf server.
 */

import type {
  ProjectConfig,
  LoopState,
  ReviewState,
  DocumentState,
  HealthResponse,
  HistoryEvent,
  NotificationConfig,
} from "./types";

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) {
    throw new ApiError(res.status, (data as { error?: string }).error || res.statusText);
  }
  return data as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

// --- Health + Status + Config ---

export function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/api/health");
}

export interface ServerStatus {
  status: string;
  version: string;
  uptime: number;
  pid: number;
  port: number;
  configured: boolean;
  availableAgents: string[];
}

export function fetchServerStatus(): Promise<ServerStatus> {
  return request<ServerStatus>("/api/status");
}

export interface GlobalConfig {
  version: number;
  devAgent: { adapter: string; model?: string };
  judgeAgent: { adapter: string; model?: string };
  architectAgent: { adapter: string; model?: string };
  documenterAgent: { adapter: string; model?: string };
  reflectionAgent?: { adapter: string; model?: string };
  reflectSafeguardAfter?: number;
  maxIterations: number;
  pauseEvery: number;
  availableAgents: string[];
  permissionsAcknowledged: boolean;
  cleanupMergedBranches?: boolean;
  autoReviewSpecs?: boolean;
  autoDocumenter?: boolean;
  readinessGate?: "never" | "blocked" | "needs_refinement_or_blocked";
  notifications?: NotificationConfig;
}

export function fetchGlobalConfig(): Promise<GlobalConfig> {
  return request<GlobalConfig>("/api/config");
}

/**
 * Save edits to the global config. Accepts a partial patch; server merges
 * onto the existing config, preserves server-owned fields (version,
 * permissionsAcknowledged, availableAgents), validates, and returns the
 * saved config. Added in v0.7.3 (item 5.9).
 */
export function saveGlobalConfig(patch: Partial<GlobalConfig>): Promise<GlobalConfig> {
  return request<GlobalConfig>("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

// --- Projects ---

export function fetchProjects(): Promise<ProjectConfig[]> {
  return request<ProjectConfig[]>("/api/projects");
}

export function fetchProject(id: string): Promise<ProjectConfig> {
  return request<ProjectConfig>(`/api/projects/${encodeURIComponent(id)}`);
}

// --- Loop ---

export function fetchLoopStatus(projectId: string): Promise<LoopState> {
  return request<LoopState>(`/api/projects/${encodeURIComponent(projectId)}/loop/status`);
}

export function startLoop(projectId: string): Promise<{ phase: string }> {
  return post(`/api/projects/${encodeURIComponent(projectId)}/loop/start`);
}

export function stopLoop(projectId: string): Promise<{ phase: string }> {
  return post(`/api/projects/${encodeURIComponent(projectId)}/loop/stop`);
}

export function resumeLoop(projectId: string, feedback?: string): Promise<{ phase: string }> {
  return post(`/api/projects/${encodeURIComponent(projectId)}/loop/resume`, feedback ? { feedback } : undefined);
}

// --- Review ---

export function startReview(projectId: string): Promise<ReviewState> {
  return post(`/api/projects/${encodeURIComponent(projectId)}/review`);
}

export function fetchReviewStatus(projectId: string): Promise<ReviewState> {
  return request<ReviewState>(`/api/projects/${encodeURIComponent(projectId)}/review/status`);
}

export function stopReview(projectId: string): Promise<{ status: string }> {
  return post(`/api/projects/${encodeURIComponent(projectId)}/review/stop`);
}

// --- Document ---

export function startDocument(projectId: string): Promise<DocumentState> {
  return post(`/api/projects/${encodeURIComponent(projectId)}/document`);
}

export function fetchDocumentStatus(projectId: string): Promise<DocumentState> {
  return request<DocumentState>(`/api/projects/${encodeURIComponent(projectId)}/document/status`);
}

export function stopDocument(projectId: string): Promise<{ status: string }> {
  return post(`/api/projects/${encodeURIComponent(projectId)}/document/stop`);
}

// --- History ---

export interface ActivityItem {
  projectId: string;
  projectName: string;
  type: "iteration" | "review" | "document" | "reflection";
  phase?: string;
  iteration?: number;
  startedAt: string;
}

export function fetchActivity(): Promise<{ active: ActivityItem[] }> {
  return request<{ active: ActivityItem[] }>(`/api/activity`);
}

export function fetchHistory(projectId: string): Promise<HistoryEvent[]> {
  return request<HistoryEvent[]>(`/api/projects/${encodeURIComponent(projectId)}/history`);
}
