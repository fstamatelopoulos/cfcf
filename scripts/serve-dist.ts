/**
 * Phase-0 local file server for installer testing.
 *
 * Serves dist/ over HTTP so install.sh can target it via
 *   CFCF_BASE_URL=http://localhost:8080 bash install.sh
 *
 * No auth, no path-traversal protection beyond a normalize() check; this
 * is for dev-mode testing only. Run alongside scripts/build-release-tarball.sh
 * which produces dist/cfcf-<platform>-<version>.tar.gz + .sha256.
 *
 * Usage:  bun run scripts/serve-dist.ts [port]
 */

import { file } from "bun";
import { resolve, join, normalize } from "node:path";

const port = Number(process.argv[2] ?? 8080);
const root = resolve("dist");

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    // Prevent path traversal outside dist/.
    const target = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!target.startsWith(root)) {
      return new Response("forbidden", { status: 403 });
    }
    const f = file(target);
    if (!(await f.exists())) {
      return new Response("not found", { status: 404 });
    }
    return new Response(f);
  },
});

console.log(`[serve-dist] http://localhost:${port}/  (root: ${root})`);
console.log(`[serve-dist] available files:`);
const fs = await import("node:fs");
try {
  for (const f of fs.readdirSync(root)) {
    console.log(`  /${f}`);
  }
} catch {
  console.log("  (dist/ not found — run scripts/build-release-tarball.sh first)");
}
