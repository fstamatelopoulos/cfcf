import { useState, useCallback, useEffect } from "react";
import { usePolling } from "../hooks/usePolling";
import { fetchProject, fetchLoopStatus } from "../api";
import { navigateTo } from "../hooks/useRoute";
import { StatusBadge } from "../components/StatusBadge";
import { PhaseIndicator } from "../components/PhaseIndicator";
import { LoopControls } from "../components/LoopControls";
import { FeedbackForm } from "../components/FeedbackForm";
import { IterationHistory } from "../components/IterationHistory";
import { LogViewer } from "../components/LogViewer";
import { ConfigDisplay } from "../components/ConfigDisplay";
import { JudgeAssessment } from "../components/JudgeAssessment";
import { TabBar } from "../components/TabBar";

const tabs = [
  { key: "status", label: "Status" },
  { key: "history", label: "History" },
  { key: "logs", label: "Logs" },
  { key: "config", label: "Config" },
];

export function ProjectDetail({ projectId }: { projectId: string }) {
  const [activeTab, setActiveTab] = useState("status");
  const [selectedIteration, setSelectedIteration] = useState<number | null>(null);

  const {
    data: project,
    error: projectError,
    loading: projectLoading,
    refresh: refreshProject,
  } = usePolling(
    useCallback(() => fetchProject(projectId), [projectId]),
    10000,
    [projectId],
  );

  // We use a two-stage approach:
  // - First, always do an initial fetch to learn the current phase
  // - Then, poll only while the loop is in an active phase
  // This avoids unnecessary polling when nothing is happening.
  const [loopState, setLoopState] = useState<Awaited<ReturnType<typeof fetchLoopStatus>> | null>(null);
  const [loopError, setLoopError] = useState<string | null>(null);

  const refreshLoop = useCallback(async () => {
    try {
      const state = await fetchLoopStatus(projectId);
      setLoopState(state);
      setLoopError(null);
    } catch {
      setLoopState(null);
    }
  }, [projectId]);

  // Active phases: loop needs continued polling (including documenting so logs keep streaming)
  const ACTIVE_PHASES = ["preparing", "dev_executing", "judging", "deciding", "documenting"];
  const isLoopActive = !!loopState && ACTIVE_PHASES.includes(loopState.phase);

  // Initial fetch + poll when active
  useEffect(() => {
    refreshLoop();
  }, [refreshLoop]);

  useEffect(() => {
    if (!isLoopActive) return;
    const id = setInterval(refreshLoop, 3000);
    return () => clearInterval(id);
  }, [isLoopActive, refreshLoop]);

  const handleAction = () => {
    refreshProject();
    refreshLoop();
  };

  if (projectLoading && !project) {
    return <div className="project-detail__loading">Loading...</div>;
  }

  if (projectError || !project) {
    return <div className="project-detail__error">Project not found: {projectError}</div>;
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
        onAction={handleAction}
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
          onResume={handleAction}
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
        {activeTab === "status" && (
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
        )}

        {activeTab === "history" && (
          <div>
            <IterationHistory
              iterations={loopState?.iterations || []}
              onSelectIteration={(num) => {
                setSelectedIteration(num);
                setActiveTab("logs");
              }}
            />
            {(!loopState?.iterations || loopState.iterations.length === 0) &&
              (project.currentIteration || 0) > 0 && (
                <div className="iteration-history__note">
                  <strong>Note:</strong> This project has {project.currentIteration} iteration(s)
                  in its git history, but only iterations from the current loop run are
                  shown here. Each time "Start Loop" is clicked, a fresh loop state is
                  created. Use git log in the repo to see all historical iterations.
                </div>
              )}
          </div>
        )}

        {activeTab === "logs" && (
          <div className="log-panel">
            {selectedIteration ? (
              <LogViewer
                projectId={project.id}
                iteration={selectedIteration}
                role="dev"
              />
            ) : loopState?.currentIteration ? (
              <LogViewer
                projectId={project.id}
                iteration={loopState.currentIteration}
                role="dev"
              />
            ) : (
              <div className="log-panel__empty">
                No iteration selected. Start a loop or select an iteration from History.
              </div>
            )}
          </div>
        )}

        {activeTab === "config" && <ConfigDisplay project={project} />}
      </div>
    </div>
  );
}
