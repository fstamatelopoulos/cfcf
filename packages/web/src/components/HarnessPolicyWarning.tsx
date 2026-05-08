/**
 * Anthropic third-party-harness policy warning callout (item 6.28).
 *
 * Surfaces when `claude-code` is picked for any unattended role
 * (dev / judge / reflection / documenter, plus architect when
 * autoReviewSpecs=true). PA / HA / manually-invoked SA do NOT trigger
 * the warning — within Anthropic's allowed-interactive scope.
 *
 * The warning is informational, not blocking — the user can save this
 * config; the warning is there so they don't pick claude-code for
 * unattended roles by accident. Wording mirrors the CLI banner from
 * `cfcf init` so users see the same text in both surfaces.
 *
 * Why this lives in `packages/web/` rather than importing the
 * constants from `@cfcf/core`: the web app is a Vite + React build
 * that doesn't import from the core workspace package directly. The
 * harness-risk role list + warning text are short enough to inline
 * here and the wording is duplicated with the CLI banner in
 * `packages/cli/src/commands/init.ts` — both reference
 * `docs/guides/anthropic-policy.md` as the canonical long-form
 * explanation, so the wording is anchored even if the duplicated
 * strings drift slightly over time.
 */

const POLICY_GUIDE_HREF = "https://github.com/fstamatelopoulos/cfcf/blob/main/docs/guides/anthropic-policy.md";

interface RoleAdapterPair {
  /** Human-readable role name for the warning display. */
  label: string;
  /** Currently-picked adapter name. */
  adapter: string;
}

/**
 * Filters a set of role-adapter pairs down to those at risk
 * (claude-code on an unattended role). Returns the labels of the
 * affected roles so the caller can build a contextual warning.
 */
function findRiskyRoles(pairs: RoleAdapterPair[]): string[] {
  return pairs.filter((p) => p.adapter === "claude-code").map((p) => p.label);
}

export function HarnessPolicyWarning({
  /**
   * Role-adapter pairs to evaluate. Caller decides which ones are
   * "unattended" (typically dev / judge / reflection / documenter,
   * plus architect when autoReviewSpecs=true). PA / HA / manual SA
   * should NOT be passed in here since they're within Anthropic's
   * allowed-interactive scope.
   */
  unattendedRoles,
}: {
  unattendedRoles: RoleAdapterPair[];
}) {
  const riskyRoles = findRiskyRoles(unattendedRoles);
  if (riskyRoles.length === 0) return null;

  return (
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
        subscriptions in unattended/headless contexts (the cfcf iteration loop
        is exactly that pattern). For limited testing only — do not use for
        production.
      </div>
      <div style={{ marginBottom: "0.5rem" }}>
        Affected role{riskyRoles.length > 1 ? "s" : ""}:{" "}
        {riskyRoles.map((role, i) => (
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
  );
}
