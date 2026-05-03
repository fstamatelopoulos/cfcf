import { useCallback, useEffect, useState } from "react";
import { fetchGlobalConfig, saveGlobalConfig } from "../api";

/**
 * Web UI theme state (item 6.12 polish).
 *
 *   - "auto": follow OS prefers-color-scheme
 *   - "dark" | "light": force the chosen theme
 *
 * Two storage layers:
 *   1. localStorage (`cfcf:theme`) -- per-tab fast path. The pre-paint
 *      script in index.html reads this BEFORE React mounts so the page
 *      renders in the right theme on first paint, no flash.
 *   2. cfcf global config (`theme` field) -- durable cross-device source
 *      of truth. We read it on mount and reconcile with localStorage if
 *      they disagree (config wins because it follows the user across
 *      browsers / machines).
 *
 * Apply to the page by setting `data-theme` on <html>. "auto" deliberately
 * REMOVES the attribute so the CSS `prefers-color-scheme` media query
 * controls rendering.
 */

export type Theme = "auto" | "dark" | "light";

const STORAGE_KEY = "cfcf:theme";

function readLocalTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "dark" || v === "light" || v === "auto") return v;
  } catch { /* ignore */ }
  return "auto";
}

function writeLocalTheme(theme: Theme): void {
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* ignore */ }
}

function applyTheme(theme: Theme): void {
  if (theme === "auto") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void; cycleTheme: () => void } {
  const [theme, setThemeState] = useState<Theme>(() => readLocalTheme());

  // Reconcile from server config on mount. Server wins because the user
  // expressed their preference there too; if it differs from local, the
  // user has a new device that hasn't seen their pick yet.
  useEffect(() => {
    fetchGlobalConfig()
      .then((cfg) => {
        const fromServer: Theme = cfg.theme ?? "auto";
        if (fromServer !== theme) {
          setThemeState(fromServer);
          writeLocalTheme(fromServer);
          applyTheme(fromServer);
        }
      })
      .catch(() => { /* offline / pre-init: stick with local */ });
    // Run once on mount; subsequent changes go through setTheme.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply on every state change so the data-theme attribute stays in sync
  // even if state was hydrated from localStorage on first render (the
  // pre-paint script in index.html only handles the initial load).
  useEffect(() => { applyTheme(theme); }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    writeLocalTheme(next);
    applyTheme(next);
    // Persist to cfcf config; ignore errors (offline / pre-init is fine,
    // localStorage already captured the user's intent).
    saveGlobalConfig({ theme: next }).catch(() => { /* ignore */ });
  }, []);

  const cycleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : theme === "light" ? "auto" : "dark");
  }, [theme, setTheme]);

  return { theme, setTheme, cycleTheme };
}
