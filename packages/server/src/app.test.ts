import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { createApp } from "./app.js";
import { writeConfig, createDefaultConfig } from "@cfcf/core";

describe("server API", () => {
  const app = createApp();
  let tempDir: string;
  let repoDir: string;
  const originalEnv = process.env.CFCF_CONFIG_DIR;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cfcf-server-test-"));
    process.env.CFCF_CONFIG_DIR = tempDir;

    // Create a real git repo for project tests
    repoDir = join(tempDir, "test-repo");
    await mkdir(repoDir, { recursive: true });
    await Bun.spawn(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;
    await Bun.spawn(["git", "config", "user.email", "test@cfcf.dev"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;
    await Bun.spawn(["git", "config", "user.name", "cfcf test"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;
    await writeFile(join(repoDir, "README.md"), "# test\n");
    await Bun.spawn(["git", "add", "-A"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;
    await Bun.spawn(["git", "commit", "-m", "initial"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;
  });

  afterEach(async () => {
    process.env.CFCF_CONFIG_DIR = originalEnv;
    await rm(tempDir, { recursive: true, force: true });
  });

  // --- Health / Status ---

  describe("GET /api/health", () => {
    it("returns ok status", async () => {
      const res = await app.request("/api/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.version).toBe("0.0.0");
    });
  });

  describe("GET /api/status", () => {
    it("returns configured=false when no config", async () => {
      const res = await app.request("/api/status");
      const body = await res.json();
      expect(body.configured).toBe(false);
    });

    it("returns configured=true when config exists", async () => {
      await writeConfig(createDefaultConfig(["claude-code"]));
      const res = await app.request("/api/status");
      const body = await res.json();
      expect(body.configured).toBe(true);
    });
  });

  // --- Config ---

  describe("GET /api/config", () => {
    it("returns 404 when not configured", async () => {
      const res = await app.request("/api/config");
      expect(res.status).toBe(404);
    });

    it("returns config when configured", async () => {
      await writeConfig(createDefaultConfig(["claude-code"]));
      const res = await app.request("/api/config");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.devAgent.adapter).toBe("claude-code");
    });
  });

  // --- Projects ---

  describe("POST /api/projects", () => {
    it("creates a project", async () => {
      const res = await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test-app", repoPath: repoDir }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe("test-app");
      expect(body.id).toMatch(/^test-app-/);
    });

    it("rejects missing name", async () => {
      const res = await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoPath: repoDir }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects non-git directory", async () => {
      const nonGitDir = join(tempDir, "not-git");
      await mkdir(nonGitDir, { recursive: true });
      const res = await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "bad", repoPath: nonGitDir }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/projects", () => {
    it("returns empty list initially", async () => {
      const res = await app.request("/api/projects");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([]);
    });

    it("returns created projects", async () => {
      await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "app-one", repoPath: repoDir }),
      });

      const res = await app.request("/api/projects");
      const body = await res.json();
      expect(body.length).toBe(1);
      expect(body[0].name).toBe("app-one");
    });
  });

  describe("GET /api/projects/:id", () => {
    it("returns 404 for unknown project", async () => {
      const res = await app.request("/api/projects/nonexistent");
      expect(res.status).toBe(404);
    });

    it("finds project by name", async () => {
      const createRes = await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "findme", repoPath: repoDir }),
      });
      const created = await createRes.json();

      const res = await app.request(`/api/projects/findme`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("findme");
    });
  });

  // --- Shutdown ---

  describe("POST /api/shutdown", () => {
    it("returns shutting down status", async () => {
      // Note: in test mode, the setTimeout won't actually exit
      const res = await app.request("/api/shutdown", { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("shutting down");
    });
  });
});
