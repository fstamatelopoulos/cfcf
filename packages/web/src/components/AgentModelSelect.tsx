/**
 * Per-role model picker (item 6.26).
 *
 * Layout: a `<select>` populated from the resolved per-adapter model
 * registry (seed merged with user override; fetched via
 * `/api/agents/models` and passed in as `models`), plus a leading
 * `(adapter default)` option (empty value) representing "let the
 * agent CLI pick".
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

export function AgentModelSelect({
  adapter: _adapter,
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

  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ minWidth }}
    >
      <option value="">(adapter default)</option>
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
