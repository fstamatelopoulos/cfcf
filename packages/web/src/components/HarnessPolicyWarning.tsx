/**
 * Two related callouts surfaced when adapter choices for unattended roles
 * trigger known concerns (item 6.28):
 *
 *   1. **Yellow / policy-grade** — `claude-code` (direct, talking to
 *      Anthropic's API/subscription) on an unattended role. Anthropic's
 *      third-party-harness policy restricts subscription OAuth to
 *      interactive use; the unattended cf² loop is the violation
 *      pattern.
 *   2. **Blue / log-visibility** — `claude-code-ollama` on an unattended
 *      role. The ollama path is policy-clean (no Anthropic credential
 *      involved), but `claude -p` still buffers stdout for the entire
 *      run regardless of the model — log files stay silent during the
 *      run and dump the final response only when the agent exits. This
 *      is a UX caveat, not a correctness issue.
 *
 * PA / HA / manually-invoked SA do NOT trigger either callout — they're
 * within Anthropic's allowed-interactive scope and live progress is
 * visible in the user's TUI.
 *
 * Both callouts are informational, not blocking — the user can save
 * the config; the callouts are there so they don't pick a problematic
 * combo by accident. Wording mirrors the CLI banner from
 * `cfcf init` (kept in sync — see `packages/cli/src/commands/init.ts`).
 *
 * Why this lives in `packages/web/` rather than importing the
 * constants from `@cfcf/core`: the web app is a Vite + React build
 * that doesn't import from the core workspace package directly. The
 * adapter-name constants + role list are short enough to inline here;
 * both surfaces reference `docs/guides/anthropic-policy.md` as the
 * canonical long-form explanation so the wording is anchored even if
 * the duplicated strings drift slightly over time.
 */

const POLICY_GUIDE_HREF = "https://github.com/fstamatelopoulos/cfcf/blob/main/docs/guides/anthropic-policy.md";

interface RoleAdapterPair {
  /** Human-readable role name for the callout display. */
  label: string;
  /** Currently-picked adapter name. */
  adapter: string;
}

/** Roles that have `claude-code` (direct) — policy violation when unattended. */
function findPolicyRiskyRoles(pairs: RoleAdapterPair[]): string[] {
  return pairs.filter((p) => p.adapter === "claude-code").map((p) => p.label);
}

/**
 * Roles that have `claude-code-ollama` — log-visibility caveat (policy-clean
 * but `-p` buffers stdout). Surfaced as a softer info callout.
 */
function findLogBufferingRoles(pairs: RoleAdapterPair[]): string[] {
  return pairs.filter((p) => p.adapter === "claude-code-ollama").map((p) => p.label);
}

export function HarnessPolicyWarning({
  /**
   * Role-adapter pairs to evaluate. Caller decides which ones are
   * "unattended" (typically dev / judge / reflection / documenter,
   * plus architect when autoReviewSpecs=true). PA / HA / manual SA
   * should NOT be passed in here since they're within Anthropic's
   * allowed-interactive scope and don't have the buffering issue
   * (the TUI shows live progress).
   */
  unattendedRoles,
}: {
  unattendedRoles: RoleAdapterPair[];
}) {
  const policyRoles = findPolicyRiskyRoles(unattendedRoles);
  const bufferingRoles = findLogBufferingRoles(unattendedRoles);
  if (policyRoles.length === 0 && bufferingRoles.length === 0) return null;

  return (
    <>
      {policyRoles.length > 0 && (
        <div
          style={{
            marginTop: "0.75rem",
            padding: "0.75rem 1rem",
            background: "color-mix(in srgb, var(--color-warning, #c8861a) 12%, transparent)",
            borderLeft: "3px solid var(--color-warning, #c8861a)",
            color: "var(--color-text)",
            fontSize: "var(--text-sm)",
            borderRadius: "4px",
            lineHeight: 1.5,
          }}
          role="alert"
        >
          <strong style={{ display: "block", marginBottom: "0.25rem" }}>
            ⚠ Anthropic third-party-harness policy notice
          </strong>
          <div style={{ marginBottom: "0.5rem" }}>
            Anthropic's third-party-harness policy prohibits using Claude Code
            subscriptions in unattended/headless contexts (the cf² iteration
            loop is exactly that pattern). For limited testing only — do not
            use for production.
          </div>
          <div style={{ marginBottom: "0.5rem" }}>
            Affected role{policyRoles.length > 1 ? "s" : ""}:{" "}
            {policyRoles.map((role, i) => (
              <span key={role}>
                {i > 0 && ", "}
                <code>{role}</code>
              </span>
            ))}
          </div>
          <div>
            Compliant alternatives for unattended roles: <code>codex</code>,{" "}
            <code>claude-code-ollama</code>, <code>opencode-ollama</code>,{" "}
            <code>opencode</code>. See{" "}
            <a
              href={POLICY_GUIDE_HREF}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--color-info)" }}
            >
              docs/guides/anthropic-policy.md
            </a>{" "}
            for the full breakdown.
          </div>
        </div>
      )}

      {bufferingRoles.length > 0 && (
        <div
          style={{
            marginTop: "0.75rem",
            padding: "0.75rem 1rem",
            background: "color-mix(in srgb, var(--color-info, #4a8ee6) 10%, transparent)",
            borderLeft: "3px solid var(--color-info, #4a8ee6)",
            color: "var(--color-text)",
            fontSize: "var(--text-sm)",
            borderRadius: "4px",
            lineHeight: 1.5,
          }}
          role="status"
        >
          <strong style={{ display: "block", marginBottom: "0.25rem" }}>
            ℹ Log-visibility note: claude-code-ollama buffers during the run
          </strong>
          <div style={{ marginBottom: "0.5rem" }}>
            <code>claude-code-ollama</code> is policy-clean (no Anthropic
            credential involved — local ollama serves the model), but{" "}
            <code>claude -p</code> still buffers stdout for the entire run
            regardless of which model is behind it. The iteration log file
            stays empty during the run and dumps the final response only
            when the agent exits. This is a UX caveat, not a correctness
            issue.
          </div>
          <div style={{ marginBottom: "0.5rem" }}>
            Affected role{bufferingRoles.length > 1 ? "s" : ""}:{" "}
            {bufferingRoles.map((role, i) => (
              <span key={role}>
                {i > 0 && ", "}
                <code>{role}</code>
              </span>
            ))}
          </div>
          <div>
            For live progress in the log file, prefer <code>codex</code> (streams
            natively in <code>exec</code> mode) or the opencode adapters.
            Keep <code>claude-code-ollama</code> if you specifically prefer
            Claude's tool-call format and don't need live monitoring. See{" "}
            <a
              href={POLICY_GUIDE_HREF}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--color-info)" }}
            >
              docs/guides/anthropic-policy.md
            </a>{" "}
            (§ Log visibility during unattended runs).
          </div>
        </div>
      )}
    </>
  );
}
