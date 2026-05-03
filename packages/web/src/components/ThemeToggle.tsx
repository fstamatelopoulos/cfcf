import { useTheme, type Theme } from "../hooks/useTheme";

/**
 * Cycle button for dark / light / auto themes (item 6.12).
 *
 * Lives in the top-right of Header, between nav and the version status.
 * One click cycles dark → light → auto → dark; the icon + tooltip make
 * the current state clear. Persists via useTheme (localStorage + cfcf
 * global config).
 */

const NEXT_LABEL: Record<Theme, string> = {
  dark: "Switch to light theme",
  light: "Switch to system (auto)",
  auto: "Switch to dark theme",
};

const ICON: Record<Theme, string> = {
  dark: "☾",
  light: "☀",
  auto: "◐",
};

const SR_LABEL: Record<Theme, string> = {
  dark: "Dark theme",
  light: "Light theme",
  auto: "System theme",
};

export function ThemeToggle() {
  const { theme, cycleTheme } = useTheme();

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={cycleTheme}
      title={`${SR_LABEL[theme]} — ${NEXT_LABEL[theme].toLowerCase()}`}
      aria-label={SR_LABEL[theme]}
    >
      <span aria-hidden>{ICON[theme]}</span>
    </button>
  );
}
