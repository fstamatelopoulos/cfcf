/**
 * Hono application setup.
 *
 * Separated from the server start logic so it can be tested
 * without actually binding to a port.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
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
  nextIteration,
} from "@cfcf/core";
import { spawnProcess } from "@cfcf/core";
import * as gitManager from "@cfcf/core";
import { getIterationLogPath, ensureProjectLogDir } from "@cfcf/core";

const startedAt = Date.now();

export function createApp() {
  const app = new Hono();

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

  // --- Execute an iteration ---

  app.post("/api/projects/:id/iterate", async (c) => {
    const project =
      (await getProject(c.req.param("id"))) ??
      (await findProjectByName(c.req.param("id")));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const body = await c.req.json<{
      command: string;
      args?: string[];
    }>();

    if (!body.command) {
      return c.json({ error: "command is required" }, 400);
    }

    // Get next iteration number
    const iterationNum = await nextIteration(project.id);
    if (iterationNum === null) {
      return c.json({ error: "Failed to increment iteration counter" }, 500);
    }

    // Create feature branch
    const branchName = `cfcf/iteration-${iterationNum}`;
    const branchResult = await gitManager.createBranch(project.repoPath, branchName);
    if (!branchResult.success) {
      return c.json({ error: `Failed to create branch: ${branchResult.error}` }, 500);
    }

    // Prepare log path
    const logFile = getIterationLogPath(project.id, iterationNum, "dev");
    await ensureProjectLogDir(project.id);

    // Spawn the process
    const managed = spawnProcess({
      command: body.command,
      args: body.args ?? [],
      cwd: project.repoPath,
      logFile,
    });

    // Wait for result
    const result = await managed.result;

    // Commit changes if any
    let committed = false;
    if (await gitManager.hasChanges(project.repoPath)) {
      const commitResult = await gitManager.commitAll(
        project.repoPath,
        `cfcf iteration ${iterationNum}: ${body.command} ${(body.args ?? []).join(" ")}`,
      );
      committed = commitResult.success;
    }

    return c.json({
      iteration: iterationNum,
      branch: branchName,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      logFile: result.logFile,
      committed,
      killed: result.killed,
    });
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
    const logFile = getIterationLogPath(project.id, iterationNum, "dev");

    return streamSSE(c, async (stream) => {
      try {
        const content = await Bun.file(logFile).text();
        const lines = content.split("\n");
        for (const line of lines) {
          if (line.length > 0) {
            await stream.writeSSE({
              event: "log",
              data: line,
            });
          }
        }
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({ message: "Log stream complete" }),
        });
      } catch {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: "Log file not found" }),
        });
      }
    });
  });

  // --- Server shutdown ---

  app.post("/api/shutdown", (c) => {
    setTimeout(() => process.exit(0), 100);
    return c.json({ status: "shutting down" });
  });

  return app;
}
