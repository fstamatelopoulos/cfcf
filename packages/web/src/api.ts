/**
 * API client for communicating with the cfcf server.
 */

import type {
  WorkspaceConfig,
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
  /**
   * Clio (item 5.7) global config. Mirrors `ClioGlobalConfig` in
   * @cfcf/core. Per-workspace overrides live on `WorkspaceConfig.clio`.
   */
  clio?: {
    ingestPolicy?: "summaries-only" | "all" | "off";
    preferredEmbedder?: string;
    defaultSearchMode?: "auto" | "fts" | "semantic" | "hybrid";
    minSearchScore?: number;
    /** 5.12+ follow-ups (Cerefox parity). All optional. */
    hybridAlpha?: number;
    smallDocThreshold?: number;
    contextWindow?: number;
    maxChunkChars?: number;
    minChunkChars?: number;
  };
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

// --- Workspaces ---

export function fetchWorkspaces(): Promise<WorkspaceConfig[]> {
  return request<WorkspaceConfig[]>("/api/workspaces");
}

export function fetchWorkspace(id: string): Promise<WorkspaceConfig> {
  return request<WorkspaceConfig>(`/api/workspaces/${encodeURIComponent(id)}`);
}

/**
 * Save edits to a workspace's per-workspace config (item 6.14). Accepts a
 * partial patch; server merges onto the existing workspace config,
 * preserves identity + runtime fields (id, name, repoPath,
 * currentIteration, status, processTemplate), validates bounded + enum
 * fields, and writes. Returns the saved config.
 *
 * Sending `notifications: null` clears any per-workspace notification
 * override, re-inheriting the global config.
 */
export function saveWorkspace(
  id: string,
  patch: Partial<WorkspaceConfig> & { notifications?: WorkspaceConfig["notifications"] | null },
): Promise<WorkspaceConfig> {
  return request<WorkspaceConfig>(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

// --- Loop ---

export function fetchLoopStatus(workspaceId: string): Promise<LoopState> {
  return request<LoopState>(`/api/workspaces/${encodeURIComponent(workspaceId)}/loop/status`);
}

export function startLoop(workspaceId: string): Promise<{ phase: string }> {
  return post(`/api/workspaces/${encodeURIComponent(workspaceId)}/loop/start`);
}

export function stopLoop(workspaceId: string): Promise<{ phase: string }> {
  return post(`/api/workspaces/${encodeURIComponent(workspaceId)}/loop/stop`);
}

export function resumeLoop(workspaceId: string, feedback?: string): Promise<{ phase: string }> {
  return post(`/api/workspaces/${encodeURIComponent(workspaceId)}/loop/resume`, feedback ? { feedback } : undefined);
}

// --- Review ---

export function startReview(workspaceId: string): Promise<ReviewState> {
  return post(`/api/workspaces/${encodeURIComponent(workspaceId)}/review`);
}

export function fetchReviewStatus(workspaceId: string): Promise<ReviewState> {
  return request<ReviewState>(`/api/workspaces/${encodeURIComponent(workspaceId)}/review/status`);
}

export function stopReview(workspaceId: string): Promise<{ status: string }> {
  return post(`/api/workspaces/${encodeURIComponent(workspaceId)}/review/stop`);
}

// --- Document ---

export function startDocument(workspaceId: string): Promise<DocumentState> {
  return post(`/api/workspaces/${encodeURIComponent(workspaceId)}/document`);
}

export function fetchDocumentStatus(workspaceId: string): Promise<DocumentState> {
  return request<DocumentState>(`/api/workspaces/${encodeURIComponent(workspaceId)}/document/status`);
}

export function stopDocument(workspaceId: string): Promise<{ status: string }> {
  return post(`/api/workspaces/${encodeURIComponent(workspaceId)}/document/stop`);
}

// --- History ---

export interface ActivityItem {
  workspaceId: string;
  workspaceName: string;
  type: "iteration" | "review" | "document" | "reflection";
  phase?: string;
  iteration?: number;
  startedAt: string;
}

export function fetchActivity(): Promise<{ active: ActivityItem[] }> {
  return request<{ active: ActivityItem[] }>(`/api/activity`);
}

export function fetchHistory(workspaceId: string): Promise<HistoryEvent[]> {
  return request<HistoryEvent[]>(`/api/workspaces/${encodeURIComponent(workspaceId)}/history`);
}

// --- Help (5.8 PR2/PR3) ---

export interface HelpTopicSummary {
  slug: string;
  title: string;
  source: string;
  aliases: string[];
}

export interface HelpTopic extends HelpTopicSummary {
  content: string;
}

export function fetchHelpTopics(): Promise<{ topics: HelpTopicSummary[] }> {
  return request<{ topics: HelpTopicSummary[] }>(`/api/help/topics`);
}

export function fetchHelpTopic(slug: string): Promise<HelpTopic> {
  return request<HelpTopic>(`/api/help/topics/${encodeURIComponent(slug)}`);
}
