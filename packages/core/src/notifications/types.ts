/**
 * Internal types used by the notification dispatcher and channels.
 * Exported types (NotificationEvent, NotificationChannelName, NotificationConfig)
 * live in ../types.ts alongside the other config types.
 */

import type { NotificationEvent, NotificationChannelName } from "../types.js";

export interface NotificationChannel {
  name: NotificationChannelName;
  /**
   * Deliver a notification. Should not throw; any error should be logged
   * (console.error) and the method should resolve normally. A rejection
   * from this method causes the dispatcher to log and continue — other
   * channels still fire.
   */
  deliver(event: NotificationEvent): Promise<void>;
}
