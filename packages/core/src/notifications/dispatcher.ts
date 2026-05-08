/**
 * Notification dispatcher.
 *
 * Given an event and a config, fan out to all configured channels. Fire-and-
 * forget from the caller's perspective: the caller doesn't await individual
 * channel delivery. Per-channel timeout so a slow channel can't stall others.
 *
 * Channels are looked up from the registry (channels/index.ts). Unknown
 * channel names are logged and skipped.
 */

import type {
  NotificationConfig,
  NotificationEvent,
  NotificationEventType,
  NotificationChannelName,
} from "../types.js";
import type { NotificationChannel } from "./types.js";
import { channelRegistry } from "./channels/index.js";

/** Max time a channel has to deliver before we abandon it (ms) */
const CHANNEL_TIMEOUT_MS = 5000;

/**
 * Dispatch a notification event based on config.
 *
 * Never throws. Non-blocking: returns immediately; actual delivery happens
 * in the background. A promise is returned so callers may optionally await
 * (useful in tests) but runtime code should not.
 */
export function dispatch(
  event: NotificationEvent,
  config: NotificationConfig | undefined,
): Promise<void> {
  // Global kill-switch (item 6.28 follow-up). Honored by every channel
  // including macOS / Linux desktop notifications. Useful in:
  //   - Test suites: set in beforeEach so a fire-and-forget loop that
  //     races past afterEach can't fire a real desktop notification
  //     against the user's restored config (the bug that surfaced
  //     2026-05-08 — `iteration-loop.test.ts > Loop State Persistence`
  //     leaked a "Loop failed" notification onto the user's desktop).
  //   - CI / scripted runs: a one-shot env override that doesn't
  //     require editing the user's saved config.
  // Recognised values: "1", "true", "yes" (case-insensitive). Anything
  // else (including unset) leaves dispatch enabled.
  if (notificationsDisabledByEnv()) {
    return Promise.resolve();
  }

  if (!config || !config.enabled) {
    return Promise.resolve();
  }

  const channels = resolveChannels(event.type, config);
  if (channels.length === 0) {
    return Promise.resolve();
  }

  // Fire all channels in parallel with per-channel timeout. Don't let one
  // slow channel block the others.
  const promises = channels.map((channel) => deliverWithTimeout(channel, event));
  return Promise.allSettled(promises).then(() => void 0);
}

/** Read `CFCF_DISABLE_NOTIFICATIONS` env var; truthy values disable dispatch. */
function notificationsDisabledByEnv(): boolean {
  const raw = process.env.CFCF_DISABLE_NOTIFICATIONS;
  if (!raw) return false;
  const normalised = raw.trim().toLowerCase();
  return normalised === "1" || normalised === "true" || normalised === "yes";
}

/** Look up the channel implementations for a given event type. */
function resolveChannels(
  eventType: NotificationEventType,
  config: NotificationConfig,
): NotificationChannel[] {
  const channelNames = config.events[eventType];
  if (!channelNames || channelNames.length === 0) return [];

  const result: NotificationChannel[] = [];
  for (const name of channelNames) {
    const impl = channelRegistry[name];
    if (!impl) {
      console.error(`[notifications] Unknown channel: ${name}`);
      continue;
    }
    result.push(impl);
  }
  return result;
}

async function deliverWithTimeout(
  channel: NotificationChannel,
  event: NotificationEvent,
): Promise<void> {
  const timeout = new Promise<void>((_resolve, reject) => {
    setTimeout(
      () => reject(new Error(`Channel ${channel.name} timed out after ${CHANNEL_TIMEOUT_MS}ms`)),
      CHANNEL_TIMEOUT_MS,
    );
  });

  try {
    await Promise.race([channel.deliver(event), timeout]);
  } catch (err) {
    console.error(`[notifications/${channel.name}] Delivery failed:`, err);
  }
}

/**
 * Resolve the effective notification config for a workspace.
 * Workspace-level overrides take precedence; otherwise falls back to the
 * global config.
 */
export async function resolveNotificationConfig(
  workspaceNotifications: NotificationConfig | undefined,
): Promise<NotificationConfig | undefined> {
  if (workspaceNotifications) return workspaceNotifications;
  const { readConfig } = await import("../config.js");
  const global = await readConfig();
  return global?.notifications;
}

/**
 * Fire-and-forget dispatch helper. Resolves effective config, fires
 * channels in background, never throws or blocks the caller.
 */
export function dispatchForWorkspace(
  event: NotificationEvent,
  workspaceNotifications: NotificationConfig | undefined,
): void {
  resolveNotificationConfig(workspaceNotifications)
    .then((config) => dispatch(event, config))
    .catch((err) => {
      console.error(`[notifications] Dispatch failed:`, err);
    });
}

/** Convenience: build a NotificationEvent with a timestamp. */
export function makeEvent(params: {
  type: NotificationEventType;
  title: string;
  message: string;
  workspaceId: string;
  workspaceName: string;
  details?: Record<string, unknown>;
}): NotificationEvent {
  return {
    type: params.type,
    title: params.title,
    message: params.message,
    workspace: { id: params.workspaceId, name: params.workspaceName },
    timestamp: new Date().toISOString(),
    details: params.details,
  };
}
