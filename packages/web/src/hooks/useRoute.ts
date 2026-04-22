import { useState, useEffect } from "react";

interface Route {
  page: "dashboard" | "workspace" | "server";
  workspaceId?: string;
}

function parseHash(): Route {
  const hash = window.location.hash.slice(1); // remove #
  const workspaceMatch = hash.match(/^\/workspaces\/(.+)/);
  if (workspaceMatch) {
    return { page: "workspace", workspaceId: decodeURIComponent(workspaceMatch[1]) };
  }
  if (hash === "/server") {
    return { page: "server" };
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
