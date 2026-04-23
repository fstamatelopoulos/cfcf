/**
 * Clio HTTP routes (item 5.7 PR1).
 *
 * Mounted onto the main Hono app via `registerClioRoutes(app)`. All
 * endpoints under `/api/clio/*` plus the `PUT /api/workspaces/:id/clio-project`
 * wire for `cfcf workspace set --project`.
 *
 * Response shapes match the CLI's `LocalClio`-returned types 1:1.
 */

import type { Hono } from "hono";
import { getClioBackend } from "../clio-backend.js";
import {
  getWorkspace,
  findWorkspaceByName,
  updateWorkspace,
  type IngestRequest,
  type SearchRequest,
} from "@cfcf/core";

export function registerClioRoutes(app: Hono): void {
  // ── Projects ─────────────────────────────────────────────────────────

  app.get("/api/clio/projects", async (c) => {
    const backend = getClioBackend();
    const projects = await backend.listProjects();
    return c.json({ projects });
  });

  app.post("/api/clio/projects", async (c) => {
    const body = await c.req.json<{ name?: string; description?: string }>()
      .catch(() => ({} as { name?: string; description?: string }));
    if (!body.name || !body.name.trim()) {
      return c.json({ error: "name is required" }, 400);
    }
    try {
      const backend = getClioBackend();
      const project = await backend.createProject({
        name: body.name.trim(),
        description: body.description?.trim() || undefined,
      });
      return c.json(project, 201);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes("already exists")) {
        return c.json({ error: message }, 409);
      }
      return c.json({ error: message }, 500);
    }
  });

  app.get("/api/clio/projects/:idOrName", async (c) => {
    const idOrName = c.req.param("idOrName");
    const backend = getClioBackend();
    const project = await backend.getProject(idOrName);
    if (!project) return c.json({ error: "Clio Project not found" }, 404);
    return c.json(project);
  });

  // ── Ingest ───────────────────────────────────────────────────────────

  app.post("/api/clio/ingest", async (c) => {
    let body: Partial<IngestRequest>;
    try {
      body = await c.req.json<Partial<IngestRequest>>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!body.project || !body.title || !body.content) {
      return c.json({ error: "project, title, and content are required" }, 400);
    }
    try {
      const backend = getClioBackend();
      const result = await backend.ingest({
        project: body.project,
        title: body.title,
        content: body.content,
        source: body.source,
        metadata: body.metadata,
        reviewStatus: body.reviewStatus,
      });
      return c.json(result, result.created ? 201 : 200);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // ── Search ───────────────────────────────────────────────────────────

  app.get("/api/clio/search", async (c) => {
    const q = c.req.query("q") ?? "";
    if (!q.trim()) {
      return c.json({ error: "q is required" }, 400);
    }
    const project = c.req.query("project") || undefined;
    const mode = (c.req.query("mode") as SearchRequest["mode"]) || "fts";
    const matchCountStr = c.req.query("match_count");
    const matchCount = matchCountStr ? parseInt(matchCountStr, 10) : undefined;
    if (matchCountStr && (isNaN(matchCount as number) || (matchCount as number) < 1)) {
      return c.json({ error: "match_count must be a positive integer" }, 400);
    }

    // Metadata filter: JSON-encoded in the `metadata` query param for
    // simplicity. e.g. ?metadata={"role":"reflection"}
    let metadata: SearchRequest["metadata"];
    const metaRaw = c.req.query("metadata");
    if (metaRaw) {
      try {
        metadata = JSON.parse(metaRaw) as SearchRequest["metadata"];
      } catch {
        return c.json({ error: "metadata must be valid JSON" }, 400);
      }
    }

    try {
      const backend = getClioBackend();
      const res = await backend.search({ query: q, project, matchCount, mode, metadata });
      return c.json(res);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // ── Documents ────────────────────────────────────────────────────────

  app.get("/api/clio/documents/:id", async (c) => {
    const id = c.req.param("id");
    const backend = getClioBackend();
    const doc = await backend.getDocument(id);
    if (!doc) return c.json({ error: "Document not found" }, 404);
    return c.json(doc);
  });

  // ── Stats ────────────────────────────────────────────────────────────

  app.get("/api/clio/stats", async (c) => {
    const backend = getClioBackend();
    const stats = await backend.stats();
    return c.json(stats);
  });

  // ── Workspace Clio Project binding (backs `cfcf workspace set --project`) ─

  app.put("/api/workspaces/:id/clio-project", async (c) => {
    const id = c.req.param("id");
    const workspace =
      (await getWorkspace(id)) ?? (await findWorkspaceByName(id));
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);

    let body: { project?: string; migrateHistory?: boolean };
    try {
      body = await c.req.json<typeof body>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!body.project || !body.project.trim()) {
      return c.json({ error: "project is required" }, 400);
    }

    const newName = body.project.trim();
    const oldName = workspace.clioProject;

    // Resolve (auto-create) the new Clio Project. Refuses to auto-create
    // from a raw UUID, so callers pass a human name.
    const backend = getClioBackend();
    let newProject;
    try {
      newProject = await backend.resolveProject(newName, { createIfMissing: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }

    // Migrate historical docs if requested.
    let migrated = 0;
    if (body.migrateHistory && oldName) {
      const oldProject = await backend.getProject(oldName);
      if (oldProject) {
        migrated = await backend.migrateDocumentsBetweenProjects(oldProject.id, newProject.id);
      }
    }

    // Persist the new assignment on the workspace config.
    const updated = await updateWorkspace(workspace.id, { clioProject: newProject.name });
    if (!updated) return c.json({ error: "Failed to update workspace" }, 500);

    return c.json({ workspace: updated, migrated });
  });
}
