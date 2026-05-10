/**
 * Tests for the cwd-aware default-project resolver used by
 * `cfcf clio docs ingest` when --project is omitted (item 6.9
 * follow-up, 2026-05-09).
 *
 * The resolver is intentionally NOT exported from clio.ts (it's a
 * file-local helper). To exercise it we run the same logic inline
 * here — list workspaces, realpath-match by repoPath, derive the
 * effective project. This way we test the *behaviour* (the contract
 * with /api/workspaces) rather than the function symbol.
 *
 * The server-side fix for the option default living on parent vs
 * child is covered separately by clio-option-parsing.test.ts. This
 * file is about the runtime-resolution semantic that replaced the
 * static `"cf-system-default"` default.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, realpathSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createApp } from "@cfcf/server/app";
import { LocalClio, writeConfig, createDefaultConfig, effectiveClioProject } from "@cfcf/core";
import { setClioBackend } from "@cfcf/server/clio-backend";

let tempDir: string;
let clio: LocalClio;
const origConfigDir = process.env.CFCF_CONFIG_DIR;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "cfcf-default-project-test-"));
  process.env.CFCF_CONFIG_DIR = tempDir;
  await writeConfig(createDefaultConfig(["claude-code"]));
  clio = new LocalClio({ path: join(tempDir, "clio.db") });
  setClioBackend(clio);
});

afterEach(async () => {
  setClioBackend(null);
  await clio.close();
  if (origConfigDir === undefined) delete process.env.CFCF_CONFIG_DIR;
  else process.env.CFCF_CONFIG_DIR = origConfigDir;
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function makeRepo(name: string): Promise<string> {
  const repoDir = join(tempDir, name);
  await mkdir(repoDir, { recursive: true });
  await Bun.spawn(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;
  await Bun.spawn(["git", "config", "user.email", "t@e.dev"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;
  await Bun.spawn(["git", "config", "user.name", "t"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;
  await writeFile(join(repoDir, "README.md"), "# t\n");
  await Bun.spawn(["git", "add", "-A"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;
  await Bun.spawn(["git", "commit", "-m", "initial"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;
  return repoDir;
}

/**
 * Inline reproduction of the CLI's `resolveDefaultIngestProject()`
 * logic, run against the in-process Hono app. We can't import the
 * real helper (it lives behind the CLI's HTTP-via-fetch boundary
 * and uses module-scoped `get()` against `localhost:7233`), but the
 * shape is straightforward — list workspaces, find the cwd match,
 * derive the effective project.
 */
async function resolveDefault(app: ReturnType<typeof createApp>, cwd: string): Promise<{ project: string; matched: boolean }> {
  const safe = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  const target = safe(cwd);
  const res = await app.request("/api/workspaces");
  const list = await res.json() as Array<{ id: string; name: string; repoPath: string; clioProject?: string }>;
  const match = list.find((w) => safe(w.repoPath) === target);
  if (match) {
    return {
      project: effectiveClioProject({ id: match.id, clioProject: match.clioProject }),
      matched: true,
    };
  }
  return { project: "cf-system-default", matched: false };
}

async function seedWorkspace(app: ReturnType<typeof createApp>, name: string, repoPath: string, clioProject?: string) {
  const res = await app.request("/api/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, repoPath, clioProject }),
  });
  expect(res.status).toBe(201);
  return await res.json();
}

describe("`cfcf clio docs ingest` default-project resolution (item 6.9)", () => {
  it("routes to the workspace's per-workspace project when cwd matches a registered workspace (default case)", async () => {
    const app = createApp();
    const repo = await makeRepo("tracker");
    const ws = await seedWorkspace(app, "tracker", repo);

    const resolved = await resolveDefault(app, repo);
    expect(resolved.matched).toBe(true);
    expect(resolved.project).toBe(`cf-workspace-${ws.id}`);
  });

  it("routes to the explicit shared project when the workspace has clioProject set (e.g. backend-services)", async () => {
    const app = createApp();
    const repo = await makeRepo("api-svc");
    await seedWorkspace(app, "api-svc", repo, "backend-services");

    const resolved = await resolveDefault(app, repo);
    expect(resolved.matched).toBe(true);
    expect(resolved.project).toBe("backend-services");
  });

  it("falls back to cf-system-default when cwd is NOT inside any registered workspace", async () => {
    const app = createApp();
    const repo = await makeRepo("known");
    await seedWorkspace(app, "known", repo);

    // Run from a sibling temp dir — not inside any workspace.
    const orphan = join(tempDir, "orphan");
    await mkdir(orphan, { recursive: true });

    const resolved = await resolveDefault(app, orphan);
    expect(resolved.matched).toBe(false);
    expect(resolved.project).toBe("cf-system-default");
  });

  it("realpath-matches across symlinks (macOS /tmp → /private/tmp)", async () => {
    const app = createApp();
    const repo = await makeRepo("realpathy");
    const ws = await seedWorkspace(app, "realpathy", repo);

    // Run resolution against the repo's REALPATH (handles macOS
    // /tmp ↔ /private/tmp). The `safe(realpathSync())` in the
    // resolver normalises both sides so direct + symlinked cwd
    // both match.
    const resolved = await resolveDefault(app, realpathSync(repo));
    expect(resolved.project).toBe(`cf-workspace-${ws.id}`);
  });

  it("never returns `cf-system-default` when a workspace IS at cwd, even if its clioProject is undefined (post-6.9 invariant)", async () => {
    // Pre-6.9 the static option default was `cf-system-default` —
    // a workspace's free-form ingests landed there even when the
    // workspace had its own per-workspace project. Item 6.9
    // explicitly removed that fallthrough; this test pins it.
    const app = createApp();
    const repo = await makeRepo("never-default");
    await seedWorkspace(app, "never-default", repo);

    const resolved = await resolveDefault(app, repo);
    expect(resolved.project).not.toBe("cf-system-default");
    expect(resolved.project).toMatch(/^cf-workspace-/);
  });
});
