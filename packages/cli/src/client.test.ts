import { describe, it, expect, afterEach } from "bun:test";
import { get, isServerReachable } from "./client.js";

describe("CLI HTTP client", () => {
  describe("when server is not running", () => {
    it("get returns a connection error", async () => {
      // Use a port that's definitely not running
      process.env.CFCF_PORT = "19999";
      const res = await get("/api/health");
      expect(res.ok).toBe(false);
      expect(res.error).toContain("not running");
      delete process.env.CFCF_PORT;
    });

    it("isServerReachable returns false", async () => {
      process.env.CFCF_PORT = "19999";
      expect(await isServerReachable()).toBe(false);
      delete process.env.CFCF_PORT;
    });
  });

  describe("auth headers (item 6.35 follow-up)", () => {
    // Spin up a tiny in-process listener that captures the headers
    // from a real fetch — so we exercise the same code path the CLI
    // uses against a real server.
    const origActor = process.env.CFCF_ACTOR;
    const origAccess = process.env.CFCF_ACCESS_PATH;
    const origPort = process.env.CFCF_PORT;

    afterEach(() => {
      if (origActor === undefined) delete process.env.CFCF_ACTOR;
      else process.env.CFCF_ACTOR = origActor;
      if (origAccess === undefined) delete process.env.CFCF_ACCESS_PATH;
      else process.env.CFCF_ACCESS_PATH = origAccess;
      if (origPort === undefined) delete process.env.CFCF_PORT;
      else process.env.CFCF_PORT = origPort;
    });

    async function captureHeaders(envPatch: Record<string, string | undefined>): Promise<Record<string, string>> {
      // Apply env patches so the client's header builder sees them.
      for (const [k, v] of Object.entries(envPatch)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }

      const captured: Record<string, string> = {};
      const server = Bun.serve({
        port: 0,
        async fetch(req) {
          for (const [k, v] of req.headers.entries()) captured[k] = v;
          return new Response("{}", { headers: { "content-type": "application/json" } });
        },
      });
      try {
        process.env.CFCF_PORT = String(server.port);
        await get("/api/health");
        return captured;
      } finally {
        server.stop(true);
      }
    }

    it("defaults to user|cli|default when CFCF_ACTOR is unset (human user path)", async () => {
      const headers = await captureHeaders({ CFCF_ACTOR: undefined, CFCF_ACCESS_PATH: undefined });
      expect(headers["x-cfcf-actor"]).toBe("user|cli|default");
      expect(headers["x-cfcf-access-path"]).toBe("cli");
    });

    it("propagates CFCF_ACTOR verbatim when set (agent shell-out path)", async () => {
      const headers = await captureHeaders({
        CFCF_ACTOR: "product-architect|claude-code|sonnet",
        CFCF_ACCESS_PATH: "agent-cli",
      });
      expect(headers["x-cfcf-actor"]).toBe("product-architect|claude-code|sonnet");
      expect(headers["x-cfcf-access-path"]).toBe("agent-cli");
    });

    it("falls back gracefully on whitespace-only CFCF_ACTOR", async () => {
      const headers = await captureHeaders({ CFCF_ACTOR: "   " });
      expect(headers["x-cfcf-actor"]).toBe("user|cli|default");
    });
  });
});
