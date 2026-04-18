/**
 * useElapsed -- ticks every second and returns a formatted elapsed-time
 * string for a running agent run.
 *
 * - If `startedAt` is missing, returns `null`.
 * - If `isRunning` is false, freezes at `completedAt` (or at the current
 *   time if completedAt is not yet set). Stops the interval.
 * - If `isRunning` is true, re-renders every 1000ms using Date.now().
 *
 * No server calls, no polling. Purely local ticking.
 */

import { useEffect, useState } from "react";
import { formatDuration } from "../utils/time";

export function useElapsed(
  startedAt: string | undefined,
  isRunning: boolean,
  completedAt?: string,
): string | null {
  // Bump to force a re-render. We don't read it; it's just a trigger.
  const [, bump] = useState(0);

  useEffect(() => {
    if (!isRunning || !startedAt) return;
    const id = setInterval(() => bump((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [isRunning, startedAt]);

  if (!startedAt) return null;
  return formatDuration(startedAt, isRunning ? undefined : completedAt);
}
