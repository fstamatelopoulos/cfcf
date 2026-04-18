/**
 * Registry of notification channels.
 */

import type { NotificationChannelName } from "../../types.js";
import type { NotificationChannel } from "../types.js";
import { terminalBellChannel } from "./terminal-bell.js";
import { macosChannel } from "./macos.js";
import { linuxChannel } from "./linux.js";
import { logChannel } from "./log.js";

export const channelRegistry: Record<NotificationChannelName, NotificationChannel> = {
  "terminal-bell": terminalBellChannel,
  macos: macosChannel,
  linux: linuxChannel,
  log: logChannel,
};

export {
  terminalBellChannel,
  macosChannel,
  linuxChannel,
  logChannel,
};
