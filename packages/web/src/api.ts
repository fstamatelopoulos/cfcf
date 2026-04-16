/**
 * API client for communicating with the cfcf server.
 */

import type {
  ProjectConfig,
  LoopState,
  ReviewState,
  DocumentState,
  HealthResponse,
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

// --- Health ---

export function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/api/health");
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

// --- Document ---

export function startDocument(projectId: string): Promise<DocumentState> {
  return post(`/api/projects/${encodeURIComponent(projectId)}/document`);
}

export function fetchDocumentStatus(projectId: string): Promise<DocumentState> {
  return request<DocumentState>(`/api/projects/${encodeURIComponent(projectId)}/document/status`);
}
