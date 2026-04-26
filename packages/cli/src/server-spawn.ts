/**
 * Decide how to spawn the cfcf server as a background child.
 *
 * Two modes (item 5.3, updated for v0.10.0's npm-format install):
 *
 * (a) **Dev mode** -- we are running under `bun run packages/cli/src/index.ts`.
 *     The server entry source file exists on disk, so we spawn
 *     `bun run packages/server/src/index.ts` the same way the CLI has
 *     always done it.
 *
 * (b) **Installed (npm-format) mode** -- we are running via the
 *     `~/.bun/bin/cfcf` shim → `bin/cfcf.js` → `dist/cfcf.js`. The server
 *     source file does not exist on disk at runtime; the entire CLI +
 *     server is bundled into `dist/cfcf.js`. Re-spawn `bun run
 *     <dist/cfcf.js>` with `CFCF_INTERNAL_SERVE=1`; the entry point in
 *     `index.ts` detects this env var and hands control to `startServer()`
 *     instead of parsing CLI args.
 *
 *     **Why not `process.execPath`?** Under the npm-format install,
 *     `process.execPath` resolves to the `bun` binary itself, not to
 *     cfcf. Re-spawning that with no script argument launches a bare
 *     Bun REPL, which never starts the server. The earlier `bun
 *     --compile` binary worked because the binary WAS cfcf; npm-format
 *     needs the explicit script path. Bug surfaced 2026-04-26 during
 *     dogfood install on Intel Mac.
 *
 * Detection: stat the expected server entry path. Present = dev; absent =
 * installed.
 */

import { stat } from "fs/promises";
import { fileURLToPath } from "url";

type SpawnedChild = { pid: number | undefined };

async function serverEntryExists(): Promise<string | null> {
  // This path is only meaningful in dev (repo checkout). We try to resolve it
  // but tolerate failure -- the installed bundle has no source tree.
  try {
    const entry = fileURLToPath(new URL("../../server/src/index.ts", import.meta.url));
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

  // Installed (npm-format) mode. import.meta.url resolves to the
  // bundled dist/cfcf.js (server-spawn.ts is inlined into the same
  // bundle by `bun build` at release time). Spawn `bun run <bundle>`
  // with CFCF_INTERNAL_SERVE=1.
  const bundlePath = fileURLToPath(import.meta.url);
  const child = Bun.spawn(["bun", "run", bundlePath], {
    env: { ...process.env, CFCF_PORT: String(port), CFCF_INTERNAL_SERVE: "1" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  return { pid: child.pid };
}
