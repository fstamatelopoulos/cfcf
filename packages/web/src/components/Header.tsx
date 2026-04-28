import { useState, useEffect } from "react";
import { fetchHealth, fetchActivity, type ActivityItem } from "../api";
import type { HealthResponse } from "../types";
import { navigateTo } from "../hooks/useRoute";

/**
 * Label the current iteration phase in a compact, human-readable form.
 * "dev_executing" -> "dev", "documenting" -> "document", etc. Matches
 * PhaseIndicator's loop-phase labels but shortened for the top bar.
 */
const phaseLabel: Record<string, string> = {
  pre_loop_reviewing: "review",
  preparing: "prepare",
  dev_executing: "dev",
  judging: "judge",
  reflecting: "reflect",
  deciding: "decide",
  documenting: "document",
};

function activityCaption(a: ActivityItem): string {
  switch (a.type) {
    case "iteration": {
      const step = a.phase ? phaseLabel[a.phase] ?? a.phase : "running";
      const iter = a.iteration ? ` #${a.iteration}` : "";
      return `${a.workspaceName}: ${step}${iter}`;
    }
    case "review":
      return `${a.workspaceName}: review`;
    case "document":
      return `${a.workspaceName}: document`;
    case "reflection": {
      const iter = a.iteration ? ` #${a.iteration}` : "";
      return `${a.workspaceName}: reflect${iter}`;
    }
  }
}

export function Header() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);

  const anyActive = activity.length > 0;

  useEffect(() => {
    const tick = () => {
      fetchHealth().then(setHealth).catch(() => setHealth(null));
      fetchActivity()
        .then((res) => setActivity(res.active))
        .catch(() => setActivity([]));
    };
    tick();
    // Poll faster (3s) while something is running, slower (10s) when idle.
    // The effect re-runs when `anyActive` flips because it's in the deps
    // list -- React reinstalls the interval at the new rate.
    const id = setInterval(tick, anyActive ? 3000 : 10000);
    return () => clearInterval(id);
  }, [anyActive]);

  return (
    <header className="header">
      <a className="header__logo" href="#/" onClick={() => navigateTo("/")}>
        cf<sup>2</sup>
      </a>
      <span className="header__title">Cerefox Code Factory</span>
      <nav className="header__nav">
        <a
          href="#/"
          onClick={(e) => {
            e.preventDefault();
            navigateTo("/");
          }}
        >
          Workspaces
        </a>
        <a
          href="#/server"
          onClick={(e) => {
            e.preventDefault();
            navigateTo("/server");
          }}
        >
          Settings
        </a>
        <a
          href="#/help"
          onClick={(e) => {
            e.preventDefault();
            navigateTo("/help");
          }}
        >
          Help
        </a>
      </nav>
      {anyActive && (
        <span className="header__activity" title="Click to open the active workspace">
          <span className="status-dot status-dot--active" />
          <span className="header__activity-label">
            {activity.length === 1
              ? activityCaption(activity[0])
              : `${activity.length} agents running`}
          </span>
        </span>
      )}
      <span className="header__status">
        {health ? (
          <>
            <span className="status-dot status-dot--ok" />
            v{health.version}
          </>
        ) : (
          <>
            <span className="status-dot status-dot--error" />
            disconnected
          </>
        )}
      </span>
    </header>
  );
}
