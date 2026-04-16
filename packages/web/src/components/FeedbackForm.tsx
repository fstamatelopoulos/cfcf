import { useState } from "react";
import * as api from "../api";

export function FeedbackForm({
  projectId,
  questions,
  onResume,
}: {
  projectId: string;
  questions?: string[];
  onResume: () => void;
}) {
  const [feedback, setFeedback] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleResume() {
    setLoading(true);
    setError(null);
    try {
      await api.resumeLoop(projectId, feedback || undefined);
      setFeedback("");
      onResume();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
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
        placeholder="Provide feedback or direction for the next iteration (optional)..."
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        rows={3}
      />
      <div className="feedback-form__actions">
        <button
          className="btn btn--primary"
          onClick={handleResume}
          disabled={loading}
        >
          {loading ? "Resuming..." : feedback ? "Resume with Feedback" : "Resume"}
        </button>
      </div>
      {error && <div className="feedback-form__error">{error}</div>}
    </div>
  );
}
