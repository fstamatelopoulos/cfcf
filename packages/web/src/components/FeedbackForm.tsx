import { useState } from "react";
import * as api from "../api";
import type { ResumeAction } from "../api";
import type { LoopState } from "../types";

/**
 * Resume-action matrix (item 6.25 — see
 * docs/research/structured-pause-actions-design.md).
 *
 * Mirrors `pauseReasonAllowedActions` in
 * `packages/core/src/iteration-loop.ts`. Keep the two in sync.
 *
 * v1 doesn't read additional signals to disambiguate sub-cases (e.g.
 * dev-mid-iter A2 vs judge-needs-input A3 within `user_input_needed`).
 * The web superset is permissive; the server-side resumeLoop()
 * validation will reject inapplicable picks if a sub-case constraint
 * is violated.
 */
function pauseReasonAllowedActions(pauseReason: LoopState["pauseReason"]): ResumeAction[] {
  switch (pauseReason) {
    case "user_input_needed":
      return ["continue", "finish_loop", "stop_loop_now", "refine_plan", "consult_reflection"];
    case "anomaly":
      return ["continue", "finish_loop", "stop_loop_now", "refine_plan", "consult_reflection"];
    case "cadence":
      return ["continue", "finish_loop", "stop_loop_now", "refine_plan", "consult_reflection"];
    case "max_iterations":
      return ["finish_loop", "stop_loop_now"];
    case "scope_complete":
      // Architect SCOPE_COMPLETE (item 6.25 follow-up): no work to build,
      // no iterations to reflect on. finish_loop runs documenter if
      // configured; stop_loop_now accepts "project done"; refine_plan
      // re-runs the architect after the user adds new requirements.
      return ["finish_loop", "stop_loop_now", "refine_plan"];
    default:
      // Pre-loop review block (A1)
      return ["continue", "stop_loop_now", "refine_plan"];
  }
}

const ACTION_LABEL: Record<ResumeAction, string> = {
  continue: "Continue",
  finish_loop: "Finish loop",
  stop_loop_now: "Stop loop now",
  refine_plan: "Refine plan",
  consult_reflection: "Ask Reflection to decide",
};

const ACTION_HELP: Record<ResumeAction, string> = {
  continue:
    "Run the next iteration with the feedback above as guidance for the dev agent.",
  finish_loop:
    "End the loop on a successful note. Documenter runs if your config has autoDocumenter=true.",
  stop_loop_now:
    "Terminate immediately. No documenter regardless of config. Feedback (if any) is captured to the audit history.",
  refine_plan:
    "Run the architect (synchronously) with your feedback to update the plan, then continue with the next iteration.",
  consult_reflection:
    "Spawn reflection with your feedback as input. Reflection decides what the harness does next (continue / finish / stop / re-pause).",
};

export function FeedbackForm({
  workspaceId,
  questions,
  pauseReason,
  onResume,
}: {
  workspaceId: string;
  questions?: string[];
  pauseReason?: LoopState["pauseReason"];
  onResume: () => void;
}) {
  const [feedback, setFeedback] = useState("");
  const [loading, setLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<ResumeAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const allowedActions = pauseReasonAllowedActions(pauseReason);

  async function handleAction(action: ResumeAction) {
    setLoading(true);
    setPendingAction(action);
    setError(null);
    try {
      await api.resumeLoop(workspaceId, feedback || undefined, action);
      setFeedback("");
      onResume();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setPendingAction(null);
    }
  }

  return (
    <div className="feedback-form">
      {questions && questions.length > 0 && (
        <div className="feedback-form__questions">
          <h4>Questions needing your input:</h4>
          <ul>
            {questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      )}
      <textarea
        className="feedback-form__input"
        placeholder="Optional context for the next agent (or audit note for Stop loop now)..."
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        rows={3}
      />
      <div className="feedback-form__actions" style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "0.5rem" }}>
        {allowedActions.map((action) => (
          <button
            key={action}
            className={
              "btn " +
              (action === "stop_loop_now"
                ? "btn--danger"
                : action === "continue"
                  ? "btn--primary"
                  : "btn--secondary")
            }
            onClick={() => handleAction(action)}
            disabled={loading}
            title={ACTION_HELP[action]}
          >
            {pendingAction === action ? `${ACTION_LABEL[action]}…` : ACTION_LABEL[action]}
          </button>
        ))}
      </div>
      <p
        style={{
          marginTop: "0.5rem",
          marginBottom: 0,
          fontSize: "0.75rem",
          color: "var(--color-text-muted, #888)",
          lineHeight: 1.4,
        }}
      >
        Hover any button for what it does. The textarea is optional; the action button you click decides what the harness does next.
      </p>
      {error && <div className="feedback-form__error">{error}</div>}
    </div>
  );
}
