/**
 * Per-role model picker (item 6.26; ollama-aware in 6.33).
 *
 * Layout: a `<select>` populated from the resolved per-adapter model
 * registry (seed merged with user override; fetched via
 * `/api/agents/models` and passed in as `models`), plus a leading
 * `(adapter default)` option (empty value) representing "let the
 * agent CLI pick".
 *
 * **`(adapter default)` is hidden for ollama-routed adapters** (item
 * 6.33). The seed-sourced adapters (`claude-code`, `codex`) have real
 * built-in defaults when `--model` is omitted; the ollama-routed
 * adapters don't — `ollama launch <agent>` requires `--model <name>`
 * to know which local model to hand off, and our adapters skip the
 * flag entirely on a falsy `model` value. So saving model="" for
 * `claude-code-ollama` / `opencode-ollama` produces a silent
 * misconfiguration. The picker hides the empty option to force a
 * deliberate pick.
 *
 * **Empty-state handling for ollama-routed adapters**: when the
 * resolved list is empty (no models pulled yet, or the boot-time
 * refresh hasn't run), show a disabled "(no ollama models — pull
 * one or click Refresh)" placeholder so the dropdown isn't visually
 * empty. The user can't select it; they need to pull a model and
 * hit the Refresh button (or restart the server) before picking.
 *
 * **Single edit surface for the registry**: to add or remove a model
 * from this dropdown the user goes to Settings → Model registry. We
 * deliberately don't have an inline "custom model name…" sentinel:
 * one place to manage models is clearer than two, and the chip
 * editor on the Settings page handles add + remove + reset to seed.
 *
 * **Back-compat preservation**: if the current value is a string that
 * isn't in the registry (e.g. a hand-edited config from before the
 * registry shipped, or one that's been pruned from the registry), we
 * still render it as an `<option>{value} (custom)</option>` so we
 * never silently coerce it to `""` on first render. The user can
 * pick a registry entry to clear it, or add the value to the
 * registry to make it stick.
 */

/**
 * Adapters that route through ollama and require an explicit
 * `--model <name>` flag at spawn time. Hardcoded here rather than
 * imported from `@cfcf/core` because the web app is Vite-built and
 * doesn't pull from the workspace package directly (same convention
 * as `HarnessPolicyWarning.tsx`).
 */
const OLLAMA_ROUTED_ADAPTERS = new Set(["claude-code-ollama", "opencode-ollama"]);

export function AgentModelSelect({
  adapter,
  models,
  value,
  onChange,
  id,
  /** Width hint applied to the select so it lines up with adapter dropdowns. */
  minWidth,
}: {
  adapter: string;
  models: string[];
  value: string;
  onChange: (next: string) => void;
  id?: string;
  minWidth?: string;
}) {
  const valueIsKnown = value === "" || models.includes(value);
  const isOllamaRouted = OLLAMA_ROUTED_ADAPTERS.has(adapter);
  const showEmptyOllamaPlaceholder = isOllamaRouted && models.length === 0;

  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ minWidth }}
    >
      {/* Seed-sourced adapters: empty value = "let the CLI pick". */}
      {!isOllamaRouted && (
        <option value="">(adapter default)</option>
      )}
      {/* Ollama-routed adapters with an empty list: disabled placeholder
          so the dropdown isn't visually empty + the user is told what
          to do. The user can't select this option (it's disabled). */}
      {showEmptyOllamaPlaceholder && (
        <option value="" disabled>
          (no ollama models — pull one or click Refresh)
        </option>
      )}
      {models.map((m) => (
        <option key={m} value={m}>{m}</option>
      ))}
      {/* Hand-edited config value not in the registry -- preserve it
          rather than silently coercing to "" on first render. To stop
          showing it the user picks another option (clears it) or adds
          it to the registry on the Settings page. */}
      {!valueIsKnown && value !== "" && (
        <option value={value}>{value} (custom)</option>
      )}
    </select>
  );
}
