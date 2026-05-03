import { useEffect, useState } from "react";
import { fetchUpdateStatus, type UpdateStatus } from "../api";

/**
 * Top-bar new-version banner (item 6.20).
 *
 * Polls `/api/update-status` once on mount and every 5 minutes after that
 * (the server-side scheduler only refreshes the underlying flag every 24h
 * by default; the UI just needs to surface state changes that happen
 * while the tab is open). Per-session dismissal lives in `sessionStorage`,
 * keyed by `latestVersion` so a newer release re-shows the banner.
 *
 * Always-on: zero per-invocation cost compared to the CLI's lifecycle-
 * gated banner -- the cost is one HTTP call per page load, which is
 * dwarfed by the rest of the dashboard's polling.
 */
export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await fetchUpdateStatus();
        if (cancelled) return;
        setStatus(s);
        // Re-check the dismissal key whenever status changes -- a newer
        // version replaces the key and re-shows the banner.
        if (s) {
          const dismissedFor = sessionStorage.getItem(DISMISS_KEY);
          setDismissed(dismissedFor === s.latestVersion);
        } else {
          setDismissed(false);
        }
      } catch {
        // Network blip; keep the previous state.
      }
    };
    tick();
    const id = setInterval(tick, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (!status || dismissed) return null;

  return (
    <div className="update-banner" role="status" aria-live="polite">
      <span className="update-banner__icon" aria-hidden>⏫</span>
      <span className="update-banner__body">
        cfcf <strong>v{status.latestVersion}</strong> is available.{" "}
        Run <code>cfcf self-update --yes</code> to upgrade
        {status.releaseNotesUrl && (
          <>
            {" "}(<a href={status.releaseNotesUrl} target="_blank" rel="noreferrer noopener">release notes</a>)
          </>
        )}.
      </span>
      <button
        type="button"
        className="update-banner__dismiss"
        onClick={() => {
          sessionStorage.setItem(DISMISS_KEY, status.latestVersion);
          setDismissed(true);
        }}
        aria-label="Dismiss update notification"
      >
        ×
      </button>
    </div>
  );
}

const DISMISS_KEY = "cfcf:update-banner:dismissed-for";
