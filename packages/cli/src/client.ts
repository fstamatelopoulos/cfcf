/**
 * HTTP client for communicating with the cfcf server.
 */

import { DEFAULT_PORT } from "@cfcf/core";

function getBaseUrl(): string {
  const port = process.env.CFCF_PORT || String(DEFAULT_PORT);
  return `http://localhost:${port}`;
}

export interface ClientResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

/**
 * Make a GET request to the cfcf server.
 */
export async function get<T = unknown>(path: string): Promise<ClientResponse<T>> {
  try {
    const res = await fetch(`${getBaseUrl()}${path}`);
    const data = await res.json();
    if (!res.ok) {
      return { ok: false, status: res.status, error: (data as { error?: string }).error || res.statusText };
    }
    return { ok: true, status: res.status, data: data as T };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("ECONNREFUSED") ||
      message.includes("fetch failed") ||
      message.includes("Unable to connect")
    ) {
      return { ok: false, status: 0, error: "Server is not running. Start it with: cfcf server start" };
    }
    return { ok: false, status: 0, error: message };
  }
}

/**
 * Make a POST request to the cfcf server.
 * Uses a long timeout for agent-mode iterations that can run for minutes.
 */
export async function post<T = unknown>(path: string, body?: unknown): Promise<ClientResponse<T>> {
  try {
    const controller = new AbortController();
    // 30 minute timeout -- agent runs can take a very long time
    const timeoutId = setTimeout(() => controller.abort(), 30 * 60 * 1000);

    const res = await fetch(`${getBaseUrl()}${path}`, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await res.json();
    if (!res.ok) {
      return { ok: false, status: res.status, error: (data as { error?: string }).error || res.statusText };
    }
    return { ok: true, status: res.status, data: data as T };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("ECONNREFUSED") ||
      message.includes("fetch failed") ||
      message.includes("Unable to connect")
    ) {
      return { ok: false, status: 0, error: "Server is not running. Start it with: cfcf server start" };
    }
    if (message.includes("abort") || message.includes("timed out")) {
      return { ok: false, status: 0, error: "Request timed out. The agent may still be running -- check the server logs." };
    }
    return { ok: false, status: 0, error: message };
  }
}

/**
 * Check if the server is reachable.
 */
export async function isServerReachable(): Promise<boolean> {
  const res = await get("/api/health");
  return res.ok;
}
