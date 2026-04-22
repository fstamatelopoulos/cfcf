/**
 * Log channel.
 *
 * Appends a JSON line to `<workspace-log-dir>/notifications.log` per event.
 * Serves as an always-on audit trail that survives terminal close and
 * is easy to grep.
 */

import { join } from "path";
import { appendFile, mkdir } from "fs/promises";
import type { NotificationChannel } from "../types.js";
import { getWorkspaceLogDir } from "../../log-storage.js";

export const logChannel: NotificationChannel = {
  name: "log",
  async deliver(event) {
    try {
      const dir = getWorkspaceLogDir(event.workspace.id);
      await mkdir(dir, { recursive: true });
      const line = JSON.stringify({
        timestamp: event.timestamp,
        type: event.type,
        title: event.title,
        message: event.message,
        details: event.details,
      }) + "\n";
      await appendFile(join(dir, "notifications.log"), line, "utf-8");
    } catch (err) {
      console.error(`[notifications/log] Failed to append:`, err);
    }
  },
};
