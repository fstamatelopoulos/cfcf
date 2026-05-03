import { useEffect, useState } from "react";

/**
 * Per-role model picker (item 6.26).
 *
 * Layout: a `<select>` populated from the resolved per-adapter model
 * registry (seed merged with user override; fetched via
 * `/api/agents/models` and passed in as `models`), plus three sentinel
 * options:
 *
 *   1. `(adapter default)`  -- empty value; the agent CLI picks the model.
 *   2. each registry model
 *   3. `(custom model name…)` -- swaps to a free-text input so users can
 *      pin an unreleased / experimental model without waiting for the
 *      seed list or their Settings override to catch up. Mirrors the
 *      pattern in ClioProjectDialog (6.12).
 *
 * If the current value is non-empty AND not in the registry, render an
 * extra `<option value=X>{X} (custom)</option>` so we never silently
 * lose a hand-edited config value.
 *
 * Switches the model list when `adapter` changes -- if the previously
 * selected model isn't in the new adapter's registry, the value falls
 * back to "(custom)" rendering until the user picks something else.
 */

const CUSTOM_SENTINEL = "__custom__";

export function AgentModelSelect({
  adapter,
  models,
  value,
  onChange,
  id,
  /** Width hint applied to the inner widgets so the select+input share dimensions. */
  minWidth,
}: {
  adapter: string;
  models: string[];
  value: string;
  onChange: (next: string) => void;
  id?: string;
  minWidth?: string;
}) {
  // "custom" mode is sticky: once the user picks "(custom model name…)"
  // we render the text input until they change adapters or pick a real
  // option. We also enter custom mode when the value isn't recognised
  // (so a hand-edited config that doesn't match the registry round-trips
  // cleanly).
  const valueIsKnown = value === "" || models.includes(value);
  const [isCustom, setIsCustom] = useState<boolean>(value !== "" && !valueIsKnown);

  // Reset custom mode when the adapter changes -- the user is starting
  // over for the new adapter.
  useEffect(() => {
    setIsCustom(value !== "" && !models.includes(value));
    // adapter change is the trigger; value/models tracked too so a fresh
    // mount with an unknown value picks up custom mode.
  }, [adapter, value, models]);

  function handleSelectChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value;
    if (next === CUSTOM_SENTINEL) {
      setIsCustom(true);
      // Don't clobber an existing custom value; only seed empty when
      // entering custom mode from a registry value.
      if (value === "" || models.includes(value)) onChange("");
      return;
    }
    setIsCustom(false);
    onChange(next);
  }

  if (isCustom) {
    return (
      <div className="form-row__inline">
        <input
          id={id}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Custom model name (e.g. claude-opus-4-7)"
          style={{ minWidth }}
        />
        <button
          type="button"
          className="btn btn--small btn--secondary"
          onClick={() => { setIsCustom(false); onChange(""); }}
          title="Cancel custom — back to the dropdown"
        >
          ↺
        </button>
      </div>
    );
  }

  return (
    <select
      id={id}
      value={valueIsKnown ? value : CUSTOM_SENTINEL}
      onChange={handleSelectChange}
      style={{ minWidth }}
    >
      <option value="">(adapter default)</option>
      {models.map((m) => (
        <option key={m} value={m}>{m}</option>
      ))}
      {/* Hand-edited config value not in the registry -- preserve it
          rather than silently coercing to "" or "custom". */}
      {!valueIsKnown && value !== "" && (
        <option value={value}>{value} (custom)</option>
      )}
      <option value={CUSTOM_SENTINEL}>(custom model name…)</option>
    </select>
  );
}
