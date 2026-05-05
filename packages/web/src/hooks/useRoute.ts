import { useState, useEffect } from "react";

export type MemoryTab = "search" | "browse" | "ingest" | "audit" | "projects" | "trash";

interface Route {
  page: "dashboard" | "workspace" | "server" | "help" | "memory";
  workspaceId?: string;
  helpTopic?: string;
  /** Memory page sub-tab (item 6.18). Defaults to "search". */
  memoryTab?: MemoryTab;
  /** Memory page document detail overlay (item 6.18). */
  memoryDocId?: string;
}

/**
 * Parse a hash-router URL fragment (without the leading `#`) into a Route.
 * Exported for unit testing the new `?tab=` / `?doc=` query handling on
 * the Memory page (item 6.18) without needing a DOM.
 */
export function parseRouteHash(hash: string): Route {
  return parseHashImpl(hash);
}

function parseHash(): Route {
  return parseHashImpl(window.location.hash.slice(1));
}

function parseHashImpl(hash: string): Route {
  const workspaceMatch = hash.match(/^\/workspaces\/(.+)/);
  if (workspaceMatch) {
    return { page: "workspace", workspaceId: decodeURIComponent(workspaceMatch[1]) };
  }
  const helpMatch = hash.match(/^\/help(?:\/(.+))?$/);
  if (helpMatch) {
    return { page: "help", helpTopic: helpMatch[1] ? decodeURIComponent(helpMatch[1]) : undefined };
  }
  if (hash === "/server") {
    return { page: "server" };
  }
  // Memory: support `?tab=…&doc=…` query string, e.g. `#/memory?tab=ingest`.
  // Hash routers don't get the URL's real query string, so we parse a
  // query-like fragment after the hash path manually.
  if (hash === "/memory" || hash.startsWith("/memory?")) {
    const qIdx = hash.indexOf("?");
    const params = qIdx >= 0 ? new URLSearchParams(hash.slice(qIdx + 1)) : new URLSearchParams();
    const tabRaw = params.get("tab");
    const validTabs: MemoryTab[] = ["search", "browse", "ingest", "audit", "projects", "trash"];
    const memoryTab = tabRaw && (validTabs as string[]).includes(tabRaw)
      ? (tabRaw as MemoryTab)
      : undefined;
    const memoryDocId = params.get("doc") || undefined;
    return { page: "memory", memoryTab, memoryDocId };
  }
  return { page: "dashboard" };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    const handler = () => setRoute(parseHash());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  return route;
}

export function navigateTo(path: string) {
  window.location.hash = path;
}
