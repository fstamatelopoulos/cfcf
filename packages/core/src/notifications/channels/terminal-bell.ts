/**
 * Terminal bell channel.
 *
 * Writes the ASCII BEL character (\a, 0x07) to the server's stderr. Most
 * terminals either beep or flash when they receive this. Silent on
 * non-interactive/redirected stderr.
 */

import type { NotificationChannel } from "../types.js";

export const terminalBellChannel: NotificationChannel = {
  name: "terminal-bell",
  async deliver(_event) {
    // The only action is to write a BEL to stderr. Bun/Node both support
    // writing Uint8Array to process.stderr.
    try {
      process.stderr.write("\x07");
    } catch {
      // stderr may not be writable in some contexts (tests, pipes); swallow
    }
  },
};
