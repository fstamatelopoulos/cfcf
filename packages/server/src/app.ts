/**
 * Hono application setup.
 *
 * Separated from the server start logic so it can be tested
 * without actually binding to a port.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { join, dirname } from "path";
import { VERSION, DEFAULT_PORT } from "@cfcf/core";
import { configExists, readConfig } from "@cfcf/core";
import {
  createProject,
  listProjects,
  getProject,
  findProjectByName,
  updateProject,
  deleteProject,
  validateProjectRepo,
} from "@cfcf/core";
import { getIterationLogPath } from "@cfcf/core";
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
  startDocument,
  getDocumentState,
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

  // --- Projects ---

  app.post("/api/projects", async (c) => {
    const body = await c.req.json<{
      name: string;
      repoPath: string;
      repoUrl?: string;
      devAgent?: { adapter: string; model?: string };
      judgeAgent?: { adapter: string; model?: string };
      architectAgent?: { adapter: string; model?: string };
      documenterAgent?: { adapter: string; model?: string };
      maxIterations?: number;
      pauseEvery?: number;
    }>();

    if (!body.name || !body.repoPath) {
      return c.json({ error: "name and repoPath are required" }, 400);
    }

    const validation = await validateProjectRepo(body.repoPath);
    if (!validation.valid) {
      return c.json({ error: validation.error }, 400);
    }

    const project = await createProject(body);
    return c.json(project, 201);
  });

  app.get("/api/projects", async (c) => {
    const projects = await listProjects();
    return c.json(projects);
  });

  app.get("/api/projects/:id", async (c) => {
    const project =
      (await getProject(c.req.param("id"))) ??
      (await findProjectByName(c.req.param("id")));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    return c.json(project);
  });

  app.put("/api/projects/:id", async (c) => {
    const body = await c.req.json();
    const updated = await updateProject(c.req.param("id"), body);
    if (!updated) {
      return c.json({ error: "Project not found" }, 404);
    }
    return c.json(updated);
  });

  app.delete("/api/projects/:id", async (c) => {
    const success = await deleteProject(c.req.param("id"));
    if (!success) {
      return c.json({ error: "Project not found" }, 404);
    }
    return c.json({ deleted: true });
  });

  // --- Iterate (async) ---

  app.post("/api/projects/:id/iterate", async (c) => {
    const project =
      (await getProject(c.req.param("id"))) ??
      (await findProjectByName(c.req.param("id")));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const body = await c.req.json<{
      command?: string;
      args?: string[];
      problemPackPath?: string;
    }>().catch(() => ({} as { command?: string; args?: string[]; problemPackPath?: string }));

    try {
      // Start iteration in background -- returns immediately
      const state = await startIteration(project, body);

      return c.json({
        iteration: state.iteration,
        branch: state.branch,
        mode: state.mode,
        status: state.status,
        logFile: state.logFile,
        message: "Iteration started. Poll GET /api/projects/:id/iterations/:n/status for progress.",
      }, 202);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // --- Iteration status ---

  app.get("/api/projects/:id/iterations/latest", async (c) => {
    const project =
      (await getProject(c.req.param("id"))) ??
      (await findProjectByName(c.req.param("id")));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const state = getLatestIterationState(project.id);
    if (!state) {
      return c.json({ error: "No iterations found" }, 404);
    }

    const { logLines, ...stateWithoutLogs } = state;
    return c.json(stateWithoutLogs);
  });

  app.get("/api/projects/:id/iterations/:n/status", async (c) => {
    const project =
      (await getProject(c.req.param("id"))) ??
      (await findProjectByName(c.req.param("id")));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const iterationNum = parseInt(c.req.param("n"), 10);
    const state = getIterationState(project.id, iterationNum);
    if (!state) {
      return c.json({ error: "Iteration not found" }, 404);
    }

    const { logLines, ...stateWithoutLogs } = state;
    return c.json(stateWithoutLogs);
  });

  // --- SSE endpoint for streaming iteration logs ---

  app.get("/api/projects/:id/iterations/:n/logs", async (c) => {
    const project =
      (await getProject(c.req.param("id"))) ??
      (await findProjectByName(c.req.param("id")));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const iterationNum = parseInt(c.req.param("n"), 10);

    return streamSSE(c, async (stream) => {
      // Try live state first (for in-progress iterations)
      const state = getIterationState(project.id, iterationNum);

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
      const logFile = getIterationLogPath(project.id, iterationNum, "dev");

      // Check if this iteration is part of an active loop
      const loopState = await getLoopState(project.id);
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
          const currentLoop = await getLoopState(project.id);
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

  app.post("/api/projects/:id/review", async (c) => {
    const project =
      (await getProject(c.req.param("id"))) ??
      (await findProjectByName(c.req.param("id")));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const body = await c.req.json<{
      problemPackPath?: string;
    }>().catch(() => ({} as { problemPackPath?: string }));

    try {
      const state = await startReview(project, body);
      return c.json({
        projectId: state.projectId,
        status: state.status,
        logFile: state.logFile,
        message: "Architect review started. Poll GET /api/projects/:id/review/status for progress.",
      }, 202);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.get("/api/projects/:id/review/status", async (c) => {
    const project =
      (await getProject(c.req.param("id"))) ??
      (await findProjectByName(c.req.param("id")));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const state = getReviewState(project.id);
    if (!state) {
      return c.json({ error: "No review found for this project" }, 404);
    }

    return c.json(state);
  });

  // --- Documenter ---

  app.post("/api/projects/:id/document", async (c) => {
    const project =
      (await getProject(c.req.param("id"))) ??
      (await findProjectByName(c.req.param("id")));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    try {
      const state = await startDocument(project);
      return c.json({
        projectId: state.projectId,
        status: state.status,
        logFile: state.logFile,
        message: "Documenter started. Poll GET /api/projects/:id/document/status for progress.",
      }, 202);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.get("/api/projects/:id/document/status", async (c) => {
    const project =
      (await getProject(c.req.param("id"))) ??
      (await findProjectByName(c.req.param("id")));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const state = getDocumentState(project.id);
    if (!state) {
      return c.json({ error: "No documenter run found for this project" }, 404);
    }

    return c.json(state);
  });

  // --- Iteration Loop (dark factory) ---

  app.post("/api/projects/:id/loop/start", async (c) => {
    const project =
      (await getProject(c.req.param("id"))) ??
      (await findProjectByName(c.req.param("id")));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const body = await c.req.json<{
      problemPackPath?: string;
    }>().catch(() => ({} as { problemPackPath?: string }));

    try {
      const state = await startLoop(project, body);
      return c.json({
        projectId: state.projectId,
        phase: state.phase,
        maxIterations: state.maxIterations,
        pauseEvery: state.pauseEvery,
        message: "Iteration loop started. Poll GET /api/projects/:id/loop/status for progress.",
      }, 202);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  app.get("/api/projects/:id/loop/status", async (c) => {
    const project =
      (await getProject(c.req.param("id"))) ??
      (await findProjectByName(c.req.param("id")));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const state = await getLoopState(project.id);
    if (!state) {
      return c.json({ error: "No active loop for this project" }, 404);
    }

    return c.json(state);
  });

  app.post("/api/projects/:id/loop/resume", async (c) => {
    const project =
      (await getProject(c.req.param("id"))) ??
      (await findProjectByName(c.req.param("id")));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const body = await c.req.json<{
      feedback?: string;
    }>().catch(() => ({} as { feedback?: string }));

    try {
      const state = await resumeLoop(project.id, body.feedback);
      return c.json({
        projectId: state.projectId,
        phase: state.phase,
        currentIteration: state.currentIteration,
        message: "Loop resumed.",
      }, 202);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  app.post("/api/projects/:id/loop/stop", async (c) => {
    const project =
      (await getProject(c.req.param("id"))) ??
      (await findProjectByName(c.req.param("id")));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    try {
      const state = await stopLoop(project.id);
      return c.json({
        projectId: state.projectId,
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

  app.get("/api/projects/:id/loop/events", async (c) => {
    const project =
      (await getProject(c.req.param("id"))) ??
      (await findProjectByName(c.req.param("id")));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    return streamSSE(c, async (stream) => {
      let lastPhase = "";
      let lastIteration = 0;

      while (true) {
        const state = await getLoopState(project.id);
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

  // --- Static file serving (Web GUI) ---

  // Resolve the path to packages/web/dist/ relative to this file
  const webDistPath = join(dirname(new URL(import.meta.url).pathname), "..", "..", "web", "dist");

  // Serve static files from the web build directory
  app.use("/*", serveStatic({ root: webDistPath }));

  // SPA fallback: serve index.html for non-API routes that don't match a file
  app.get("*", serveStatic({ root: webDistPath, path: "/index.html" }));

  // --- Server shutdown ---

  app.post("/api/shutdown", (c) => {
    setTimeout(() => process.exit(0), 100);
    return c.json({ status: "shutting down" });
  });

  return app;
}
