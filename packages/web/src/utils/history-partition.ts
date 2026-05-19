/**
 * Partition workspace-history events into interactive-agent events
 * (PA today, HA when it gets a history-event type) and everything
 * else (the loop's events: iteration, review, document, reflection,
 * loop-stopped).
 *
 * Rationale: PA sessions can run for hours or days. In a single
 * chronological list, an active long-running PA's row gets pushed
 * deep into the stack as iteration events accumulate above it,
 * making the "PA is alive right now" signal hard to scan for.
 *
 * The two surfaces serve different mental models:
 *   - Interactive agents: a stable, mostly-empty surface where
 *     short-and-medium-cardinality PA/HA history lives. Active
 *     sessions naturally appear at the top because they're the
 *     newest.
 *   - Loop history: the chronological audit trail of automated
 *     iteration work. Unchanged by this partition.
 *
 * Every event has exactly ONE permanent home — events do NOT move
 * between sections based on status. A terminated PA stays in the
 * Interactive section (just with `status: "completed"`). This
 * preserves history fidelity: nothing disappears or relocates.
 *
 * Both arrays come back sorted newest-first (descending by
 * `startedAt`), matching the existing single-list behaviour.
 */

import type { HistoryEvent } from "../types";

/**
 * Event types that belong to the interactive-agents section. Today
 * only PA writes history events; HA is ephemeral. When HA grows a
 * history-event type, add it here.
 */
export const INTERACTIVE_EVENT_TYPES: ReadonlySet<HistoryEvent["type"]> = new Set([
  "pa-session",
]);

export interface PartitionedHistory {
  /** PA + HA events, newest-first. */
  interactive: HistoryEvent[];
  /** Iteration / review / document / reflection / loop-stopped events, newest-first. */
  loop: HistoryEvent[];
}

export function partitionInteractiveEvents(events: HistoryEvent[]): PartitionedHistory {
  const interactive: HistoryEvent[] = [];
  const loop: HistoryEvent[] = [];
  for (const e of events) {
    if (INTERACTIVE_EVENT_TYPES.has(e.type)) {
      interactive.push(e);
    } else {
      loop.push(e);
    }
  }
  const byStartedDesc = (a: HistoryEvent, b: HistoryEvent) =>
    new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
  interactive.sort(byStartedDesc);
  loop.sort(byStartedDesc);
  return { interactive, loop };
}
