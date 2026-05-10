/**
 * Three related callouts surfaced when adapter choices for unattended
 * roles trigger known concerns (items 6.28 + 6.30):
 *
 *   1. **Yellow / policy-grade** — `claude-code` (direct, talking to
 *      Anthropic's API/subscription) on an unattended role. Anthropic's
 *      third-party-harness policy restricts subscription OAuth to
 *      interactive use; the unattended cf² loop is the violation
 *      pattern. **Also surfaced inline** in the role table as a ⚠
 *      next to the offending row's adapter selector — see
 *      `isPolicyRiskyRow` (exported for that consumer).
 *   2. **Blue / API-parse-error** — `claude-code-ollama` on an
 *      unattended role. claude-code-ollama uses Anthropic's strict
 *      Messages API parser on top of ollama's model output. Some
 *      non-coder-tuned local models (e.g. gemma4:31b) produce
 *      tool-use / tool-result content blocks the parser rejects with
 *      `API Error: Content block not found`. Coder-tuned models
 *      (qwen3-coder, deepseek-coder) work fine; the OpenAI-compatible
 *      endpoint via `opencode-ollama` is the recommended fall-back
 *      for the same model when this combination fails. (item 6.30)
 *   3. **Blue / log-visibility** — `claude-code-ollama` on an unattended
 *      role. The ollama path is policy-clean (no Anthropic credential
 *      involved), but `claude -p` still buffers stdout for the entire
 *      run regardless of the model — log files stay silent during the
 *      run and dump the final response only when the agent exits. This
 *      is a UX caveat, not a correctness issue.
 *
 * PA / HA / manually-invoked SA via `cfcf review` do NOT trigger any
 * callout — they take over the user's TUI directly, which Anthropic's
 * policy permits and where buffering doesn't bite (live TUI output).
 * Note that **architect IS counted as unattended here** because the
 * loop invokes it on `refine_plan` resume actions and on judge
 * NEEDS_REFINEMENT verdicts as well as the pre-loop autoReviewSpecs
 * path; the same adapter setting drives all three loop paths AND the
 * manual `cfcf review` path, so we have to warn for the worst case.
 *
 * All callouts are informational, not blocking — the user can save
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

/**
 * Per-row predicate: does this (role, adapter) pair trigger the
 * yellow policy-grade callout? Exported so the table can render an
 * inline ⚠ next to the offending row's adapter selector — visual
 * link between the row and the callout below the table.
 */
export function isPolicyRiskyRow(adapter: string): boolean {
  return adapter === "claude-code";
}

/**
 * Per-row predicate: does this (role, adapter) pair trigger the blue
 * API-parse-error info callout? Exported for symmetry with
 * isPolicyRiskyRow but currently NOT surfaced inline (the failure is
 * model-specific, not adapter-wide; an inline indicator would be a
 * false positive on the qwen3-coder + claude-code-ollama path which
 * works fine).
 */
export function isApiParseRiskRow(adapter: string): boolean {
  return adapter === "claude-code-ollama";
}

/** Roles that have `claude-code` (direct) — policy violation when unattended. */
function findPolicyRiskyRoles(pairs: RoleAdapterPair[]): string[] {
  return pairs.filter((p) => isPolicyRiskyRow(p.adapter)).map((p) => p.label);
}

/**
 * Roles on `claude-code-ollama` — surfaced for both the API-parse-error
 * callout AND the log-visibility callout, since both apply to the same
 * adapter (different concerns: parse-error is model-specific, log
 * buffering is universal for `claude -p`).
 */
function findClaudeOllamaRoles(pairs: RoleAdapterPair[]): string[] {
  return pairs.filter((p) => isApiParseRiskRow(p.adapter)).map((p) => p.label);
}

export function HarnessPolicyWarning({
  /**
   * Role-adapter pairs to evaluate. Caller decides which ones are
   * "unattended" — for cfcf this is dev / judge / reflection /
   * documenter / architect (architect is always counted because the
   * loop invokes it unattended on refine_plan + NEEDS_REFINEMENT).
   * PA / HA / manual SA via `cfcf review` should NOT be passed in
   * since they're within Anthropic's allowed-interactive scope and
   * don't have the buffering / parse issues (the TUI shows live
   * progress and the agent isn't being orchestrated headlessly).
   */
  unattendedRoles,
}: {
  unattendedRoles: RoleAdapterPair[];
}) {
  const policyRoles = findPolicyRiskyRoles(unattendedRoles);
  // Same set drives the API-parse-error callout AND the log-visibility
  // callout — both apply to claude-code-ollama on unattended roles.
  const claudeOllamaRoles = findClaudeOllamaRoles(unattendedRoles);
  if (policyRoles.length === 0 && claudeOllamaRoles.length === 0) return null;

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
            Anthropic's third-party-harness policy prohibits using a Claude
            Pro/Max <strong>subscription</strong> OAuth credential in
            unattended/headless contexts (the cf² iteration loop is exactly
            that pattern). The <strong>API-key path is exempt</strong> — set{" "}
            <code>ANTHROPIC_API_KEY</code> in your environment and{" "}
            <code>claude-code</code> authenticates via the paid Anthropic API
            instead of your subscription. That's the compliant way to run{" "}
            <code>claude-code</code> on unattended roles.
          </div>
          <div style={{ marginBottom: "0.5rem" }}>
            Affected role{policyRoles.length > 1 ? "s" : ""} (subscription
            OAuth path): {policyRoles.map((role, i) => (
              <span key={role}>
                {i > 0 && ", "}
                <code>{role}</code>
              </span>
            ))}
          </div>
          <div>
            For subscription OAuth, this is for limited testing only.
            Compliant alternatives: keep <code>claude-code</code> + set{" "}
            <code>ANTHROPIC_API_KEY</code>, or switch to <code>codex</code>,{" "}
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

      {claudeOllamaRoles.length > 0 && (
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
            ℹ API parse errors observed with some ollama models on
            claude-code-ollama (May 2026)
          </strong>
          <div style={{ marginBottom: "0.5rem" }}>
            <code>claude-code-ollama</code> uses Anthropic's strict Messages
            API parser on top of ollama's model output. Some
            non-coder-tuned local models (notably <code>gemma4:31b</code>)
            produce tool-use / tool-result content blocks the parser
            rejects with <code>API Error: Content block not found</code>,
            and the run exits with no files written. Coder-tuned models
            (<code>qwen3-coder</code>, <code>deepseek-coder</code>) work
            fine.
          </div>
          <div style={{ marginBottom: "0.5rem" }}>
            If you hit this error, switch to <code>opencode-ollama</code>{" "}
            for the same model — its OpenAI-compatible endpoint is more
            tolerant of variance in tool-call output. The model itself is
            usually capable; it's the strict-Anthropic-shape translation
            that rejects it.
          </div>
          <div style={{ marginBottom: "0.5rem" }}>
            <strong>Applies to any unattended role on{" "}
            <code>claude-code-ollama</code></strong> (<code>dev</code>,{" "}
            <code>judge</code>, <code>reflection</code>,{" "}
            <code>documenter</code>, <code>architect</code>). PA and HA are
            unaffected — they run interactively in your terminal, so you
            see output live as the agent works.
          </div>
          <div style={{ marginBottom: "0.5rem" }}>
            Currently configured for: {claudeOllamaRoles.map((role, i) => (
              <span key={role}>
                {i > 0 && ", "}
                <code>{role}</code>
              </span>
            ))}.
          </div>
        </div>
      )}

      {claudeOllamaRoles.length > 0 && (
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
            <strong>Applies to any unattended role on{" "}
            <code>claude-code-ollama</code></strong> (<code>dev</code>,{" "}
            <code>judge</code>, <code>reflection</code>,{" "}
            <code>documenter</code>, <code>architect</code>). PA and HA are
            unaffected — they run interactively in your terminal, so you
            see output live as the agent works.
          </div>
          <div style={{ marginBottom: "0.5rem" }}>
            Currently configured for: {claudeOllamaRoles.map((role, i) => (
              <span key={role}>
                {i > 0 && ", "}
                <code>{role}</code>
              </span>
            ))}.
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
