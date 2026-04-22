/**
 * macOS notification channel.
 *
 * Uses osascript to display a native notification center entry.
 * Requires Terminal.app (or the calling terminal) to have notification
 * permission — this is granted via System Settings → Notifications.
 * First use may silently fail if permission has never been granted.
 */

import type { NotificationChannel } from "../types.js";

/** Escape a string for safe inclusion in an AppleScript string literal */
function escapeAppleScript(s: string): string {
  // Replace backslashes first, then double quotes. AppleScript uses \\ and \".
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export const macosChannel: NotificationChannel = {
  name: "macos",
  async deliver(event) {
    if (process.platform !== "darwin") {
      return; // no-op on non-macOS
    }

    const title = escapeAppleScript(event.title);
    const message = escapeAppleScript(event.message);
    const subtitle = escapeAppleScript(`cfcf — ${event.workspace.name}`);

    const script =
      `display notification "${message}" with title "${title}" subtitle "${subtitle}" sound name "Submarine"`;

    try {
      const proc = Bun.spawn(["osascript", "-e", script], {
        stdout: "ignore",
        stderr: "ignore",
      });
      // Don't block the dispatcher; but do await so we catch errors
      const exit = await proc.exited;
      if (exit !== 0) {
        // Don't throw — notifications failing should not break the loop
        console.error(`[notifications/macos] osascript exited with code ${exit}`);
      }
    } catch (err) {
      console.error(`[notifications/macos] Failed to deliver:`, err);
    }
  },
};
