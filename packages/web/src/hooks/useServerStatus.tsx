/**
 * Shared periodic poll for server-side state that the chrome (Header,
 * UpdateBanner) needs (item 6.20 follow-up).
 *
 * Before this hook each consumer ran its own `setInterval` -- Header
 * polled health + activity, UpdateBanner polled update-status -- which
 * doubled the request rate and made cadence drift between components.
 *
 * One tick per cycle; cadence accelerates (3 s) when any agent is
 * running and idles (10 s) otherwise. Update-status piggybacks on the
 * same cycle: a tiny 204 most of the time, no extra request budget.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  fetchActivity,
  fetchHealth,
  fetchUpdateStatus,
  type ActivityItem,
  type UpdateStatus,
} from "../api";
import type { HealthResponse } from "../types";

interface ServerStatus {
  health: HealthResponse | null;
  activity: ActivityItem[];
  updateStatus: UpdateStatus | null;
}

const ServerStatusContext = createContext<ServerStatus>({
  health: null,
  activity: [],
  updateStatus: null,
});

export function ServerStatusProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ServerStatus>({
    health: null,
    activity: [],
    updateStatus: null,
  });
  const anyActive = state.activity.length > 0;

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const [h, a, u] = await Promise.allSettled([
        fetchHealth(),
        fetchActivity(),
        fetchUpdateStatus(),
      ]);
      if (cancelled) return;
      setState({
        health: h.status === "fulfilled" ? h.value : null,
        activity: a.status === "fulfilled" ? a.value.active : [],
        updateStatus: u.status === "fulfilled" ? u.value : null,
      });
    };
    tick();
    // Same accelerate-while-active cadence the Header used pre-fold.
    const id = setInterval(tick, anyActive ? 3000 : 10000);
    return () => { cancelled = true; clearInterval(id); };
  }, [anyActive]);

  return (
    <ServerStatusContext.Provider value={state}>
      {children}
    </ServerStatusContext.Provider>
  );
}

export function useServerStatus(): ServerStatus {
  return useContext(ServerStatusContext);
}
