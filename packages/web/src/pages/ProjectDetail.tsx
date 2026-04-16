import { useState, useCallback, useEffect } from "react";
import { fetchProject, fetchLoopStatus, fetchHistory } from "../api";
import { navigateTo } from "../hooks/useRoute";
import { StatusBadge } from "../components/StatusBadge";
import { PhaseIndicator } from "../components/PhaseIndicator";
import { LoopControls, type AgentAction } from "../components/LoopControls";
import { FeedbackForm } from "../components/FeedbackForm";
import { LogViewer, type LogTarget } from "../components/LogViewer";
import { ConfigDisplay } from "../components/ConfigDisplay";
import { JudgeAssessment } from "../components/JudgeAssessment";
import { ProjectHistory } from "../components/ProjectHistory";
import { TabBar } from "../components/TabBar";
import type { ProjectConfig, LoopState, HistoryEvent, IterationHistoryEvent } from "../types";

const tabs = [
  { key: "status", label: "Status" },
  { key: "history", label: "History" },
  { key: "logs", label: "Logs" },
  { key: "config", label: "Config" },
];

export function ProjectDetail({ projectId }: { projectId: string }) {
  const [activeTab, setActiveTab] = useState("status");
  const [project, setProject] = useState<ProjectConfig | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [loopState, setLoopState] = useState<LoopState | null>(null);
  const [history, setHistory] = useState<HistoryEvent[]>([]);

  // Log target is lifted here so it persists across tab switches
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

  const refreshHistory = useCallback(async () => {
    try {
      const events = await fetchHistory(projectId);
      setHistory(events);
    } catch {
      setHistory([]);
    }
  }, [projectId]);

  // --- Polling ---

  const ACTIVE_PHASES = ["preparing", "dev_executing", "judging", "deciding", "documenting"];
  const isLoopActive = !!loopState && ACTIVE_PHASES.includes(loopState.phase);

  // Initial fetch of everything
  useEffect(() => {
    refreshProject();
    refreshLoop();
    refreshHistory();
  }, [refreshProject, refreshLoop, refreshHistory]);

  // Poll loop state + history while active
  useEffect(() => {
    if (!isLoopActive) return;
    const id = setInterval(() => {
      refreshLoop();
      refreshHistory();
    }, 3000);
    return () => clearInterval(id);
  }, [isLoopActive, refreshLoop, refreshHistory]);

  // --- Agent action handler ---

  const handleAgentAction = async (action: AgentAction) => {
    // Refresh history after every action so new events show up
    await refreshHistory();
    refreshProject();
    refreshLoop();

    // Auto-switch to logs tab and focus on the new run's log
    if (action === "review" || action === "start" || action === "resume" || action === "document") {
      // Need to refetch history right after starting so we get the new event's log filename
      setTimeout(async () => {
        const events = await fetchHistory(projectId);
        setHistory(events);

        // Find the most recently started event matching the action
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
      }, 500); // Small delay so the server has time to register the new event
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

  return (
    <div className="project-detail">
      <div className="project-detail__header">
        <button className="btn btn--link" onClick={() => navigateTo("/")}>
          &larr; Projects
        </button>
        <h2>{project.name}</h2>
        <StatusBadge status={currentPhase || project.status} />
      </div>

      <LoopControls
        projectId={project.id}
        phase={currentPhase}
        onAction={handleAgentAction}
      />

      {loopState && currentPhase && !["idle", "completed", "failed", "stopped"].includes(currentPhase) && (
        <PhaseIndicator
          phase={currentPhase}
          iteration={loopState.currentIteration}
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
          Error: {loopState.error}
        </div>
      )}

      {loopState?.outcome && (
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
        {/* Keep all tabs mounted so LogViewer preserves SSE state across tab switches */}
        <div style={{ display: activeTab === "status" ? "block" : "none" }}>
          <div className="status-panel">
            {lastIteration?.judgeSignals && (
              <div className="status-panel__section">
                <h3>Latest Judge Assessment</h3>
                <JudgeAssessment signals={lastIteration.judgeSignals} />
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
            {!loopState && (
              <div className="status-panel__empty">
                No active loop. Click "Start Loop" to begin.
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
          <ConfigDisplay project={project} />
        </div>
      </div>
    </div>
  );
}
