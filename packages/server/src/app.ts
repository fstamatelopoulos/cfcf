/**
 * Hono application setup.
 *
 * Separated from the server start logic so it can be tested
 * without actually binding to a port.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { join } from "path";
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
import { readProblemPack, validateProblemPack } from "@cfcf/core";
import {
  writeContextToRepo,
  generateInstructionContent,
  parseHandoffDocument,
  parseSignalFile,
  generateIterationSummary,
} from "@cfcf/core";
import { getAdapter } from "@cfcf/core";
import type { IterationContext } from "@cfcf/core";

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
      command?: string;
      args?: string[];
      problemPackPath?: string;
    }>().catch(() => ({} as { command?: string; args?: string[]; problemPackPath?: string }));

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

    let command: string;
    let args: string[];
    let mode: "manual" | "agent";

    if (body.command) {
      // Manual mode: user-specified command
      command = body.command;
      args = body.args ?? [];
      mode = "manual";
    } else {
      // Agent mode: use configured dev agent
      const adapter = getAdapter(project.devAgent.adapter);
      if (!adapter) {
        return c.json({ error: `Unknown agent adapter: ${project.devAgent.adapter}` }, 400);
      }

      // Read problem pack and assemble context
      const packPath = body.problemPackPath || join(project.repoPath, "problem-pack");
      const packValidation = await validateProblemPack(packPath);
      if (!packValidation.valid) {
        return c.json({
          error: `Problem Pack invalid: ${packValidation.errors.join(", ")}. Create a problem-pack/ directory with problem.md and success.md.`,
        }, 400);
      }

      const problemPack = await readProblemPack(packPath);

      // Assemble context
      const ctx: IterationContext = {
        iteration: iterationNum,
        problemPack,
        project,
      };

      // TODO: In iteration 3+, populate previousHandoff, previousJudgeAssessment,
      // iterationHistory, userFeedback from previous iterations

      // Write context files to repo
      await writeContextToRepo(project.repoPath, ctx);

      // Write agent instruction file
      const instructionContent = generateInstructionContent(ctx);
      const { writeFile } = await import("fs/promises");
      await writeFile(
        join(project.repoPath, adapter.instructionFilename),
        instructionContent,
        "utf-8",
      );

      // Build agent command
      const prompt = `Read ${adapter.instructionFilename} and follow the instructions. Execute the iteration plan, then fill in cfcf-docs/iteration-handoff.md and cfcf-docs/cfcf-iteration-signals.json before exiting.`;
      const cmd = adapter.buildCommand(project.repoPath, prompt);
      command = cmd.command;
      args = cmd.args;
      mode = "agent";
    }

    // Spawn the process
    const managed = spawnProcess({
      command,
      args,
      cwd: project.repoPath,
      logFile,
    });

    // Wait for result
    const result = await managed.result;

    // Parse handoff and signal file (agent mode)
    let handoff: string | null = null;
    let signals: import("@cfcf/core").DevSignals | null = null;
    if (mode === "agent") {
      handoff = await parseHandoffDocument(project.repoPath);
      signals = await parseSignalFile(project.repoPath);
    }

    // Commit changes if any
    let committed = false;
    if (await gitManager.hasChanges(project.repoPath)) {
      const commitResult = await gitManager.commitAll(
        project.repoPath,
        `cfcf iteration ${iterationNum}${mode === "agent" ? ` (${project.devAgent.adapter})` : ""}: ${command} ${args.slice(0, 3).join(" ")}`,
      );
      committed = commitResult.success;
    }

    return c.json({
      iteration: iterationNum,
      branch: branchName,
      mode,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      logFile: result.logFile,
      committed,
      killed: result.killed,
      handoffReceived: handoff !== null,
      signalsReceived: signals !== null,
      signals: signals ?? undefined,
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
