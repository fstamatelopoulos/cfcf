/**
 * Tests for the cfcf-side PA session-archive fallback ingest.
 *
 * Item 6.9 follow-up (2026-05-09): the PA prompt instructs the agent
 * to push `pa-session-<sessionId>` at session end, but the agent
 * sometimes skips it (Ctrl-D, model decision, etc.). cfcf falls back
 * + writes the archive itself so the on-disk session is preserved in
 * Clio across machines. Tests cover the four logical branches:
 *
 *   - Happy path: agent never synced, session has content → ingest.
 *   - Skip: session file is missing.
 *   - Skip: session file is too small (< 500 chars; treated as empty).
 *   - Skip: meta.json says agent already synced AFTER the file's mtime.
 *
 * The "explicit shared project wins over per-workspace default" case
 * is also covered — when the workspace has `clioProject` set to a
 * shared project, the fallback ingests there.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { LocalClio } from "../clio/backend/local-clio.js";
import { setClioBackend } from "../clio/singleton.js";
import { fallbackIngestPaSessionArchive } from "./launcher.js";
import { createWorkspace } from "../workspaces.js";

let tempDir: string;
let clio: LocalClio;
const origConfigDir = process.env.CFCF_CONFIG_DIR;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "cfcf-pa-fallback-test-"));
  process.env.CFCF_CONFIG_DIR = tempDir;
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

async function seedPaCache(opts: {
  paCachePath: string;
  sessionId: string;
  contentChars?: number;
  metaLastSyncAt?: string | null;
  /** Backdate the session file's mtime to before lastSyncAt. */
  filemtime?: Date;
}): Promise<void> {
  await mkdir(opts.paCachePath, { recursive: true });
  const content = "# PA session\n\n"
    + Array((opts.contentChars ?? 1000) / 10).fill("Some line.").join("\n")
    + "\n";
  const sessionFile = join(opts.paCachePath, `session-${opts.sessionId}.md`);
  await writeFile(sessionFile, content, "utf-8");
  if (opts.filemtime) {
    const t = opts.filemtime.getTime() / 1000;
    utimesSync(sessionFile, t, t);
  }
  if (opts.metaLastSyncAt !== undefined) {
    const meta = {
      currentSessionId: opts.sessionId,
      lastSyncAt: opts.metaLastSyncAt,
      paWorkspaceMemoryDocId: null,
      paGlobalMemoryDocId: null,
    };
    await writeFile(join(opts.paCachePath, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");
  }
}

describe("fallbackIngestPaSessionArchive", () => {
  it("ingests the archive when the agent never synced (happy path)", async () => {
    const w = await createWorkspace({ name: "tracker", repoPath: tempDir });
    const paCachePath = join(tempDir, ".cfcf-pa");
    const sessionId = "pa-2026-05-09T10-00-00-test01";
    await seedPaCache({ paCachePath, sessionId, metaLastSyncAt: null });

    const result = await fallbackIngestPaSessionArchive({
      paCachePath,
      workspaceId: w.id,
      sessionId,
      paAgentAdapter: "claude-code",
      paAgentModel: "sonnet",
    });

    expect(result.archiveDocId).toBeTruthy();

    // Doc should land in the workspace's effective Clio Project.
    const doc = await clio.getDocument(result.archiveDocId!);
    expect(doc).not.toBeNull();
    expect(doc?.title).toBe(`pa-session-${sessionId}`);
    expect(doc?.projectName).toBe(`cf-workspace-${w.id}`);
    // Author stamp follows the role|adapter|model convention.
    expect(doc?.author).toBe("product-architect|claude-code|sonnet");
    // Metadata triple lets future PA sessions discover the archive.
    expect(doc?.metadata?.role).toBe("pa");
    expect(doc?.metadata?.artifact_type).toBe("session-archive");
    expect(doc?.metadata?.workspace_id).toBe(w.id);
    expect(doc?.metadata?.session_id).toBe(sessionId);
    // Stamp so future audits can tell agent-driven from cfcf-fallback writes.
    expect(doc?.metadata?.ingested_by).toBe("cfcf-fallback");
  });

  it("respects an explicit shared clioProject (e.g. backend-services) over the per-workspace default", async () => {
    const w = await createWorkspace({
      name: "api-service",
      repoPath: tempDir,
      clioProject: "backend-services",
    });
    const paCachePath = join(tempDir, ".cfcf-pa");
    const sessionId = "pa-2026-05-09T10-30-00-test02";
    await seedPaCache({ paCachePath, sessionId, metaLastSyncAt: null });

    const result = await fallbackIngestPaSessionArchive({
      paCachePath,
      workspaceId: w.id,
      sessionId,
      paAgentAdapter: "codex",
      paAgentModel: "gpt-5",
    });

    expect(result.archiveDocId).toBeTruthy();
    const doc = await clio.getDocument(result.archiveDocId!);
    expect(doc?.projectName).toBe("backend-services");
  });

  it("skips when the session file is missing", async () => {
    const w = await createWorkspace({ name: "ws", repoPath: tempDir });
    const paCachePath = join(tempDir, ".cfcf-pa");
    await mkdir(paCachePath, { recursive: true });
    // No session file written.

    const result = await fallbackIngestPaSessionArchive({
      paCachePath,
      workspaceId: w.id,
      sessionId: "pa-no-such-session",
      paAgentAdapter: "claude-code",
    });

    expect(result.archiveDocId).toBeNull();
    expect(result.reason).toBe("no-session-file");
  });

  it("skips when the session file is too small (< 500 chars; treats as empty)", async () => {
    const w = await createWorkspace({ name: "ws-tiny", repoPath: tempDir });
    const paCachePath = join(tempDir, ".cfcf-pa");
    const sessionId = "pa-2026-05-09T11-00-00-tiny01";
    await seedPaCache({ paCachePath, sessionId, contentChars: 100 });

    const result = await fallbackIngestPaSessionArchive({
      paCachePath,
      workspaceId: w.id,
      sessionId,
      paAgentAdapter: "claude-code",
    });

    expect(result.archiveDocId).toBeNull();
    expect(result.reason).toBe("session-too-small");
  });

  it("skips when meta.json shows the agent already synced AFTER the file's mtime", async () => {
    const w = await createWorkspace({ name: "ws-synced", repoPath: tempDir });
    const paCachePath = join(tempDir, ".cfcf-pa");
    const sessionId = "pa-2026-05-09T11-30-00-synced01";
    // Backdate the session file 1 hour; agent reports lastSyncAt=now.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await seedPaCache({
      paCachePath,
      sessionId,
      filemtime: oneHourAgo,
      metaLastSyncAt: new Date().toISOString(),
    });

    const result = await fallbackIngestPaSessionArchive({
      paCachePath,
      workspaceId: w.id,
      sessionId,
      paAgentAdapter: "claude-code",
    });

    expect(result.archiveDocId).toBeNull();
    expect(result.reason).toBe("agent-already-synced");
  });

  it("DOES ingest when meta.json shows lastSyncAt OLDER than the session's mtime (post-sync edits)", async () => {
    // Agent synced an hour ago, then user did more work + the agent
    // never re-synced. The fallback should pick up the newer content.
    const w = await createWorkspace({ name: "ws-edited", repoPath: tempDir });
    const paCachePath = join(tempDir, ".cfcf-pa");
    const sessionId = "pa-2026-05-09T12-00-00-edited01";
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await seedPaCache({
      paCachePath,
      sessionId,
      // File mtime = now (default); metaLastSyncAt = an hour ago.
      metaLastSyncAt: oneHourAgo.toISOString(),
    });

    const result = await fallbackIngestPaSessionArchive({
      paCachePath,
      workspaceId: w.id,
      sessionId,
      paAgentAdapter: "claude-code",
    });

    expect(result.archiveDocId).toBeTruthy();
  });

  it("updates meta.json with lastSyncAt + lastSessionArchiveDocId after a successful ingest", async () => {
    const w = await createWorkspace({ name: "ws-meta", repoPath: tempDir });
    const paCachePath = join(tempDir, ".cfcf-pa");
    const sessionId = "pa-2026-05-09T12-30-00-meta01";
    await seedPaCache({ paCachePath, sessionId, metaLastSyncAt: null });

    const result = await fallbackIngestPaSessionArchive({
      paCachePath,
      workspaceId: w.id,
      sessionId,
      paAgentAdapter: "claude-code",
    });

    expect(result.archiveDocId).toBeTruthy();

    // Re-read meta.json: should now show our sync.
    const { readFile } = await import("fs/promises");
    const metaRaw = await readFile(join(paCachePath, "meta.json"), "utf-8");
    const meta = JSON.parse(metaRaw);
    expect(meta.lastSyncAt).toBeTruthy();
    expect(meta.lastSessionArchiveDocId).toBe(result.archiveDocId);
  });

  it("is idempotent on repeat invocations (sha256 dedup)", async () => {
    const w = await createWorkspace({ name: "ws-idem", repoPath: tempDir });
    const paCachePath = join(tempDir, ".cfcf-pa");
    const sessionId = "pa-2026-05-09T13-00-00-idem01";
    await seedPaCache({ paCachePath, sessionId, metaLastSyncAt: null });

    const r1 = await fallbackIngestPaSessionArchive({
      paCachePath,
      workspaceId: w.id,
      sessionId,
      paAgentAdapter: "claude-code",
    });
    expect(r1.archiveDocId).toBeTruthy();

    // Second call should skip via the meta.json gate.
    const r2 = await fallbackIngestPaSessionArchive({
      paCachePath,
      workspaceId: w.id,
      sessionId,
      paAgentAdapter: "claude-code",
    });
    expect(r2.archiveDocId).toBeNull();
    expect(r2.reason).toBe("agent-already-synced");
  });
});
