/**
 * Help-content HTTP routes -- powers the web UI Help tab.
 *
 * Reads from the embedded help bundle (packages/core/src/help.ts) so the
 * server is self-contained: no filesystem lookup at runtime, works in
 * `bun build --compile` and npm-format installs alike.
 *
 *   GET /api/help/topics           -- list all topics (slug + title + aliases)
 *   GET /api/help/topics/:slug     -- one topic's full content
 *
 * Plan item 5.8 PR2/PR3.
 */

import type { Hono } from "hono";
import { listHelpTopics, resolveHelpTopic, getHelpContent } from "@cfcf/core";

export function registerHelpRoutes(app: Hono): void {
  app.get("/api/help/topics", (c) => {
    const topics = listHelpTopics().map((t) => ({
      slug: t.slug,
      title: t.title,
      source: t.source,
      aliases: t.aliases,
    }));
    return c.json({ topics });
  });

  app.get("/api/help/topics/:slug", (c) => {
    const slug = c.req.param("slug");
    const topic = resolveHelpTopic(slug);
    if (!topic) {
      return c.json({ error: `unknown help topic: ${slug}` }, 404);
    }
    const content = getHelpContent(topic.slug);
    if (content === null) {
      // Should be unreachable -- if resolveHelpTopic found it, content
      // must be present. Defensive: surface a 500 with a hint.
      return c.json({ error: `topic "${topic.slug}" has no embedded content` }, 500);
    }
    return c.json({
      slug: topic.slug,
      title: topic.title,
      source: topic.source,
      aliases: topic.aliases,
      content,
    });
  });
}
