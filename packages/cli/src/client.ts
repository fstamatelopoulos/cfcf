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
 * Read a fetch Response as text (once) and try to parse as JSON. When
 * the body isn't JSON, surface the text in the error instead of
 * bubbling up an opaque "Failed to parse JSON". Fetch Response bodies
 * can only be consumed once so we always go through .text() first.
 */
async function readJsonOrTextError<T>(res: Response): Promise<ClientResponse<T>> {
  const text = await res.text().catch(() => "");
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON body. Return as an error with the server's text so the
      // user sees what actually came back (e.g. "Internal Server Error").
      const snippet = text.slice(0, 400);
      return {
        ok: false,
        status: res.status,
        error: `Server returned non-JSON (HTTP ${res.status})${snippet ? ": " + snippet : ""}`,
      };
    }
  }
  if (!res.ok) {
    const errText = (parsed as { error?: string } | null)?.error || res.statusText || `HTTP ${res.status}`;
    return { ok: false, status: res.status, error: errText };
  }
  return { ok: true, status: res.status, data: (parsed ?? {}) as T };
}

/**
 * Wrap a fetch() call with our standard error mapping.
 */
function mapFetchError(err: unknown): ClientResponse<never> {
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

/**
 * Make a GET request to the cfcf server.
 */
export async function get<T = unknown>(path: string): Promise<ClientResponse<T>> {
  try {
    const res = await fetch(`${getBaseUrl()}${path}`);
    return await readJsonOrTextError<T>(res);
  } catch (err: unknown) {
    return mapFetchError(err);
  }
}

/**
 * Make a POST request to the cfcf server.
 */
export async function post<T = unknown>(path: string, body?: unknown): Promise<ClientResponse<T>> {
  try {
    const res = await fetch(`${getBaseUrl()}${path}`, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return await readJsonOrTextError<T>(res);
  } catch (err: unknown) {
    return mapFetchError(err);
  }
}

/**
 * Make a PUT request to the cfcf server.
 */
export async function put<T = unknown>(path: string, body?: unknown): Promise<ClientResponse<T>> {
  try {
    const res = await fetch(`${getBaseUrl()}${path}`, {
      method: "PUT",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return await readJsonOrTextError<T>(res);
  } catch (err: unknown) {
    return mapFetchError(err);
  }
}

/**
 * Make a DELETE request to the cfcf server. Optional body for callers
 * that need to attach attribution / metadata to the request (e.g.
 * `cfcf clio delete <id> --author <name>` mapped to
 * `DELETE /api/clio/documents/:id`).
 */
export async function del<T = unknown>(path: string, body?: unknown): Promise<ClientResponse<T>> {
  try {
    const res = await fetch(`${getBaseUrl()}${path}`, {
      method: "DELETE",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return await readJsonOrTextError<T>(res);
  } catch (err: unknown) {
    return mapFetchError(err);
  }
}

/**
 * Check if the server is reachable.
 */
export async function isServerReachable(): Promise<boolean> {
  const res = await get("/api/health");
  return res.ok;
}
