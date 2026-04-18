/**
 * Linux notification channel.
 *
 * Uses notify-send (from libnotify) to display a native desktop notification.
 * Most Linux desktop environments ship notify-send by default.
 * If notify-send is not available, this channel silently no-ops.
 */

import type { NotificationChannel } from "../types.js";

export const linuxChannel: NotificationChannel = {
  name: "linux",
  async deliver(event) {
    if (process.platform !== "linux") {
      return;
    }

    try {
      const proc = Bun.spawn(
        [
          "notify-send",
          "--app-name=cfcf",
          "--urgency=normal",
          event.title,
          event.message,
        ],
        {
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      const exit = await proc.exited;
      if (exit !== 0) {
        // notify-send might not be installed; log once but don't throw
        console.error(`[notifications/linux] notify-send exited with code ${exit}`);
      }
    } catch (err) {
      // notify-send not found or other failure; swallow
      console.error(`[notifications/linux] Failed to deliver:`, err);
    }
  },
};
