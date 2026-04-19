import { useState, useEffect } from "react";

interface Route {
  page: "dashboard" | "project" | "server";
  projectId?: string;
}

function parseHash(): Route {
  const hash = window.location.hash.slice(1); // remove #
  const projectMatch = hash.match(/^\/projects\/(.+)/);
  if (projectMatch) {
    return { page: "project", projectId: decodeURIComponent(projectMatch[1]) };
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
