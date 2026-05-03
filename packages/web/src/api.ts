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

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /**
     * Optional structured payload from the error response body.
     * Routes that return additional fields beyond `error` (e.g.
     * `dependentWorkspaces`, `documentCount`) attach them here so
     * callers can render targeted UI.
     */
    public payload?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) {
    throw new ApiError(
      res.status,
      (data as { error?: string }).error || res.statusText,
      data as Record<string, unknown>,
    );
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

// --- Update notification (item 6.20) ---

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string;
  checkedAt: string;
}

/**
 * Returns `null` when the server has nothing to surface (HTTP 204 from
 * `/api/update-status`). Returns the parsed body when a newer release is
 * known and the running server is older than `latestVersion`.
 *
 * Doesn't go through `request<T>()` because that helper assumes a JSON
 * body on every response, but 204 has none.
 */
export async function fetchUpdateStatus(): Promise<UpdateStatus | null> {
  const res = await fetch("/api/update-status");
  if (res.status === 204) return null;
  if (!res.ok) return null;
  return (await res.json()) as UpdateStatus;
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
  helpAssistantAgent?: { adapter: string; model?: string };
  productArchitectAgent?: { adapter: string; model?: string };
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
  /** Web UI theme (item 6.12). "auto" follows prefers-color-scheme. */
  theme?: "auto" | "dark" | "light";
  /**
   * Per-adapter model registry override (item 6.26). When set + non-
   * empty for an adapter, supersedes the bundled seed.
   */
  agentModels?: Record<string, string[]>;
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
 * Create a new workspace (item 6.12). Mirrors `cfcf workspace init` --
 * server resolves agent role defaults from the global config when fields
 * are omitted.
 */
export interface CreateWorkspaceRequest {
  name: string;
  repoPath: string;
  clioProject?: string;
  devAgent?: { adapter: string; model?: string };
  judgeAgent?: { adapter: string; model?: string };
  architectAgent?: { adapter: string; model?: string };
  documenterAgent?: { adapter: string; model?: string };
  maxIterations?: number;
  pauseEvery?: number;
}

export function createWorkspace(body: CreateWorkspaceRequest): Promise<WorkspaceConfig> {
  return request<WorkspaceConfig>("/api/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Delete a workspace (config-only; the underlying repo folder is NEVER
 * touched). Returns the server's `{ deleted: true }` ack.
 */
export function deleteWorkspace(id: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/**
 * Reassign a workspace to a different Clio Project (mirrors `cfcf
 * workspace set <name> --project <p>`). The server auto-creates the
 * project if it doesn't exist. `migrateHistory` rekeys this workspace's
 * existing docs to the new project; `allInProject` extends that to every
 * doc in the old project (use with care).
 */
export function setWorkspaceClioProject(
  workspaceId: string,
  body: { project: string; migrateHistory?: boolean; allInProject?: boolean },
): Promise<{ workspaceId: string; clioProject: string; migrated: number }> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/clio-project`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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

/**
 * Item 6.25: structured resume action drives harness routing; free-text
 * feedback is optional context for the destination implied by the action.
 * Default action "continue" preserves pre-6.25 behaviour for any caller
 * that doesn't pass it.
 */
export type ResumeAction =
  | "continue"
  | "finish_loop"
  | "stop_loop_now"
  | "refine_plan"
  | "consult_reflection";

export function resumeLoop(
  workspaceId: string,
  feedback?: string,
  action: ResumeAction = "continue",
): Promise<{ phase: string }> {
  const body: Record<string, unknown> = { action };
  if (feedback) body.feedback = feedback;
  return post(`/api/workspaces/${encodeURIComponent(workspaceId)}/loop/resume`, body);
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

// --- Agent model registry (item 6.26) ---

export interface AgentModelsResponse {
  /** Resolved per-adapter model list (user override else seed). */
  adapters: Record<string, string[]>;
  /** The bundled seed; surfaced so the Settings editor can offer "reset". */
  seed: Record<string, string[]>;
}

export function fetchAgentModels(): Promise<AgentModelsResponse> {
  return request<AgentModelsResponse>("/api/agents/models");
}

// --- Reflect (item 5.6 / web surface in 6.12) ---

export interface ReflectState {
  workspaceId: string;
  status: "preparing" | "executing" | "collecting" | "completed" | "failed" | "stopped";
  startedAt?: string;
  completedAt?: string;
  exitCode?: number;
  logFile?: string;
  logFileName?: string;
  error?: string;
}

/**
 * Start an ad-hoc Reflection pass (mirrors `cfcf reflect`). `prompt` is an
 * optional free-text question for the reflection agent.
 */
export function startReflect(workspaceId: string, prompt?: string): Promise<{ status: string }> {
  return post(`/api/workspaces/${encodeURIComponent(workspaceId)}/reflect`, prompt ? { prompt } : undefined);
}

export function fetchReflectStatus(workspaceId: string): Promise<ReflectState> {
  return request<ReflectState>(`/api/workspaces/${encodeURIComponent(workspaceId)}/reflect/status`);
}

export function stopReflect(workspaceId: string): Promise<{ status: string }> {
  return post(`/api/workspaces/${encodeURIComponent(workspaceId)}/reflect/stop`);
}

// --- Clio (memory) — item 6.12 prototype, 6.18 builds out the rest ---

export interface ClioStats {
  dbPath: string;
  dbSizeBytes: number;
  projectCount: number;
  documentCount: number;
  chunkCount: number;
  migrations: string[];
  activeEmbedder: { name: string; dim: number; recommendedChunkMaxChars?: number } | null;
}

export function fetchClioStats(): Promise<ClioStats> {
  return request<ClioStats>("/api/clio/stats");
}

export interface ClioProject {
  id: string;
  name: string;
  description?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  documentCount?: number;
}

export function fetchClioProjects(): Promise<ClioProject[]> {
  return request<{ projects: ClioProject[] }>("/api/clio/projects").then((r) => r.projects);
}

export interface ClioDocument {
  id: string;
  projectId: string;
  projectName?: string;
  title: string;
  source: string;
  author: string;
  contentHash: string;
  metadata: Record<string, unknown>;
  reviewStatus: "approved" | "pending_review";
  chunkCount: number;
  totalChars: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  versionCount?: number;
}

export function fetchClioDocuments(
  opts: { project?: string; limit?: number; offset?: number } = {},
): Promise<ClioDocument[]> {
  const params = new URLSearchParams();
  if (opts.project) params.set("project", opts.project);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.offset) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return request<{ documents: ClioDocument[] }>(
    `/api/clio/documents${qs ? `?${qs}` : ""}`,
  ).then((r) => r.documents);
}

export interface ClioDocumentContent {
  document: ClioDocument;
  content: string;
  chunkCount: number;
  totalChars: number;
  versionId: string | null;
}

export function fetchClioDocumentContent(id: string): Promise<ClioDocumentContent> {
  return request<ClioDocumentContent>(`/api/clio/documents/${encodeURIComponent(id)}/content`);
}

export type ClioSearchMode = "auto" | "fts" | "semantic" | "hybrid";

/** Document-level search hit (server's default `?by=doc`). */
export interface ClioDocumentSearchHit {
  documentId: string;
  docTitle: string;
  docSource: string;
  docAuthor: string;
  docProjectId: string;
  docProjectName: string;
  docMetadata: Record<string, unknown>;
  chunkCount: number;
  totalChars: number;
  versionCount: number;
  matchingChunks: number;
  bestScore: number;
  bestChunkHeadingPath: string[];
  bestChunkHeadingLevel: number | null;
  bestChunkTitle: string | null;
  bestChunkContent: string;
  bestChunkId: string;
  bestChunkIndex: number;
  createdAt: string;
  updatedAt: string;
  isPartial: boolean;
}

export interface ClioDocumentSearchResponse {
  hits: ClioDocumentSearchHit[];
  mode: "fts" | "hybrid" | "semantic";
  totalMatches?: number;
}

export function searchClio(
  query: string,
  opts: { mode?: ClioSearchMode; project?: string; matchCount?: number } = {},
): Promise<ClioDocumentSearchResponse> {
  const params = new URLSearchParams({ q: query });
  if (opts.mode && opts.mode !== "auto") params.set("mode", opts.mode);
  if (opts.project) params.set("project", opts.project);
  if (opts.matchCount) params.set("match_count", String(opts.matchCount));
  return request<ClioDocumentSearchResponse>(`/api/clio/search?${params.toString()}`);
}

/** Chunk-level search hit (server's `?by=chunk`). */
export interface ClioChunkSearchHit {
  chunkId: string;
  documentId: string;
  chunkIndex: number;
  title: string | null;
  content: string;
  headingPath: string[];
  headingLevel: number | null;
  score: number;
  docTitle: string;
  docSource: string;
  docAuthor: string;
  docProjectId: string;
  docProjectName: string;
  docMetadata: Record<string, unknown>;
}

export interface ClioChunkSearchResponse {
  hits: ClioChunkSearchHit[];
  mode: "fts" | "hybrid" | "semantic";
  totalMatches?: number;
}

export function searchClioChunks(
  query: string,
  opts: { mode?: ClioSearchMode; project?: string; matchCount?: number } = {},
): Promise<ClioChunkSearchResponse> {
  const params = new URLSearchParams({ q: query, by: "chunk" });
  if (opts.mode && opts.mode !== "auto") params.set("mode", opts.mode);
  if (opts.project) params.set("project", opts.project);
  if (opts.matchCount) params.set("match_count", String(opts.matchCount));
  return request<ClioChunkSearchResponse>(`/api/clio/search?${params.toString()}`);
}

// --- Clio mutations + admin (item 6.18) ---

export interface ClioIngestRequest {
  project: string;
  title: string;
  content: string;
  source?: string;
  author?: string;
  metadata?: Record<string, unknown>;
  updateIfExists?: boolean;
}

export interface ClioIngestResult {
  id: string;
  action: "created" | "updated";
  versionId?: string;
  versionNumber?: number;
  note?: string;
  document: ClioDocument;
}

export function ingestClio(body: ClioIngestRequest): Promise<ClioIngestResult> {
  return request<ClioIngestResult>("/api/clio/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function deleteClioDocument(id: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/api/clio/documents/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function restoreClioDocument(id: string): Promise<{ restored: boolean; document: ClioDocument }> {
  return request<{ restored: boolean; document: ClioDocument }>(
    `/api/clio/documents/${encodeURIComponent(id)}/restore`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  );
}

export interface ClioDocumentVersion {
  id: string;
  documentId: string;
  versionNumber: number;
  createdAt: string;
  source: string | null;
  totalChars: number;
  chunkCount: number;
  archived?: boolean;
}

export function fetchClioDocumentVersions(id: string): Promise<ClioDocumentVersion[]> {
  return request<{ versions: ClioDocumentVersion[] }>(
    `/api/clio/documents/${encodeURIComponent(id)}/versions`,
  ).then((r) => r.versions);
}

export interface ClioAuditEntry {
  id: number;
  timestamp: string;
  eventType: "create" | "update-content" | "edit-metadata" | "delete" | "restore" | "migrate-project";
  actor: string | null;
  projectId: string | null;
  documentId: string | null;
  query: string | null;
  metadata: Record<string, unknown>;
}

export function fetchClioAuditLog(
  opts: {
    eventType?: string;
    actor?: string;
    project?: string;
    documentId?: string;
    since?: string;
    limit?: number;
  } = {},
): Promise<ClioAuditEntry[]> {
  const params = new URLSearchParams();
  if (opts.eventType) params.set("event_type", opts.eventType);
  if (opts.actor) params.set("actor", opts.actor);
  if (opts.project) params.set("project", opts.project);
  if (opts.documentId) params.set("document_id", opts.documentId);
  if (opts.since) params.set("since", opts.since);
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return request<{ entries: ClioAuditEntry[] }>(`/api/clio/audit-log${qs ? `?${qs}` : ""}`).then(
    (r) => r.entries,
  );
}

export interface ClioMetadataKey {
  key: string;
  count: number;
  /** A few sample values from real documents. */
  sampleValues: (string | number | boolean)[];
}

export function fetchClioMetadataKeys(project?: string): Promise<ClioMetadataKey[]> {
  const params = project ? `?project=${encodeURIComponent(project)}` : "";
  return request<{ keys: ClioMetadataKey[] }>(`/api/clio/metadata-keys${params}`).then((r) => r.keys);
}

export function createClioProject(body: { name: string; description?: string }): Promise<ClioProject> {
  return request<ClioProject>("/api/clio/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function editClioProject(
  idOrName: string,
  edits: { name?: string; description?: string },
): Promise<ClioProject> {
  return request<ClioProject>(`/api/clio/projects/${encodeURIComponent(idOrName)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edits),
  });
}

export function deleteClioProject(idOrName: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/api/clio/projects/${encodeURIComponent(idOrName)}`, {
    method: "DELETE",
  });
}

/**
 * Metadata-only edit (item 6.18 round-2). Routes through the existing
 * `PATCH /api/clio/documents/:id` endpoint -- writes a single
 * `edit-metadata` audit entry, no version snapshot. For content edits
 * use `ingestClio` with the `documentId` field (which routes through
 * the content-unchanged short-circuit added in the same round).
 */
export function editClioDocumentMetadata(
  id: string,
  edits: {
    title?: string;
    author?: string;
    projectId?: string;
    projectName?: string;
    metadataSet?: Record<string, unknown>;
    metadataUnset?: string[];
  },
): Promise<{ updated: boolean; document: ClioDocument }> {
  return request<{ updated: boolean; document: ClioDocument }>(
    `/api/clio/documents/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(edits),
    },
  );
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

// --- Product Architect session detail (5.14 v2) ---

export interface PaSessionFileSnapshot {
  sessionId: string;
  cachePath: string;
  /** Markdown body of `<repo>/.cfcf-pa/session-<sessionId>.md`, or null if absent. */
  sessionFile: string | null;
  /** Relative path for display. */
  sessionFilePath: string;
  /** Markdown body of `<repo>/.cfcf-pa/workspace-summary.md`, or null if absent. */
  workspaceSummary: string | null;
  workspaceSummaryPath: string;
  /** Parsed `<repo>/.cfcf-pa/meta.json`, or null if absent. */
  meta: Record<string, unknown> | null;
}

export function fetchPaSessionFile(
  workspaceId: string,
  sessionId: string,
): Promise<PaSessionFileSnapshot> {
  return request<PaSessionFileSnapshot>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/pa-sessions/${encodeURIComponent(sessionId)}/file`,
  );
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
