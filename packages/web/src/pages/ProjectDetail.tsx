import { useState, useCallback, useEffect } from "react";
import {
  fetchProject,
  fetchLoopStatus,
  fetchHistory,
  fetchReviewStatus,
  fetchDocumentStatus,
} from "../api";
import { navigateTo } from "../hooks/useRoute";
import { StatusBadge } from "../components/StatusBadge";
import { PhaseIndicator } from "../components/PhaseIndicator";
import { LoopControls, type AgentAction, type ActiveAgent } from "../components/LoopControls";
import { FeedbackForm } from "../components/FeedbackForm";
import { LogViewer, type LogTarget } from "../components/LogViewer";
import { ConfigDisplay } from "../components/ConfigDisplay";
import { JudgeAssessment } from "../components/JudgeAssessment";
import { ArchitectReview } from "../components/ArchitectReview";
import { ProjectHistory } from "../components/ProjectHistory";
import { TabBar } from "../components/TabBar";
import type {
  ProjectConfig,
  LoopState,
  HistoryEvent,
  IterationHistoryEvent,
  ReviewState,
  DocumentState,
} from "../types";

const tabs = [
  { key: "status", label: "Status" },
  { key: "history", label: "History" },
  { key: "logs", label: "Logs" },
  { key: "config", label: "Config" },
];

const LOOP_ACTIVE_PHASES = ["pre_loop_reviewing", "preparing", "dev_executing", "judging", "reflecting", "deciding", "documenting"];
const REVIEW_ACTIVE_STATUSES = ["preparing", "executing", "collecting"];
const DOCUMENT_ACTIVE_STATUSES = ["preparing", "executing"];

export function ProjectDetail({ projectId }: { projectId: string }) {
  const [activeTab, setActiveTab] = useState("status");
  const [project, setProject] = useState<ProjectConfig | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [loopState, setLoopState] = useState<LoopState | null>(null);
  const [reviewState, setReviewState] = useState<ReviewState | null>(null);
  const [documentState, setDocumentState] = useState<DocumentState | null>(null);
  const [history, setHistory] = useState<HistoryEvent[]>([]);
  const [logTarget, setLogTarget] = useState<LogTarget | null>(null);

  // --- Fetchers ---

  const refreshProject = useCallback(async () => {
    try {
      const p = await fetchProject(projectId);
      setProject(p);
      setProjectError(null);
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);

  const refreshLoop = useCallback(async () => {
    try {
      const state = await fetchLoopStatus(projectId);
      setLoopState(state);
    } catch {
      setLoopState(null);
    }
  }, [projectId]);

  const refreshReview = useCallback(async () => {
    try {
      const state = await fetchReviewStatus(projectId);
      setReviewState(state);
    } catch {
      setReviewState(null);
    }
  }, [projectId]);

  const refreshDocument = useCallback(async () => {
    try {
      const state = await fetchDocumentStatus(projectId);
      setDocumentState(state);
    } catch {
      setDocumentState(null);
    }
  }, [projectId]);

  const refreshHistory = useCallback(async () => {
    try {
      const events = await fetchHistory(projectId);
      setHistory(events);
    } catch {
      setHistory([]);
    }
  }, [projectId]);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshProject(), refreshLoop(), refreshReview(), refreshDocument(), refreshHistory()]);
  }, [refreshProject, refreshLoop, refreshReview, refreshDocument, refreshHistory]);

  // --- Derived state ---

  const isLoopActive = !!loopState && LOOP_ACTIVE_PHASES.includes(loopState.phase);
  const isReviewActive = !!reviewState && REVIEW_ACTIVE_STATUSES.includes(reviewState.status);
  const isDocumentActive = !!documentState && DOCUMENT_ACTIVE_STATUSES.includes(documentState.status);
  const activeAgent: ActiveAgent = isLoopActive
    ? "loop"
    : isReviewActive
      ? "review"
      : isDocumentActive
        ? "document"
        : null;

  const hasRunningHistory = history.some((e) => e.status === "running");
  const anyAgentRunning = !!activeAgent || hasRunningHistory;

  // --- Polling ---

  // Initial fetch
  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  // Continuous polling: fast (3s) when any agent is running, slow (10s) otherwise
  useEffect(() => {
    const interval = anyAgentRunning ? 3000 : 10000;
    const id = setInterval(refreshAll, interval);
    return () => clearInterval(id);
  }, [anyAgentRunning, refreshAll]);

  // --- Agent action handler ---

  const handleAgentAction = async (action: AgentAction) => {
    await refreshAll();

    // Auto-switch to Logs tab for new agent starts
    if (action === "review" || action === "start" || action === "resume" || action === "document") {
      setTimeout(async () => {
        const events = await fetchHistory(projectId);
        setHistory(events);
        const targetType =
          action === "review" ? "review" : action === "document" ? "document" : "iteration";
        const sorted = [...events].sort(
          (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
        );
        const newest = sorted.find((e) => e.type === targetType);
        if (newest) {
          const label =
            newest.type === "iteration"
              ? `Iteration ${(newest as IterationHistoryEvent).iteration} (dev)`
              : newest.type === "review"
                ? `Review (${newest.agent})`
                : `Document (${newest.agent})`;
          const logFile =
            newest.type === "iteration" ? (newest as IterationHistoryEvent).devLogFile : newest.logFile;
          setLogTarget({ projectId, logFile, label });
          setActiveTab("logs");
        }
      }, 500);
    }
  };

  if (projectError && !project) {
    return <div className="project-detail__error">Project not found: {projectError}</div>;
  }
  if (!project) {
    return <div className="project-detail__loading">Loading...</div>;
  }

  const lastIteration = loopState?.iterations?.[loopState.iterations.length - 1];
  const currentPhase = loopState?.phase;
  const isPaused = currentPhase === "paused";

  // Which state drives the top-of-page indicator + header badge?
  const headerBadgeStatus = isReviewActive
    ? "running"
    : isDocumentActive
      ? "running"
      : currentPhase || project.status;

  return (
    <div className="project-detail">
      <div className="project-detail__header">
        <button className="btn btn--link" onClick={() => navigateTo("/")}>
          &larr; Projects
        </button>
        <h2>{project.name}</h2>
        <StatusBadge status={headerBadgeStatus} />
        {isReviewActive && <span className="project-detail__active-tag">review running</span>}
        {isDocumentActive && <span className="project-detail__active-tag">document running</span>}
      </div>

      <LoopControls
        projectId={project.id}
        phase={currentPhase}
        activeAgent={activeAgent}
        onAction={handleAgentAction}
        autoReviewSpecs={project.autoReviewSpecs}
      />

      {/* Phase indicator: shows for whichever agent is active.
          startedAt drives the live elapsed-time counter in the subtitle.
          Also rendered during `paused` so the user sees the frozen elapsed
          for the current iteration while deciding how to proceed. */}
      {(isLoopActive || isPaused) && loopState && (
        <PhaseIndicator
          agentType="loop"
          phase={loopState.phase}
          title={
            loopState.currentIteration > 0
              ? `Iteration ${loopState.currentIteration}`
              : loopState.phase === "pre_loop_reviewing"
                ? "Pre-loop review"
                : undefined
          }
          startedAt={
            loopState.iterations[loopState.iterations.length - 1]?.startedAt ||
            loopState.startedAt
          }
          completedAt={
            loopState.iterations[loopState.iterations.length - 1]?.completedAt
          }
          autoReviewSpecs={project.autoReviewSpecs}
          autoDocumenter={project.autoDocumenter}
        />
      )}
      {isReviewActive && reviewState && (
        <PhaseIndicator
          agentType="review"
          phase={reviewState.status}
          title={reviewState.sequence ? `Review run ${reviewState.sequence}` : "Review"}
          startedAt={reviewState.startedAt}
          completedAt={reviewState.completedAt}
        />
      )}
      {isDocumentActive && documentState && (
        <PhaseIndicator
          agentType="document"
          phase={documentState.status}
          title={documentState.sequence ? `Document run ${documentState.sequence}` : "Document"}
          startedAt={documentState.startedAt}
          completedAt={documentState.completedAt}
        />
      )}

      {isPaused && (
        <FeedbackForm
          projectId={project.id}
          questions={loopState?.pendingQuestions}
          onResume={() => handleAgentAction("resume")}
        />
      )}

      {loopState?.error && (
        <div className="project-detail__error-banner">
          <div className="project-detail__error-banner-title">
            ⚠️ Loop failed
          </div>
          <div className="project-detail__error-banner-message">
            {loopState.error}
          </div>
          {loopState.error.toLowerCase().includes("server") && (
            <div className="project-detail__error-banner-hint">
              The server was restarted while the loop was running. The loop has been
              marked as failed. You can start a new loop — cfcf will create a new
              iteration branch from the current HEAD.
            </div>
          )}
        </div>
      )}

      {loopState?.outcome && !isLoopActive && (
        <div className={`project-detail__outcome project-detail__outcome--${loopState.outcome}`}>
          Outcome: {loopState.outcome}
          {loopState.completedAt && (
            <span className="project-detail__completed">
              {" "}({new Date(loopState.completedAt).toLocaleString()})
            </span>
          )}
        </div>
      )}

      <TabBar tabs={tabs} active={activeTab} onChange={setActiveTab} />

      <div className="project-detail__panel">
        <div style={{ display: activeTab === "status" ? "block" : "none" }}>
          <div className="status-panel">
            {isReviewActive && reviewState && (
              <div className="status-panel__section">
                <h3>Review in progress</h3>
                <div className="status-panel__info">
                  <span>Started: {new Date(reviewState.startedAt).toLocaleTimeString()}</span>
                  <span>Agent: {reviewState.projectName ? "" : ""}{project.architectAgent.adapter}</span>
                </div>
              </div>
            )}
            {isDocumentActive && documentState && (
              <div className="status-panel__section">
                <h3>Document in progress</h3>
                <div className="status-panel__info">
                  <span>Started: {new Date(documentState.startedAt).toLocaleTimeString()}</span>
                  <span>Agent: {project.documenterAgent.adapter}</span>
                </div>
              </div>
            )}
            {lastIteration?.judgeSignals && (
              <div className="status-panel__section">
                <h3>Latest Judge Assessment</h3>
                <JudgeAssessment signals={lastIteration.judgeSignals} />
              </div>
            )}
            {reviewState?.signals && !isReviewActive && (
              <div className="status-panel__section">
                <h3>
                  Latest Review
                  {reviewState.completedAt && (
                    <span
                      className="status-panel__timestamp"
                      style={{ fontWeight: 400, fontSize: "0.8rem", marginLeft: "0.5rem" }}
                    >
                      ({new Date(reviewState.completedAt).toLocaleString()})
                    </span>
                  )}
                </h3>
                <ArchitectReview signals={reviewState.signals} />
              </div>
            )}
            {loopState && (
              <div className="status-panel__section">
                <h3>Loop State</h3>
                <div className="status-panel__info">
                  <span>Iterations: {loopState.currentIteration} / {loopState.maxIterations}</span>
                  {loopState.pauseEvery > 0 && (
                    <span>Pause every: {loopState.pauseEvery}</span>
                  )}
                  {loopState.consecutiveStalled > 0 && (
                    <span className="text-warning">
                      Consecutive stalled: {loopState.consecutiveStalled}
                    </span>
                  )}
                </div>
              </div>
            )}
            {!loopState && !reviewState && !documentState && (
              <div className="status-panel__empty">
                Nothing has run yet. Click Review to start, or Start Loop to begin iterating.
              </div>
            )}
          </div>
        </div>

        <div style={{ display: activeTab === "history" ? "block" : "none" }}>
          <ProjectHistory
            events={history}
            projectId={project.id}
            onSelectLog={(target) => {
              setLogTarget(target);
              setActiveTab("logs");
            }}
          />
        </div>

        <div style={{ display: activeTab === "logs" ? "block" : "none" }}>
          <LogViewer target={logTarget} />
        </div>

        <div style={{ display: activeTab === "config" ? "block" : "none" }}>
          <ConfigDisplay project={project} onSaved={(p) => setProject(p)} />
        </div>
      </div>
    </div>
  );
}
