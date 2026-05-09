/**
 * `/api/role-templates/*` -- versioning + promote-to-production layer
 * for role-instruction templates (item 6.8). Backed by
 * `@cfcf/core/role-templates`.
 *
 * Endpoints:
 *   GET    /api/role-templates                                  list summaries
 *   GET    /api/role-templates/:name                            full state
 *   GET    /api/role-templates/:name/versions/:versionId        content body
 *   POST   /api/role-templates/:name/versions                   create version
 *   PUT    /api/role-templates/:name/versions/:versionId        update label/content
 *   DELETE /api/role-templates/:name/versions/:versionId        delete version
 *   POST   /api/role-templates/:name/promote                    promote to prod
 *
 * Names are URL-encoded (templates contain `.md`). Errors return 4xx
 * with `{ error: string }`.
 */

import type { Hono } from "hono";
import {
  listManagedTemplates,
  getManagedTemplate,
  getVersionContent,
  saveVersion,
  updateVersion,
  deleteVersion,
  promoteVersion,
} from "@cfcf/core";

function errorBody(err: unknown): { error: string } {
  return { error: err instanceof Error ? err.message : String(err) };
}

export function registerRoleTemplatesRoutes(app: Hono): void {
  app.get("/api/role-templates", async (c) => {
    try {
      const summaries = await listManagedTemplates();
      return c.json({ templates: summaries });
    } catch (err) {
      return c.json(errorBody(err), 500);
    }
  });

  app.get("/api/role-templates/:name", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    try {
      const t = await getManagedTemplate(name);
      return c.json(t);
    } catch (err) {
      return c.json(errorBody(err), 404);
    }
  });

  app.get("/api/role-templates/:name/versions/:versionId", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const versionId = decodeURIComponent(c.req.param("versionId"));
    try {
      const content = await getVersionContent(name, versionId);
      return c.json({ content });
    } catch (err) {
      return c.json(errorBody(err), 404);
    }
  });

  app.post("/api/role-templates/:name/versions", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    let body: { label?: unknown; content?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Body must be JSON" }, 400);
    }
    if (typeof body.label !== "string" || typeof body.content !== "string") {
      return c.json({ error: "Body must include `label` and `content` (both strings)" }, 400);
    }
    try {
      const v = await saveVersion(name, { label: body.label, content: body.content });
      return c.json(v, 201);
    } catch (err) {
      return c.json(errorBody(err), 400);
    }
  });

  app.put("/api/role-templates/:name/versions/:versionId", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const versionId = decodeURIComponent(c.req.param("versionId"));
    let body: { label?: unknown; content?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Body must be JSON" }, 400);
    }
    const opts: { label?: string; content?: string } = {};
    if (typeof body.label === "string") opts.label = body.label;
    if (typeof body.content === "string") opts.content = body.content;
    if (opts.label === undefined && opts.content === undefined) {
      return c.json({ error: "Body must include at least one of `label` or `content`" }, 400);
    }
    try {
      const v = await updateVersion(name, versionId, opts);
      return c.json(v);
    } catch (err) {
      return c.json(errorBody(err), 400);
    }
  });

  app.delete("/api/role-templates/:name/versions/:versionId", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const versionId = decodeURIComponent(c.req.param("versionId"));
    try {
      await deleteVersion(name, versionId);
      // Return the refreshed template so the UI can update local
      // state without an extra GET (mirrors POST /promote's
      // response shape).
      const refreshed = await getManagedTemplate(name);
      return c.json({ deleted: true, template: refreshed });
    } catch (err) {
      return c.json(errorBody(err), 400);
    }
  });

  app.post("/api/role-templates/:name/promote", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    let body: { versionId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Body must be JSON" }, 400);
    }
    if (typeof body.versionId !== "string") {
      return c.json({ error: "Body must include `versionId`" }, 400);
    }
    try {
      await promoteVersion(name, body.versionId);
      // Return the refreshed template so the UI can update without
      // an extra GET.
      const refreshed = await getManagedTemplate(name);
      return c.json(refreshed);
    } catch (err) {
      return c.json(errorBody(err), 400);
    }
  });
}
