/**
 * Non-destructive plan.md rewrite validation.
 *
 * cfcf lets two roles rewrite the pending portion of cfcf-docs/plan.md:
 *   - The Reflection role (every iteration, strategic review)
 *   - The Architect role (on re-review of an existing project)
 *
 * Both must preserve the user's audit trail: completed items (`[x]`) and
 * iteration headers (`## Iteration N`) cannot be deleted or silently
 * rewritten away. This module centralises the rule so both runners apply
 * it identically (research doc §6.3).
 *
 * Pure function, no I/O; callers snapshot + revert plan.md on their own.
 */

export type PlanValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

/**
 * Check whether a plan rewrite preserves the user's completed-work audit
 * trail. Allows: adding new iterations, reordering pending items,
 * retitling iteration headers, refining pending items. Forbids: dropping
 * any completed item or any iteration header number present in the old
 * plan.
 */
export function validatePlanRewrite(
  oldPlan: string,
  newPlan: string,
): PlanValidationResult {
  if (!newPlan || newPlan.trim().length === 0) {
    return { valid: false, reason: "new plan is empty" };
  }
  const oldCompleted = extractCompletedItems(oldPlan);
  const newCompleted = extractCompletedItems(newPlan);
  for (const item of oldCompleted) {
    if (!newCompleted.has(item)) {
      return { valid: false, reason: `completed item removed: "${item}"` };
    }
  }
  const oldHeaders = extractIterationHeaders(oldPlan);
  const newHeaders = extractIterationHeaders(newPlan);
  for (const h of oldHeaders) {
    if (!newHeaders.has(h)) {
      return { valid: false, reason: `iteration header removed: "${h}"` };
    }
  }
  return { valid: true };
}

/**
 * Extract the texts of completed items (`- [x] <text>`). Trailing "-- "
 * annotations added by dev agents are stripped so the identity is the
 * original item text, not the per-iteration note.
 */
export function extractCompletedItems(plan: string): Set<string> {
  const out = new Set<string>();
  const re = /^\s*-\s*\[x\]\s+(.+?)\s*$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(plan)) !== null) {
    const text = m[1].split(/\s+--\s+/)[0].trim();
    if (text.length > 0) out.add(text);
  }
  return out;
}

/**
 * Extract iteration-header numbers (`## Iteration N`). Number is the
 * identity; the agent may rename the title (`## Iteration 2 -- Core`
 * → `## Iteration 2 -- Core (extended)`).
 */
export function extractIterationHeaders(plan: string): Set<string> {
  const out = new Set<string>();
  const re = /^##\s+Iteration\s+(\d+)\b/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(plan)) !== null) {
    out.add(m[1]);
  }
  return out;
}

/**
 * Helper: does this plan have any completed items? Used to detect whether
 * a re-review (vs. first-run) is appropriate for the Architect role.
 */
export function planHasCompletedItems(plan: string): boolean {
  return extractCompletedItems(plan).size > 0;
}
