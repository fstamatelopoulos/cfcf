/**
 * Hono application setup.
 *
 * Separated from the server start logic so it can be tested
 * without actually binding to a port.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { loadAsset, loadIndex } from "./web-assets.js";
import { cors } from "hono/cors";
import { VERSION, DEFAULT_PORT } from "@cfcf/core";
import { configExists, readConfig, writeConfig, validateConfig } from "@cfcf/core";
import type { CfcfGlobalConfig } from "@cfcf/core";
import { registerClioRoutes } from "./routes/clio.js";
import { registerHelpRoutes } from "./routes/help.js";
import {
  createWorkspace,
  listWorkspaces,
  getWorkspace,
  findWorkspaceByName,
  updateWorkspace,
  deleteWorkspace,
  validateWorkspaceRepo,
} from "@cfcf/core";
import { getIterationLogPath, getLogPathByFilename, readHistory } from "@cfcf/core";
import {
  startIteration,
  getIterationState,
  getLatestIterationState,
} from "./iteration-runner.js";
import {
  startLoop,
  resumeLoop,
  stopLoop,
  getLoopState,
  startReview,
  getReviewState,
  stopReview,
  startDocument,
  getDocumentState,
  stopDocument,
  startReflection,
  getReflectState,
  stopReflection,
} from "@cfcf/core";

const startedAt = Date.now();

export function createApp() {
  const app = new Hono();

  // CORS for development (Vite dev server on different port)
  app.use("/api/*", cors());

  // --- Health / Status ---

  app.get("/api/health", (c) => {
    return c.json({
      status: "ok",
      version: VERSION,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
    });
  });

  // --- Activity (cross-workspace) ---
  //
  // Returns a compact list of currently-running agent runs across all
  // workspaces. Drives the blue pulsing dot + phase label in the web header
  // so the user can see "something is running" at a glance from any page.
  //
  // Implementation: read each workspace's history.json + loop-state.json.
  // History events with status="running" are the source of truth for
  // review / document / reflection. For loop iterations we also pick up
  // the current phase from loop-state.json (which has finer-grained
  // phase info -- preparing/dev_executing/judging/reflecting/etc.).
  app.get("/api/activity", async (c) => {
    const workspaces = await listWorkspaces();
    const items: Array<{
      workspaceId: string;
      workspaceName: string;
      type: "iteration" | "review" | "document" | "reflection";
      phase?: string; // LoopPhase when type=iteration
      iteration?: number;
      startedAt: string;
    }> = [];
    for (const w of workspaces) {
      const history = await readHistory(w.id);
      const running = history.filter((e) => e.status === "running");
      // Loop-state gives a finer-grained phase for the current iteration.
      const loopState = await getLoopState(w.id);
      const activeLoopPhases = [
        "pre_loop_reviewing", "preparing", "dev_executing", "judging",
        "reflecting", "deciding", "documenting",
      ];
      const loopActive = loopState && activeLoopPhases.includes(loopState.phase);

      // If the loop is active, emit a single item reflecting its current phase
      // (more informative than the raw "running" iteration event, which
      // stays `running` across dev/judge/reflect phases).
      if (loopActive) {
        items.push({
          workspaceId: w.id,
          workspaceName: w.name,
          type: "iteration",
          phase: loopState.phase,
          iteration: loopState.currentIteration,
          startedAt: loopState.startedAt,
        });
        continue; // skip raw history "running" entries when loop state is authoritative
      }

      // Otherwise fall back to whatever's running in history (review,
      // document, ad-hoc reflection, or an iteration stuck at "running"
      // after a crash that we haven't cleaned up yet).
      for (const e of running) {
        items.push({
          workspaceId: w.id,
          workspaceName: w.name,
          type: e.type as "iteration" | "review" | "document" | "reflection",
          iteration:
            e.type === "iteration" || e.type === "reflection"
              ? (e as { iteration?: number }).iteration
              : undefined,
          startedAt: e.startedAt,
        });
      }
    }
    return c.json({ active: items });
  });

  app.get("/api/status", async (c) => {
    const hasConfig = await configExists();
    const config = hasConfig ? await readConfig() : null;

    return c.json({
      status: "running",
      version: VERSION,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      pid: process.pid,
      port: parseInt(process.env.CFCF_PORT || String(DEFAULT_PORT), 10),
      configured: hasConfig,
      availableAgents: config?.availableAgents ?? [],
    });
  });

  // --- Config ---

  app.get("/api/config", async (c) => {
    const config = await readConfig();
    if (!config) {
      return c.json(
        { error: "Not configured. Run 'cfcf init' to set up." },
        404,
      );
    }
    return c.json(config);
  });

  // Edit the global config (item 5.9). Accepts a full `CfcfGlobalConfig`
  // body or a partial patch; we merge the patch onto the existing config
  // before validation so the client can send only the fields it changed.
  // `permissionsAcknowledged` and `availableAgents` are server-owned and
  // are NOT overridable via this endpoint -- they're preserved from the
  // current config. Returns the saved config so the client can refresh.
  app.put("/api/config", async (c) => {
    const existing = await readConfig();
    if (!existing) {
      return c.json(
        { error: "Not configured. Run 'cfcf init' to set up before editing." },
        404,
      );
    }
    let patch: Partial<CfcfGlobalConfig>;
    try {
      patch = await c.req.json<Partial<CfcfGlobalConfig>>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    // Preserve server-owned fields regardless of what the client sent
    const merged: CfcfGlobalConfig = {
      ...existing,
      ...patch,
      version: existing.version,
      permissionsAcknowledged: existing.permissionsAcknowledged,
      availableAgents: existing.availableAgents,
    };
    let validated: CfcfGlobalConfig;
    try {
      validated = validateConfig(merged);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
    // Extra guards beyond validateConfig's backfill-friendly rules
    if (typeof validated.maxIterations !== "number" || validated.maxIterations < 1) {
      return c.json({ error: "maxIterations must be a positive integer" }, 400);
    }
    if (typeof validated.pauseEvery !== "number" || validated.pauseEvery < 0) {
      return c.json({ error: "pauseEvery must be zero or a positive integer" }, 400);
    }
    try {
      await writeConfig(validated);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Failed to write config: ${message}` }, 500);
    }
    return c.json(validated);
  });

  // --- Workspaces ---

  app.post("/api/workspaces", async (c) => {
    const body = await c.req.json<{
      name: string;
      repoPath: string;
      devAgent?: { adapter: string; model?: string };
      judgeAgent?: { adapter: string; model?: string };
      architectAgent?: { adapter: string; model?: string };
      documenterAgent?: { adapter: string; model?: string };
      maxIterations?: number;
      pauseEvery?: number;
      clioProject?: string;
    }>();

    if (!body.name || !body.repoPath) {
      return c.json({ error: "name and repoPath are required" }, 400);
    }

    const validation = await validateWorkspaceRepo(body.repoPath);
    if (!validation.valid) {
      return c.json({ error: validation.error }, 400);
    }

    const workspace = await createWorkspace(body);
    return c.json(workspace, 201);
  });

  app.get("/api/workspaces", async (c) => {
    const workspaces = await listWorkspaces();
    return c.json(workspaces);
  });

  app.get("/api/workspaces/:id", async (c) => {
    const workspace =
      (await getWorkspace(c.req.param("id"))) ??
      (await findWorkspaceByName(c.req.param("id")));
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }
    return c.json(workspace);
  });

  // Edit per-workspace config (item 6.14). Accepts a partial patch; server
  // merges onto the existing workspace config, preserves identity + runtime
  // fields regardless of client input (id, name, repoPath,
  // currentIteration, status, processTemplate), validates bounded + enum
  // fields, and writes. Returns the saved config.
  app.put("/api/workspaces/:id", async (c) => {
    const id = c.req.param("id");
    const existing =
      (await getWorkspace(id)) ?? (await findWorkspaceByName(id));
    if (!existing) {
      return c.json({ error: "Workspace not found" }, 404);
    }
    let patch: Record<string, unknown>;
    try {
      patch = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // Validate bounded numeric fields
    if ("maxIterations" in patch) {
      const n = patch.maxIterations;
      if (typeof n !== "number" || n < 1) {
        return c.json({ error: "maxIterations must be a positive integer" }, 400);
      }
    }
    if ("pauseEvery" in patch) {
      const n = patch.pauseEvery;
      if (typeof n !== "number" || n < 0) {
        return c.json({ error: "pauseEvery must be zero or a positive integer" }, 400);
      }
    }
    if ("reflectSafeguardAfter" in patch) {
      const n = patch.reflectSafeguardAfter;
      if (typeof n !== "number" || n < 1) {
        return c.json({ error: "reflectSafeguardAfter must be a positive integer" }, 400);
      }
    }
    // Validate enums
    if ("onStalled" in patch) {
      const v = patch.onStalled;
      if (v !== "continue" && v !== "stop" && v !== "alert") {
        return c.json(
          { error: "onStalled must be 'continue' | 'stop' | 'alert'" },
          400,
        );
      }
    }
    if ("mergeStrategy" in patch) {
      const v = patch.mergeStrategy;
      if (v !== "auto" && v !== "pr") {
        return c.json({ error: "mergeStrategy must be 'auto' | 'pr'" }, 400);
      }
    }
    if ("readinessGate" in patch) {
      const v = patch.readinessGate;
      if (
        v !== "never" &&
        v !== "blocked" &&
        v !== "needs_refinement_or_blocked"
      ) {
        return c.json(
          {
            error:
              "readinessGate must be 'never' | 'blocked' | 'needs_refinement_or_blocked'",
          },
          400,
        );
      }
    }
    // Validate agent roles have an adapter field if present
    for (const roleKey of [
      "devAgent",
      "judgeAgent",
      "architectAgent",
      "documenterAgent",
      "reflectionAgent",
    ]) {
      if (roleKey in patch) {
        const a = patch[roleKey] as { adapter?: string } | undefined;
        if (a && (!a.adapter || typeof a.adapter !== "string")) {
          return c.json(
            { error: `${roleKey}.adapter is required when setting ${roleKey}` },
            400,
          );
        }
      }
    }

    // Strip identity + runtime fields from the patch -- they are
    // server-owned. The client cannot change them via this endpoint.
    const IMMUTABLE_FIELDS = [
      "id",
      "name",
      "repoPath",
      "currentIteration",
      "status",
      "processTemplate", // only "default" today; rename happens in 6.8
    ] as const;
    for (const f of IMMUTABLE_FIELDS) {
      if (f in patch) delete (patch as Record<string, unknown>)[f];
    }

    // Special case: `notifications: null` means "clear the per-workspace
    // override, inherit global". Drop the field so the saved config
    // omits it.
    if ("notifications" in patch && patch.notifications === null) {
      (patch as Record<string, unknown>).notifications = undefined;
    }

    const updated = await updateWorkspace(existing.id, patch);
    if (!updated) {
      return c.json({ error: "Workspace not found" }, 404);
    }
    return c.json(updated);
  });

  app.delete("/api/workspaces/:id", async (c) => {
    const success = await deleteWorkspace(c.req.param("id"));
    if (!success) {
      return c.json({ error: "Workspace not found" }, 404);
    }
    return c.json({ deleted: true });
  });

  // --- Iterate (async) ---

  app.post("/api/workspaces/:id/iterate", async (c) => {
    const workspace =
      (await getWorkspace(c.req.param("id"))) ??
      (await findWorkspaceByName(c.req.param("id")));
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const body = await c.req.json<{
      command?: string;
      args?: string[];
      problemPackPath?: string;
    }>().catch(() => ({} as { command?: string; args?: string[]; problemPackPath?: string }));

    try {
      // Start iteration in background -- returns immediately
      const state = await startIteration(workspace, body);

      return c.json({
        iteration: state.iteration,
        branch: state.branch,
        mode: state.mode,
        status: state.status,
        logFile: state.logFile,
        message: "Iteration started. Poll GET /api/workspaces/:id/iterations/:n/status for progress.",
      }, 202);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // --- Iteration status ---

  app.get("/api/workspaces/:id/iterations/latest", async (c) => {
    const workspace =
      (await getWorkspace(c.req.param("id"))) ??
      (await findWorkspaceByName(c.req.param("id")));
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const state = getLatestIterationState(workspace.id);
    if (!state) {
      return c.json({ error: "No iterations found" }, 404);
    }

    const { logLines, ...stateWithoutLogs } = state;
    return c.json(stateWithoutLogs);
  });

  app.get("/api/workspaces/:id/iterations/:n/status", async (c) => {
    const workspace =
      (await getWorkspace(c.req.param("id"))) ??
      (await findWorkspaceByName(c.req.param("id")));
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const iterationNum = parseInt(c.req.param("n"), 10);
    const state = getIterationState(workspace.id, iterationNum);
    if (!state) {
      return c.json({ error: "Iteration not found" }, 404);
    }

    const { logLines, ...stateWithoutLogs } = state;
    return c.json(stateWithoutLogs);
  });

  // --- SSE endpoint for streaming iteration logs ---

  app.get("/api/workspaces/:id/iterations/:n/logs", async (c) => {
    const workspace =
      (await getWorkspace(c.req.param("id"))) ??
      (await findWorkspaceByName(c.req.param("id")));
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const iterationNum = parseInt(c.req.param("n"), 10);

    return streamSSE(c, async (stream) => {
      // Try live state first (for in-progress iterations)
      const state = getIterationState(workspace.id, iterationNum);

      if (state) {
        // Stream from live state -- poll until done
        let lastIndex = 0;
        while (state.status === "preparing" || state.status === "executing" || state.status === "collecting") {
          // Send any new log lines
          while (lastIndex < state.logLines.length) {
            await stream.writeSSE({ event: "log", data: state.logLines[lastIndex] });
            lastIndex++;
          }
          // Send status update
          await stream.writeSSE({
            event: "status",
            data: JSON.stringify({ status: state.status, iteration: iterationNum }),
          });
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        // Send remaining log lines
        while (lastIndex < state.logLines.length) {
          await stream.writeSSE({ event: "log", data: state.logLines[lastIndex] });
          lastIndex++;
        }
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({
            status: state.status,
            exitCode: state.exitCode,
            durationMs: state.durationMs,
          }),
        });
        return;
      }

      // Fall back to reading from log file (works for both completed and in-progress iterations)
      const logFile = getIterationLogPath(workspace.id, iterationNum, "dev");

      // Check if this iteration is part of an active loop
      const loopState = await getLoopState(workspace.id);
      const isLiveIteration = loopState &&
        loopState.currentIteration === iterationNum &&
        ["preparing", "dev_executing", "judging", "deciding", "documenting"].includes(loopState.phase);

      let lastSize = 0;
      let retries = 0;

      try {
        while (true) {
          const file = Bun.file(logFile);
          const exists = await file.exists();

          if (exists) {
            const content = await file.text();
            if (content.length > lastSize) {
              const newContent = content.slice(lastSize);
              const lines = newContent.split("\n");
              for (const line of lines) {
                if (line.length > 0) {
                  await stream.writeSSE({ event: "log", data: line });
                }
              }
              lastSize = content.length;
              retries = 0;
            }
          }

          // If not a live iteration, we're done after reading once
          if (!isLiveIteration) {
            await stream.writeSSE({
              event: "done",
              data: JSON.stringify({ message: "Log stream complete" }),
            });
            return;
          }

          // For live iterations, check if the loop moved past this iteration
          const currentLoop = await getLoopState(workspace.id);
          const stillLive = currentLoop &&
            currentLoop.currentIteration === iterationNum &&
            ["preparing", "dev_executing", "judging", "deciding", "documenting"].includes(currentLoop.phase);

          if (!stillLive) {
            // Read any final content
            if (exists) {
              const finalContent = await Bun.file(logFile).text();
              if (finalContent.length > lastSize) {
                const remaining = finalContent.slice(lastSize).split("\n");
                for (const line of remaining) {
                  if (line.length > 0) {
                    await stream.writeSSE({ event: "log", data: line });
                  }
                }
              }
            }
            await stream.writeSSE({
              event: "done",
              data: JSON.stringify({ message: "Log stream complete" }),
            });
            return;
          }

          // Wait and poll again
          await new Promise((resolve) => setTimeout(resolve, 1000));
          retries++;
          if (retries > 600) { // 10 minute timeout
            await stream.writeSSE({
              event: "done",
              data: JSON.stringify({ message: "Stream timeout" }),
            });
            return;
          }
        }
      } catch {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: "Log file not found" }),
        });
      }
    });
  });

  // --- Solution Architect Review ---

  app.post("/api/workspaces/:id/review", async (c) => {
    const workspace =
      (await getWorkspace(c.req.param("id"))) ??
      (await findWorkspaceByName(c.req.param("id")));
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const body = await c.req.json<{
      problemPackPath?: string;
    }>().catch(() => ({} as { problemPackPath?: string }));

    try {
      const state = await startReview(workspace, body);
      return c.json({
        workspaceId: state.workspaceId,
        status: state.status,
        logFile: state.logFile,
        message: "Architect review started. Poll GET /api/workspaces/:id/review/status for progress.",
      }, 202);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.get("/api/workspaces/:id/review/status", async (c) => {
    const workspace =
      (await getWorkspace(c.req.param("id"))) ??
      (await findWorkspaceByName(c.req.param("id")));
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const state = getReviewState(workspace.id);
    if (!state) {
      return c.json({ error: "No review found for this workspace" }, 404);
    }

    return c.json(state);
  });

  app.post("/api/workspaces/:id/review/stop", async (c) => {
    const workspace =
      (await getWorkspace(c.req.param("id"))) ??
      (await findWorkspaceByName(c.req.param("id")));
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const state = await stopReview(workspace.id);
    if (!state) {
      return c.json({ error: "No review running for this workspace" }, 404);
    }
    return c.json({ workspaceId: state.workspaceId, status: state.status, message: "Review stopped." });
  });

  // --- Documenter ---

  app.post("/api/workspaces/:id/document", async (c) => {
    const workspace =
      (await getWorkspace(c.req.param("id"))) ??
      (await findWorkspaceByName(c.req.param("id")));
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    try {
      const state = await startDocument(workspace);
      return c.json({
        workspaceId: state.workspaceId,
        status: state.status,
        logFile: state.logFile,
        message: "Documenter started. Poll GET /api/workspaces/:id/document/status for progress.",
      }, 202);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.get("/api/workspaces/:id/document/status", async (c) => {
    const workspace =
      (await getWorkspace(c.req.param("id"))) ??
      (await findWorkspaceByName(c.req.param("id")));
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const state = getDocumentState(workspace.id);
    if (!state) {
      return c.json({ error: "No documenter run found for this workspace" }, 404);
    }

    return c.json(state);
  });

  app.post("/api/workspaces/:id/document/stop", async (c) => {
    const workspace =
      (await getWorkspace(c.req.param("id"))) ??
      (await findWorkspaceByName(c.req.param("id")));
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const state = await stopDocument(workspace.id);
    if (!state) {
      return c.json({ error: "No documenter running for this workspace" }, 404);
    }
    return c.json({ workspaceId: state.workspaceId, status: state.status, message: "Documenter stopped." });
  });

  // --- Reflection (ad-hoc, item 5.6) ---

  app.post("/api/workspaces/:id/reflect", async (c) => {
    const workspace =
      (await getWorkspace(c.req.param("id"))) ??
      (await findWorkspaceByName(c.req.param("id")));
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }
    const body = await c.req.json<{ prompt?: string }>().catch(() => ({} as { prompt?: string }));
    try {
      const state = await startReflection(workspace, body);
      return c.json({
        workspaceId: state.workspaceId,
        status: state.status,
        logFile: state.logFile,
        message: "Reflection started. Poll GET /api/workspaces/:id/reflect/status for progress.",
      }, 202);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.get("/api/workspaces/:id/reflect/status", async (c) => {
    const workspace =
      (await getWorkspace(c.req.param("id"))) ??
      (await findWorkspaceByName(c.req.param("id")));
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);
    const state = getReflectState(workspace.id);
    if (!state) return c.json({ error: "No reflection found for this workspace" }, 404);
    return c.json(state);
  });

  app.post("/api/workspaces/:id/reflect/stop", async (c) => {
    const workspace =
      (await getWorkspace(c.req.param("id"))) ??
      (await findWorkspaceByName(c.req.param("id")));
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);
    const state = await stopReflection(workspace.id);
    if (!state) return c.json({ error: "No reflection running for this workspace" }, 404);
    return c.json({ workspaceId: state.workspaceId, status: state.status, message: "Reflection stopped." });
  });

  // --- Workspace history ---

  app.get("/api/workspaces/:id/history", async (c) => {
    const workspace =
      (await getWorkspace(c.req.param("id"))) ??
      (await findWorkspaceByName(c.req.param("id")));
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const events = await readHistory(workspace.id);
    return c.json(events);
  });

  // --- Product Architect session detail (5.14 v2) ---
  //
  // Serves a snapshot of a PA session's files: the session scratchpad
  // (`<repo>/.cfcf-pa/session-<sessionId>.md`), the workspace memory
  // summary the agent maintains across sessions
  // (`<repo>/.cfcf-pa/workspace-summary.md`), and the meta.json. The
  // web UI's PaSessionDetail component renders these in one request.
  //
  // Security: validates `sessionId` against `pa-[A-Za-z0-9-]+` to
  // prevent path traversal. Files are read from the workspace's
  // repoPath/.cfcf-pa/ — no symlink-following beyond what the
  // filesystem allows.
  app.get("/api/workspaces/:id/pa-sessions/:sessionId/file", async (c) => {
    const workspace =
      (await getWorkspace(c.req.param("id"))) ??
      (await findWorkspaceByName(c.req.param("id")));
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }
    const sessionId = c.req.param("sessionId");
    if (!/^pa-[A-Za-z0-9-]+$/.test(sessionId)) {
      return c.json({ error: "Invalid sessionId" }, 400);
    }

    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const cacheDir = join(workspace.repoPath, ".cfcf-pa");

    let sessionContent: string | null = null;
    try {
      sessionContent = await readFile(join(cacheDir, `session-${sessionId}.md`), "utf-8");
    } catch { /* may not exist if the agent never wrote one */ }

    let workspaceSummary: string | null = null;
    try {
      workspaceSummary = await readFile(join(cacheDir, "workspace-summary.md"), "utf-8");
    } catch { /* may not exist */ }

    let meta: Record<string, unknown> | null = null;
    try {
      const raw = await readFile(join(cacheDir, "meta.json"), "utf-8");
      meta = JSON.parse(raw);
    } catch { /* may not exist */ }

    return c.json({
      sessionId,
      cachePath: cacheDir,
      sessionFile: sessionContent,
      sessionFilePath: `.cfcf-pa/session-${sessionId}.md`,
      workspaceSummary,
      workspaceSummaryPath: ".cfcf-pa/workspace-summary.md",
      meta,
    });
  });

  // --- Generic log streaming (by filename) ---

  app.get("/api/workspaces/:id/logs/:filename", async (c) => {
    const workspace =
      (await getWorkspace(c.req.param("id"))) ??
      (await findWorkspaceByName(c.req.param("id")));
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const filename = c.req.param("filename");
    const logPath = getLogPathByFilename(workspace.id, filename);
    if (!logPath) {
      return c.json({ error: "Invalid log filename" }, 400);
    }

    return streamSSE(c, async (stream) => {
      // Determine if the log is for a "live" agent run.
      // For iteration logs: check if loopState.currentIteration matches AND phase is active
      // For architect/documenter logs: check if their state is "running"/"executing"
      let isLive = false;

      if (filename.startsWith("iteration-")) {
        const match = filename.match(/^iteration-(\d+)-(dev|judge)\.log$/);
        if (match) {
          const iterNum = parseInt(match[1], 10);
          const loopState = await getLoopState(workspace.id);
          isLive = !!loopState &&
            loopState.currentIteration === iterNum &&
            ["preparing", "dev_executing", "judging", "deciding", "documenting"].includes(loopState.phase);
        }
      } else if (filename.startsWith("architect-")) {
        const reviewState = getReviewState(workspace.id);
        isLive = !!reviewState &&
          reviewState.logFileName === filename &&
          ["preparing", "executing", "collecting"].includes(reviewState.status);
      } else if (filename.startsWith("documenter-")) {
        const docState = getDocumentState(workspace.id);
        const loopState = await getLoopState(workspace.id);
        // Check both: standalone documenter run OR loop's documenting phase
        isLive = (!!docState && docState.logFileName === filename &&
          ["preparing", "executing"].includes(docState.status)) ||
          (!!loopState && loopState.phase === "documenting");
      } else if (filename.startsWith("reflection-")) {
        const reflectState = getReflectState(workspace.id);
        const loopState = await getLoopState(workspace.id);
        isLive = (!!reflectState && reflectState.logFileName === filename &&
          ["preparing", "executing", "collecting"].includes(reflectState.status)) ||
          (!!loopState && loopState.phase === "reflecting");
      }

      let lastSize = 0;
      let retries = 0;

      try {
        while (true) {
          const file = Bun.file(logPath);
          const exists = await file.exists();

          if (exists) {
            const content = await file.text();
            if (content.length > lastSize) {
              const newContent = content.slice(lastSize);
              const lines = newContent.split("\n");
              for (const line of lines) {
                if (line.length > 0) {
                  await stream.writeSSE({ event: "log", data: line });
                }
              }
              lastSize = content.length;
              retries = 0;
            }
          }

          if (!isLive) {
            await stream.writeSSE({
              event: "done",
              data: JSON.stringify({ message: "Log stream complete" }),
            });
            return;
          }

          // Re-check live status
          if (filename.startsWith("iteration-")) {
            const match = filename.match(/^iteration-(\d+)-(dev|judge)\.log$/);
            if (match) {
              const iterNum = parseInt(match[1], 10);
              const currentLoop = await getLoopState(workspace.id);
              const stillLive = !!currentLoop &&
                currentLoop.currentIteration === iterNum &&
                ["preparing", "dev_executing", "judging", "deciding", "documenting"].includes(currentLoop.phase);
              if (!stillLive) isLive = false;
            }
          } else if (filename.startsWith("architect-")) {
            const reviewState = getReviewState(workspace.id);
            const stillLive = !!reviewState &&
              reviewState.logFileName === filename &&
              ["preparing", "executing", "collecting"].includes(reviewState.status);
            if (!stillLive) isLive = false;
          } else if (filename.startsWith("documenter-")) {
            const docState = getDocumentState(workspace.id);
            const loopState = await getLoopState(workspace.id);
            const stillLive = (!!docState && docState.logFileName === filename &&
              ["preparing", "executing"].includes(docState.status)) ||
              (!!loopState && loopState.phase === "documenting");
            if (!stillLive) isLive = false;
          } else if (filename.startsWith("reflection-")) {
            const reflectState = getReflectState(workspace.id);
            const loopState = await getLoopState(workspace.id);
            const stillLive = (!!reflectState && reflectState.logFileName === filename &&
              ["preparing", "executing", "collecting"].includes(reflectState.status)) ||
              (!!loopState && loopState.phase === "reflecting");
            if (!stillLive) isLive = false;
          }

          if (!isLive) continue; // Will exit on next iteration

          await new Promise((resolve) => setTimeout(resolve, 1000));
          retries++;
          if (retries > 600) {
            await stream.writeSSE({
              event: "done",
              data: JSON.stringify({ message: "Stream timeout" }),
            });
            return;
          }
        }
      } catch {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: "Error reading log file" }),
        });
      }
    });
  });

  // --- Iteration Loop (dark factory) ---

  app.post("/api/workspaces/:id/loop/start", async (c) => {
    const workspace =
      (await getWorkspace(c.req.param("id"))) ??
      (await findWorkspaceByName(c.req.param("id")));
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const body = await c.req.json<{
      problemPackPath?: string;
      autoReviewSpecs?: boolean;
      autoDocumenter?: boolean;
      readinessGate?: "never" | "blocked" | "needs_refinement_or_blocked";
    }>().catch(() => ({}) as {
      problemPackPath?: string;
      autoReviewSpecs?: boolean;
      autoDocumenter?: boolean;
      readinessGate?: "never" | "blocked" | "needs_refinement_or_blocked";
    });

    try {
      const state = await startLoop(workspace, body);
      return c.json({
        workspaceId: state.workspaceId,
        phase: state.phase,
        maxIterations: state.maxIterations,
        pauseEvery: state.pauseEvery,
        message: "Iteration loop started. Poll GET /api/workspaces/:id/loop/status for progress.",
      }, 202);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  app.get("/api/workspaces/:id/loop/status", async (c) => {
    const workspace =
      (await getWorkspace(c.req.param("id"))) ??
      (await findWorkspaceByName(c.req.param("id")));
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const state = await getLoopState(workspace.id);
    if (!state) {
      return c.json({ error: "No active loop for this workspace" }, 404);
    }

    return c.json(state);
  });

  app.post("/api/workspaces/:id/loop/resume", async (c) => {
    const workspace =
      (await getWorkspace(c.req.param("id"))) ??
      (await findWorkspaceByName(c.req.param("id")));
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const body = await c.req.json<{
      feedback?: string;
    }>().catch(() => ({} as { feedback?: string }));

    try {
      const state = await resumeLoop(workspace.id, body.feedback);
      return c.json({
        workspaceId: state.workspaceId,
        phase: state.phase,
        currentIteration: state.currentIteration,
        message: "Loop resumed.",
      }, 202);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  app.post("/api/workspaces/:id/loop/stop", async (c) => {
    const workspace =
      (await getWorkspace(c.req.param("id"))) ??
      (await findWorkspaceByName(c.req.param("id")));
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    try {
      const state = await stopLoop(workspace.id);
      return c.json({
        workspaceId: state.workspaceId,
        phase: state.phase,
        currentIteration: state.currentIteration,
        outcome: state.outcome,
        message: "Loop stopped.",
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // --- Loop Events SSE ---

  app.get("/api/workspaces/:id/loop/events", async (c) => {
    const workspace =
      (await getWorkspace(c.req.param("id"))) ??
      (await findWorkspaceByName(c.req.param("id")));
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    return streamSSE(c, async (stream) => {
      let lastPhase = "";
      let lastIteration = 0;

      while (true) {
        const state = await getLoopState(workspace.id);
        if (!state) {
          await stream.writeSSE({ event: "error", data: JSON.stringify({ error: "No active loop" }) });
          return;
        }

        // Emit state when phase or iteration changes
        if (state.phase !== lastPhase || state.currentIteration !== lastIteration) {
          lastPhase = state.phase;
          lastIteration = state.currentIteration;
          await stream.writeSSE({ event: "state", data: JSON.stringify(state) });
        }

        // Terminal states end the stream
        if (["completed", "failed", "stopped", "paused"].includes(state.phase)) {
          await stream.writeSSE({ event: "done", data: JSON.stringify(state) });
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    });
  });

  // --- Clio (item 5.7) ---
  // Memory layer for cross-workspace knowledge. All routes live under
  // /api/clio/* plus the PUT /api/workspaces/:id/clio-project handler for
  // `cfcf workspace set --project`. Implementation in routes/clio.ts.
  registerClioRoutes(app);

  // /api/help/topics + /api/help/topics/:slug -- powers the web UI
  // Help tab. Reads from the embedded help bundle.
  registerHelpRoutes(app);

  // --- Static file serving (Web GUI) ---
  //
  // The web bundle is embedded into the server module (via
  // `scripts/embed-web-dist.ts` -> `web-assets.generated.ts`). This keeps
  // the compiled binary self-contained. In dev, if the generated file is
  // not yet built, we fall back to reading from `packages/web/dist/` on
  // disk (which is what the fallback path inside `loadAsset` handles).

  app.get("/*", async (c) => {
    const path = c.req.path;
    // API routes never fall into this handler (they're registered before this).
    // Try the literal path first.
    const asset = await loadAsset(path);
    if (asset) {
      return new Response(asset.body as unknown as BodyInit, {
        status: 200,
        headers: { "Content-Type": asset.contentType },
      });
    }
    // SPA fallback: if no asset matches, serve index.html so client-side routing works.
    const index = await loadIndex();
    if (index) {
      return new Response(index.body as unknown as BodyInit, {
        status: 200,
        headers: { "Content-Type": index.contentType },
      });
    }
    return c.text(
      "Web GUI assets are not available. Run `bun run build:web` to produce them, or use the CLI.",
      404,
    );
  });

  // --- Server shutdown ---

  app.post("/api/shutdown", (c) => {
    setTimeout(() => process.exit(0), 100);
    return c.json({ status: "shutting down" });
  });

  return app;
}
