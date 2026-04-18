/**
 * Decide how to spawn the cfcf server as a background child.
 *
 * Two modes (item 5.3):
 *
 * (a) **Dev mode** -- we are running under `bun run packages/cli/src/index.ts`.
 *     The server entry source file exists on disk, so we spawn
 *     `bun run packages/server/src/index.ts` the same way the CLI has
 *     always done it.
 *
 * (b) **Compiled binary** -- we are running as `./cfcf-binary`. The server
 *     source file does not exist on disk at runtime; everything is bundled
 *     into the binary. Re-spawn the binary itself with
 *     `CFCF_INTERNAL_SERVE=1` -- the CLI entry point in `index.ts` detects
 *     this env var and hands control to `startServer()` instead of
 *     parsing CLI args.
 *
 * Detection: stat the expected server entry path. Present = dev; absent =
 * compiled.
 */

import { stat } from "fs/promises";

type SpawnedChild = { pid: number | undefined };

async function serverEntryExists(): Promise<string | null> {
  // This path is only meaningful in dev (repo checkout). We try to resolve it
  // but tolerate failure -- the compiled binary has no source tree.
  try {
    const entry = new URL("../../server/src/index.ts", import.meta.url).pathname;
    await stat(entry);
    return entry;
  } catch {
    return null;
  }
}

export async function spawnServerChild(port: number): Promise<SpawnedChild> {
  const entry = await serverEntryExists();

  if (entry) {
    // Dev mode
    const child = Bun.spawn(["bun", "run", entry], {
      env: { ...process.env, CFCF_PORT: String(port) },
      stdio: ["ignore", "ignore", "ignore"],
    });
    return { pid: child.pid };
  }

  // Compiled-binary mode -- re-spawn self in internal serve mode.
  const self = process.execPath;
  const child = Bun.spawn([self], {
    env: { ...process.env, CFCF_PORT: String(port), CFCF_INTERNAL_SERVE: "1" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  return { pid: child.pid };
}
