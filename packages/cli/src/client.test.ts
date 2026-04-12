import { describe, it, expect } from "bun:test";
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
});
