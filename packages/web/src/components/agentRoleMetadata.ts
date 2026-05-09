/**
 * Shared metadata for the seven cfcf agent roles, consumed by both
 * web Settings (`ServerInfo.tsx`, all seven roles) and per-workspace
 * Config (`ConfigDisplay.tsx`, the five iteration roles only — PA + HA
 * are configured globally).
 *
 * Single source of truth for:
 * - **Row order** in the Agent-roles tables (matches the natural
 *   execution sequence: PA → SA → Dev → Judge → Reflection →
 *   Documenter → HA).
 * - **Display labels** ("Iteration Judge", "Reflection Agent",
 *   "Developer", "Solution Architect" — chosen 2026-05-09 to be more
 *   explicit than the historical "Judge" / "Reflection" / "Dev" /
 *   "Architect").
 * - **Context tag** rendered next to the label, e.g.
 *   `(interactive)` for PA + HA, `(headless | pre-loop)` for
 *   architect, `(headless | loop)` for dev/judge/reflection,
 *   `(headless | after-loop)` for documenter.
 * - **Visibility scope** — `showInGlobal` (every role) and
 *   `showInWorkspace` (the five iteration roles only).
 * - **`isInteractive`** — drives the adapter-picker filter for PA + HA
 *   so opencode + opencode-ollama (item 6.34: their interactive
 *   system-prompt-injection mechanism doesn't fit cf²'s ephemeral-
 *   tempfile pattern) don't appear as choices. `claude-code-ollama`
 *   IS still offered for these roles — round-1 of 6.34 wired it
 *   through the launchers + the user explicitly asked to keep it.
 * - **`isUnattended`** — drives the inline ⚠ policy indicator in the
 *   row. Mirrors `UNATTENDED_ROLE_NAMES` from `@cfcf/core` (we
 *   re-declare here because the web app is Vite-built and doesn't
 *   import from the workspace package directly — same convention as
 *   `HarnessPolicyWarning.tsx`).
 *
 * Adding a new role: append a row here with the right scope flags,
 * and the two views pick it up automatically.
 */

export interface AgentRoleRow {
  /** WorkspaceConfig / GlobalConfig key (e.g. "productArchitectAgent"). */
  key: string;
  /** Display label (e.g. "Product Architect"). */
  label: string;
  /**
   * Short parenthetical context shown next to the label.
   * E.g. "interactive" / "headless | pre-loop" / "headless | loop".
   */
  context: string;
  /**
   * True for roles that take over the user's shell via
   * `Bun.spawn(... { stdio: "inherit" })`. Drives the adapter-picker
   * filter (drops opencode + opencode-ollama for these roles).
   */
  isInteractive: boolean;
  /**
   * True for roles whose adapter spawn pipeline is headless `claude
   * -p` / `codex exec` / `opencode run`. Drives the inline ⚠ policy
   * indicator + the policy callout's "Affected roles" enumeration.
   * Architect counts as unattended in all three loop paths AND for
   * manual `cfcf review` (the polling-client pattern), per item 6.30.
   */
  isUnattended: boolean;
  /** Show this row on the global Settings page (all seven). */
  showInGlobal: boolean;
  /** Show this row on the per-workspace Config tab (iteration roles only). */
  showInWorkspace: boolean;
}

/**
 * Canonical row order — matches the natural agent execution sequence.
 * The user-facing tables render in this order on both Settings and
 * workspace Config; workspace Config additionally filters out rows
 * with `showInWorkspace === false`.
 */
export const AGENT_ROLE_ROWS: AgentRoleRow[] = [
  {
    key: "productArchitectAgent",
    label: "Product Architect",
    context: "interactive",
    isInteractive: true,
    isUnattended: false,
    showInGlobal: true,
    showInWorkspace: false,
  },
  {
    key: "architectAgent",
    label: "Solution Architect",
    context: "headless | pre-loop",
    isInteractive: false,
    isUnattended: true,
    showInGlobal: true,
    showInWorkspace: true,
  },
  {
    key: "devAgent",
    label: "Developer",
    context: "headless | loop",
    isInteractive: false,
    isUnattended: true,
    showInGlobal: true,
    showInWorkspace: true,
  },
  {
    key: "judgeAgent",
    label: "Iteration Judge",
    context: "headless | loop",
    isInteractive: false,
    isUnattended: true,
    showInGlobal: true,
    showInWorkspace: true,
  },
  {
    key: "reflectionAgent",
    label: "Reflection Agent",
    context: "headless | loop",
    isInteractive: false,
    isUnattended: true,
    showInGlobal: true,
    showInWorkspace: true,
  },
  {
    key: "documenterAgent",
    label: "Documenter",
    context: "headless | after-loop",
    isInteractive: false,
    isUnattended: true,
    showInGlobal: true,
    showInWorkspace: true,
  },
  {
    key: "helpAssistantAgent",
    label: "Help Assistant",
    context: "interactive",
    isInteractive: true,
    isUnattended: false,
    showInGlobal: true,
    showInWorkspace: false,
  },
];

/**
 * Adapters NOT supported for interactive roles (PA + HA).
 *
 * Round 1 of item 6.34 (2026-05-09) wired `claude-code-ollama` through
 * the HA + PA launchers; `opencode` and `opencode-ollama` remain
 * unsupported because opencode's system-prompt-injection mechanism
 * (named-agent files at `~/.config/opencode/agent/<name>.md` selected
 * via `--agent <name>`, OR auto-loaded `AGENTS.md` from cwd) doesn't
 * fit cf²'s ephemeral-tempfile pattern without significant work.
 *
 * Round 2 of 6.34 (2026-05-09): rather than implement that work, the
 * user explicitly opted to filter the picker so opencode variants
 * don't appear as choices for PA + HA. Removed from this set when
 * interactive support lands (no current plans).
 */
export const INTERACTIVE_UNSUPPORTED_ADAPTERS = new Set([
  "opencode",
  "opencode-ollama",
]);

/**
 * Filter the available-adapters list for a given role's picker.
 *
 * For interactive roles (PA + HA): drops `opencode` and
 * `opencode-ollama`. Keeps `claude-code-ollama` (round-1 of 6.34
 * shipped that path).
 *
 * For unattended roles: returns the list unchanged.
 *
 * If the user's currently-saved value is excluded by the filter,
 * the caller should still render it as a `<option>` (with a "not
 * supported for this role" suffix) so it doesn't silently disappear.
 * See `ServerInfo.tsx` and `ConfigDisplay.tsx` adapter-select blocks.
 */
export function adaptersForRole(allAdapters: string[], row: AgentRoleRow): string[] {
  if (!row.isInteractive) return allAdapters;
  return allAdapters.filter((a) => !INTERACTIVE_UNSUPPORTED_ADAPTERS.has(a));
}
