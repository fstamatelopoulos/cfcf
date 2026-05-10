/**
 * Tests for the boot-time PA history reconciliation.
 *
 * Item 6.9 follow-up: stale `running` PA history events (left behind
 * when the launcher's finally block didn't run) get flipped to
 * `failed` + their session archive ingested to Clio on every server
 * boot. Tests cover the stale → reconciled path + the live →
 * untouched path + the no-content edge case.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "fs";
import { mkdir, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { LocalClio } from "../clio/backend/local-clio.js";
import { setClioBackend } from "../clio/singleton.js";
import { reconcileStalePaSessions } from "./boot-reconcile.js";
import { createWorkspace } from "../workspaces.js";
import { appendHistoryEvent, readHistory, type PaSessionHistoryEvent } from "../workspace-history.js";

let tempDir: string;
let clio: LocalClio;
const origConfigDir = process.env.CFCF_CONFIG_DIR;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "cfcf-pa-reconcile-test-"));
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

async function seedRunningPaEvent(opts: {
  workspaceId: string;
  workspaceRepoPath: string;
  sessionId: string;
  sessionContentChars?: number;
  fileMtime?: Date;
}): Promise<PaSessionHistoryEvent> {
  const sessionFilePath = `.cfcf-pa/session-${opts.sessionId}.md`;
  const absSessionFile = join(opts.workspaceRepoPath, sessionFilePath);
  await mkdir(join(opts.workspaceRepoPath, ".cfcf-pa"), { recursive: true });

  if (opts.sessionContentChars !== 0) {
    const content = "# PA session\n\n"
      + Array((opts.sessionContentChars ?? 1000) / 10).fill("Some line.").join("\n")
      + "\n";
    await writeFile(absSessionFile, content, "utf-8");
    if (opts.fileMtime) {
      const t = opts.fileMtime.getTime() / 1000;
      utimesSync(absSessionFile, t, t);
    }
  }

  const event: PaSessionHistoryEvent = {
    id: `pa-${opts.sessionId}`,
    type: "pa-session",
    status: "running",
    startedAt: new Date().toISOString(),
    sessionId: opts.sessionId,
    sessionFilePath,
    agent: "claude-code",
    model: "sonnet",
    workspaceRegisteredAtStart: true,
    gitInitializedAtStart: true,
    problemPackFilesAtStart: 0,
    logFile: sessionFilePath,
  };
  await appendHistoryEvent(opts.workspaceId, event);
  return event;
}

describe("reconcileStalePaSessions", () => {
  it("flips stale running PA events to failed + ingests the session archive", async () => {
    const w = await createWorkspace({ name: "tracker", repoPath: tempDir });
    // Backdate the session file 10 minutes (well past the 5-min default).
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    const ev = await seedRunningPaEvent({
      workspaceId: w.id,
      workspaceRepoPath: w.repoPath,
      sessionId: "pa-2026-05-09T10-00-00-stale01",
      fileMtime: tenMinAgo,
    });

    const result = await reconcileStalePaSessions();
    expect(result.staleEvents).toBe(1);
    expect(result.archivedToClio).toBe(1);

    // History event should now be `failed`.
    const evs = await readHistory(w.id);
    const updated = evs.find((e) => e.id === ev.id) as PaSessionHistoryEvent;
    expect(updated.status).toBe("failed");
    expect(updated.error).toContain("Process detection lost");

    // Clio should have the archive in the workspace's effective project.
    const docs = await clio.listDocuments({ project: `cf-workspace-${w.id}` });
    expect(docs.find((d) => d.title === `pa-session-${ev.sessionId}`)).toBeTruthy();
  });

  it("leaves LIVE running PA events alone (mtime within the staleness threshold)", async () => {
    const w = await createWorkspace({ name: "live-ws", repoPath: tempDir });
    // mtime defaults to now → well within the 5-min threshold.
    const ev = await seedRunningPaEvent({
      workspaceId: w.id,
      workspaceRepoPath: w.repoPath,
      sessionId: "pa-2026-05-09T10-30-00-live01",
    });

    const result = await reconcileStalePaSessions();
    expect(result.staleEvents).toBe(0);
    expect(result.archivedToClio).toBe(0);

    // Event should still be `running`.
    const evs = await readHistory(w.id);
    const same = evs.find((e) => e.id === ev.id);
    expect(same?.status).toBe("running");
  });

  it("flips events with missing session files to failed but doesn't ingest (no content)", async () => {
    const w = await createWorkspace({ name: "no-content-ws", repoPath: tempDir });
    // Event with NO session file on disk (e.g. cfcf launched but the
    // agent crashed before writing anything).
    const ev = await seedRunningPaEvent({
      workspaceId: w.id,
      workspaceRepoPath: w.repoPath,
      sessionId: "pa-2026-05-09T11-00-00-empty01",
      sessionContentChars: 0, // no file written
    });

    const result = await reconcileStalePaSessions();
    expect(result.staleEvents).toBe(1);
    expect(result.archivedToClio).toBe(0);
    expect(result.staleNoContent).toBe(1);

    const evs = await readHistory(w.id);
    const updated = evs.find((e) => e.id === ev.id) as PaSessionHistoryEvent;
    expect(updated.status).toBe("failed");
  });

  it("respects an explicit shared clioProject for the rescue ingest", async () => {
    const w = await createWorkspace({
      name: "shared-ws",
      repoPath: tempDir,
      clioProject: "backend-services",
    });
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    const ev = await seedRunningPaEvent({
      workspaceId: w.id,
      workspaceRepoPath: w.repoPath,
      sessionId: "pa-2026-05-09T11-30-00-shared01",
      fileMtime: tenMinAgo,
    });

    const result = await reconcileStalePaSessions();
    expect(result.staleEvents).toBe(1);
    expect(result.archivedToClio).toBe(1);

    // Archive landed in the shared project, not cf-workspace-<id>.
    const sharedDocs = await clio.listDocuments({ project: "backend-services" });
    expect(sharedDocs.find((d) => d.title === `pa-session-${ev.sessionId}`)).toBeTruthy();
    const fallbackDocs = await clio.listDocuments({ project: `cf-workspace-${w.id}` });
    expect(fallbackDocs.find((d) => d.title === `pa-session-${ev.sessionId}`)).toBeFalsy();
  });

  it("is idempotent: a second run is a no-op (sha256 dedup + already-failed events are skipped)", async () => {
    const w = await createWorkspace({ name: "idem-ws", repoPath: tempDir });
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    await seedRunningPaEvent({
      workspaceId: w.id,
      workspaceRepoPath: w.repoPath,
      sessionId: "pa-2026-05-09T12-00-00-idem01",
      fileMtime: tenMinAgo,
    });

    const r1 = await reconcileStalePaSessions();
    expect(r1.staleEvents).toBe(1);
    expect(r1.archivedToClio).toBe(1);

    const r2 = await reconcileStalePaSessions();
    // After r1 the event is `failed`, no longer `running`, so r2's
    // filter (status === "running") doesn't match → no scan, no
    // re-ingest.
    expect(r2.staleEvents).toBe(0);
    expect(r2.archivedToClio).toBe(0);
  });

  it("scans across multiple workspaces in one pass", async () => {
    const w1 = await createWorkspace({ name: "ws-a", repoPath: join(tempDir, "a") });
    const w2 = await createWorkspace({ name: "ws-b", repoPath: join(tempDir, "b") });
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    await seedRunningPaEvent({
      workspaceId: w1.id, workspaceRepoPath: w1.repoPath,
      sessionId: "pa-A", fileMtime: tenMinAgo,
    });
    await seedRunningPaEvent({
      workspaceId: w2.id, workspaceRepoPath: w2.repoPath,
      sessionId: "pa-B", fileMtime: tenMinAgo,
    });

    const result = await reconcileStalePaSessions();
    expect(result.scannedWorkspaces).toBeGreaterThanOrEqual(2);
    expect(result.staleEvents).toBe(2);
    expect(result.archivedToClio).toBe(2);
    expect(result.perWorkspace.length).toBe(2);
  });

  it("respects a custom staleAfterMs threshold", async () => {
    const w = await createWorkspace({ name: "custom-thresh-ws", repoPath: tempDir });
    // mtime = 30 seconds ago — under the default 5-min threshold,
    // OVER a 10-second custom threshold.
    const thirtySecAgo = new Date(Date.now() - 30 * 1000);
    await seedRunningPaEvent({
      workspaceId: w.id, workspaceRepoPath: w.repoPath,
      sessionId: "pa-thresh01", fileMtime: thirtySecAgo,
    });

    const lenient = await reconcileStalePaSessions({ staleAfterMs: 5 * 60 * 1000 });
    expect(lenient.staleEvents).toBe(0);

    const strict = await reconcileStalePaSessions({ staleAfterMs: 10 * 1000 });
    expect(strict.staleEvents).toBe(1);
  });

  it("rescues mid-edit problem-pack files when PA died before session-end fallback (item 6.9 follow-up)", async () => {
    // Scenario: PA was running, edited problem.md + success.md, then
    // the user Ctrl-C'd the parent shell. Session-end fallback never
    // fired → problem-pack edits trapped on disk. Boot reconciliation
    // should pick them up.
    const w = await createWorkspace({ name: "pp-rescue-ws", repoPath: tempDir });
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    await seedRunningPaEvent({
      workspaceId: w.id,
      workspaceRepoPath: w.repoPath,
      sessionId: "pa-2026-05-10T08-00-00-pprescue01",
      fileMtime: tenMinAgo,
    });

    // Seed problem-pack files PA "left behind".
    await mkdir(join(w.repoPath, "cfcf-docs"), { recursive: true });
    await writeFile(
      join(w.repoPath, "cfcf-docs", "problem.md"),
      "# Problem\n\nPA was refining this when the shell got Ctrl-C'd.\n",
      "utf-8",
    );
    await writeFile(
      join(w.repoPath, "cfcf-docs", "success.md"),
      "# Success criteria\n\nUpdated by PA right before the crash.\n",
      "utf-8",
    );

    const result = await reconcileStalePaSessions();
    expect(result.staleEvents).toBe(1);

    // Both the session archive AND the problem-pack files should land
    // in the workspace's effective Clio Project.
    const docs = await clio.listDocuments({ project: `cf-workspace-${w.id}` });
    expect(docs.find((d) => d.title.startsWith("pa-session-"))).toBeTruthy();

    const problemDoc = docs.find((d) => d.title.endsWith("problem-pack problem.md"));
    const successDoc = docs.find((d) => d.title.endsWith("problem-pack success.md"));
    expect(problemDoc).toBeTruthy();
    expect(successDoc).toBeTruthy();

    // Author stamp should be PA's, not the default user stamp — the
    // audit log accurately attributes the rescue write to PA.
    expect(problemDoc?.author).toMatch(/^product-architect\|/);

    // ingest_trigger metadata distinguishes boot-reconcile from the
    // happy-path session-end + iteration-start triggers.
    expect((problemDoc?.metadata as Record<string, unknown>)?.ingest_trigger).toBe("pa-boot-reconcile");
  });
});
