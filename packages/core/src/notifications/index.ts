/**
 * Public entry point for the notifications module.
 */

export { dispatch, dispatchForProject, makeEvent, resolveNotificationConfig } from "./dispatcher.js";
export { channelRegistry } from "./channels/index.js";
export type { NotificationChannel } from "./types.js";
