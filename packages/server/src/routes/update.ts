/**
 * `GET /api/update-status` -- surfaces the JobScheduler's update-check
 * flag file (`~/.cfcf/update-available.json`) to the web UI banner
 * (item 6.20).
 *
 * Response shape:
 *   - 200 with `{ currentVersion, latestVersion, checkedAt, releaseNotesUrl? }`
 *     when the flag file is present AND `latestVersion > running VERSION`.
 *   - 204 No Content otherwise. The web UI treats 204 as "nothing to show",
 *     no body parsing needed.
 *
 * The double-check against the running VERSION (not just the file's
 * presence) handles the post-self-update race where the server has been
 * upgraded but the scheduler hasn't yet ticked to delete the stale flag.
 */

import type { Hono } from "hono";
import { VERSION, compareSemver, readUpdateAvailable } from "@cfcf/core";

export function registerUpdateRoutes(app: Hono): void {
  app.get("/api/update-status", async (c) => {
    const flag = await readUpdateAvailable();
    if (!flag) {
      c.status(204);
      return c.body(null);
    }
    if (compareSemver(flag.latestVersion, VERSION) <= 0) {
      // Stale flag (we've already upgraded past it); don't surface.
      c.status(204);
      return c.body(null);
    }
    return c.json(flag);
  });
}
