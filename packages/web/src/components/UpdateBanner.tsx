import { useEffect, useState } from "react";
import { useServerStatus } from "../hooks/useServerStatus";

/**
 * Top-bar new-version banner (item 6.20).
 *
 * Update-status data flows through the shared `ServerStatusProvider` --
 * one poll cycle covers health, activity, and update-status, so this
 * component carries no timer of its own. The provider re-tick every
 * 3-10 s keeps the banner promptly responsive when the underlying
 * `~/.cfcf/update-available.json` flag changes (e.g. the scheduler
 * just refreshed it, or a `cfcf self-update` cleared it).
 *
 * Per-session dismissal lives in `sessionStorage`, keyed by
 * `latestVersion` so a newer release re-shows the banner.
 *
 * No clickable URL: the underlying flag file is intentionally
 * URL-free for security reasons (~/.cfcf is user-writable; an
 * attacker-controlled link rendered as <a target="_blank"> would
 * be a phishing surface). The upgrade command is canonical and
 * self-contained.
 */
export function UpdateBanner() {
  const { updateStatus } = useServerStatus();
  const [dismissedFor, setDismissedFor] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY);
    } catch {
      return null;
    }
  });

  // Resync dismissal when a newer version arrives (or the flag clears).
  useEffect(() => {
    if (!updateStatus) return;
    try {
      const stored = sessionStorage.getItem(DISMISS_KEY);
      if (stored !== dismissedFor) setDismissedFor(stored);
    } catch { /* ignore */ }
  }, [updateStatus, dismissedFor]);

  if (!updateStatus) return null;
  if (dismissedFor === updateStatus.latestVersion) return null;

  return (
    <div className="update-banner" role="status" aria-live="polite">
      <span className="update-banner__icon" aria-hidden>⏫</span>
      <span className="update-banner__body">
        cfcf <strong>v{updateStatus.latestVersion}</strong> is available.{" "}
        Run <code>cfcf self-update --yes</code> to upgrade.
      </span>
      <button
        type="button"
        className="update-banner__dismiss"
        onClick={() => {
          try {
            sessionStorage.setItem(DISMISS_KEY, updateStatus.latestVersion);
          } catch { /* ignore */ }
          setDismissedFor(updateStatus.latestVersion);
        }}
        aria-label="Dismiss update notification"
      >
        ×
      </button>
    </div>
  );
}

const DISMISS_KEY = "cfcf:update-banner:dismissed-for";
