import { useState, useCallback, useEffect } from "react";
import {
  fetchWorkspace,
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
import { WorkspaceHistory } from "../components/WorkspaceHistory";
import { TabBar } from "../components/TabBar";
import type {
  WorkspaceConfig,
  LoopState,
  HistoryEvent,
  IterationHistoryEvent,
  PaSessionHistoryEvent,
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

export function WorkspaceDetail({ workspaceId }: { workspaceId: string }) {
  const [activeTab, setActiveTab] = useState("status");
  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [loopState, setLoopState] = useState<LoopState | null>(null);
  const [reviewState, setReviewState] = useState<ReviewState | null>(null);
  const [documentState, setDocumentState] = useState<DocumentState | null>(null);
  const [history, setHistory] = useState<HistoryEvent[]>([]);
  const [logTarget, setLogTarget] = useState<LogTarget | null>(null);

  // --- Fetchers ---

  const refreshWorkspace = useCallback(async () => {
    try {
      const w = await fetchWorkspace(workspaceId);
      setWorkspace(w);
      setWorkspaceError(null);
    } catch (err) {
      setWorkspaceError(err instanceof Error ? err.message : String(err));
    }
  }, [workspaceId]);

  const refreshLoop = useCallback(async () => {
    try {
      const state = await fetchLoopStatus(workspaceId);
      setLoopState(state);
    } catch {
      setLoopState(null);
    }
  }, [workspaceId]);

  const refreshReview = useCallback(async () => {
    try {
      const state = await fetchReviewStatus(workspaceId);
      setReviewState(state);
    } catch {
      setReviewState(null);
    }
  }, [workspaceId]);

  const refreshDocument = useCallback(async () => {
    try {
      const state = await fetchDocumentStatus(workspaceId);
      setDocumentState(state);
    } catch {
      setDocumentState(null);
    }
  }, [workspaceId]);

  const refreshHistory = useCallback(async () => {
    try {
      const events = await fetchHistory(workspaceId);
      setHistory(events);
    } catch {
      setHistory([]);
    }
  }, [workspaceId]);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshWorkspace(), refreshLoop(), refreshReview(), refreshDocument(), refreshHistory()]);
  }, [refreshWorkspace, refreshLoop, refreshReview, refreshDocument, refreshHistory]);

  // --- Derived state ---

  const isLoopActive = !!loopState && LOOP_ACTIVE_PHASES.includes(loopState.phase);
  const isReviewActive = !!reviewState && REVIEW_ACTIVE_STATUSES.includes(reviewState.status);
  const isDocumentActive = !!documentState && DOCUMENT_ACTIVE_STATUSES.includes(documentState.status);

  // PA sessions are interactive — they live in the user's terminal,
  // not as server children. The Status tab learns about them through
  // the History event log, where the launcher writes a `running`
  // entry at session start + a completion entry at session end.
  // (The server-restart cleanup correctly leaves these alone — see
  // packages/core/src/workspace-history.ts.)
  const activePaSessions = history
    .filter((e): e is PaSessionHistoryEvent => e.type === "pa-session" && e.status === "running")
    // Newest first by startedAt so the most recently launched is shown first
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));

  const lastCompletedPaSession = history
    .filter((e): e is PaSessionHistoryEvent => e.type === "pa-session" && e.status !== "running")
    .sort((a, b) => ((a.completedAt ?? a.startedAt) < (b.completedAt ?? b.startedAt) ? 1 : -1))[0];

  // True "nothing's ever happened here" guard: the workspace has zero
  // history events AND no pending review/document/loop state. Until
  // now this only checked the three non-interactive states; PA sessions
  // counted as "nothing has run" because they only show up in History.
  const trulyEmpty =
    !loopState && !reviewState && !documentState && history.length === 0;
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
        const events = await fetchHistory(workspaceId);
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
          if (logFile) {
            // Guard against the new optional logFile (loop-stopped + future
            // user-action events lack a log). targetType filter above only
            // matches review/document/iteration which always set logFile,
            // so this is belt-and-suspenders for type narrowing.
            setLogTarget({ workspaceId, logFile, label });
            setActiveTab("logs");
          }
        }
      }, 500);
    }
  };

  if (workspaceError && !workspace) {
    return <div className="project-detail__error">Workspace not found: {workspaceError}</div>;
  }
  if (!workspace) {
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
      : currentPhase || workspace.status;

  return (
    <div className="project-detail">
      <div className="project-detail__header">
        <button className="btn btn--link" onClick={() => navigateTo("/")}>
          &larr; Workspaces
        </button>
        <h2>{workspace.name}</h2>
        <StatusBadge status={headerBadgeStatus} />
        {isReviewActive && <span className="project-detail__active-tag">review running</span>}
        {isDocumentActive && <span className="project-detail__active-tag">document running</span>}
      </div>

      <LoopControls
        workspaceId={workspace.id}
        phase={currentPhase}
        activeAgent={activeAgent}
        onAction={handleAgentAction}
        autoReviewSpecs={workspace.autoReviewSpecs}
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
          autoReviewSpecs={workspace.autoReviewSpecs}
          autoDocumenter={workspace.autoDocumenter}
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
          workspaceId={workspace.id}
          questions={loopState?.pendingQuestions}
          pauseReason={loopState?.pauseReason}
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
                  <span>Agent: {workspace.architectAgent.adapter}</span>
                </div>
              </div>
            )}
            {isDocumentActive && documentState && (
              <div className="status-panel__section">
                <h3>Document in progress</h3>
                <div className="status-panel__info">
                  <span>Started: {new Date(documentState.startedAt).toLocaleTimeString()}</span>
                  <span>Agent: {workspace.documenterAgent.adapter}</span>
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
            {activePaSessions.length > 0 && (
              <div className="status-panel__section">
                <h3>
                  Product Architect session{activePaSessions.length === 1 ? "" : "s"} active
                  <span
                    className="status-panel__timestamp"
                    style={{ fontWeight: 400, fontSize: "0.8rem", marginLeft: "0.5rem", color: "var(--color-info)" }}
                  >
                    (interactive — runs in the user's terminal)
                  </span>
                </h3>
                <ul className="status-panel__info" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {activePaSessions.map((s) => (
                    <li key={s.id} style={{ marginBottom: "0.4rem" }}>
                      <button
                        type="button"
                        onClick={() => setActiveTab("history")}
                        style={{
                          background: "none",
                          border: "none",
                          padding: 0,
                          color: "var(--color-primary-hover)",
                          cursor: "pointer",
                          fontFamily: "inherit",
                          fontSize: "inherit",
                          textDecoration: "underline",
                        }}
                        title="Click to jump to the History tab"
                      >
                        Session <code>{s.sessionId}</code>
                      </button>
                      {" — agent "}{s.agent}{s.model ? `:${s.model}` : ""}
                      {" — started "}{new Date(s.startedAt).toLocaleString()}
                      {" — running for "}{formatDurationSinceStart(s.startedAt)}
                    </li>
                  ))}
                </ul>
                <p style={{ fontSize: "0.85rem", color: "var(--color-text-muted)", marginTop: "0.6rem" }}>
                  PA sessions write turn-by-turn to the user's local <code>.cfcf-pa/</code>; they're
                  unaffected by server restarts. To view full session detail (scratchpad, workspace
                  summary, meta.json), open the row in the History tab.
                </p>
              </div>
            )}
            {activePaSessions.length === 0 && lastCompletedPaSession && !loopState && !reviewState && !documentState && (
              <div className="status-panel__section">
                <h3>
                  Last Product Architect session
                  {lastCompletedPaSession.completedAt && (
                    <span
                      className="status-panel__timestamp"
                      style={{ fontWeight: 400, fontSize: "0.8rem", marginLeft: "0.5rem" }}
                    >
                      ({new Date(lastCompletedPaSession.completedAt).toLocaleString()})
                    </span>
                  )}
                </h3>
                <div className="status-panel__info">
                  <span>Status: {lastCompletedPaSession.status}</span>
                  {lastCompletedPaSession.outcomeSummary && (
                    <span>Outcome: {lastCompletedPaSession.outcomeSummary}</span>
                  )}
                  {typeof lastCompletedPaSession.decisionsCount === "number" && lastCompletedPaSession.decisionsCount > 0 && (
                    <span>Decisions captured: {lastCompletedPaSession.decisionsCount}</span>
                  )}
                </div>
              </div>
            )}
            {trulyEmpty && (
              <div className="status-panel__empty">
                Nothing has run yet. Click <strong>Review</strong> or <strong>Start Loop</strong> to
                begin, or run <code>cfcf spec</code> in this workspace's repo to launch the Product
                Architect for interactive Problem Pack authoring.
              </div>
            )}
          </div>
        </div>

        <div style={{ display: activeTab === "history" ? "block" : "none" }}>
          <WorkspaceHistory
            events={history}
            workspaceId={workspace.id}
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
          <ConfigDisplay workspace={workspace} onSaved={(w) => setWorkspace(w)} />
        </div>
      </div>
    </div>
  );
}

/**
 * Compact "running for Xm Ys" summary for a PA session whose endedAt
 * is unknown (still running). Updates each render — the parent
 * polls history every few seconds, which is enough granularity for
 * an interactive session.
 */
function formatDurationSinceStart(startedAt: string): string {
  try {
    const ms = Date.now() - new Date(startedAt).getTime();
    if (Number.isNaN(ms) || ms < 0) return "—";
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    return `${hr}h ${min % 60}m`;
  } catch {
    return "—";
  }
}
