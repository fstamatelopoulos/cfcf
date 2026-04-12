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
      expect(body.currentIteration).toBe(0);
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
      await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "findme", repoPath: repoDir }),
      });

      const res = await app.request("/api/projects/findme");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("findme");
    });
  });

  // --- Iterate (async) ---

  describe("POST /api/projects/:id/iterate", () => {
    it("starts an iteration and returns 202", async () => {
      const createRes = await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "iter-test", repoPath: repoDir }),
      });
      const project = await createRes.json();

      const res = await app.request(`/api/projects/${project.id}/iterate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "echo", args: ["hello cfcf"] }),
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.iteration).toBe(1);
      expect(body.branch).toBe("cfcf/iteration-1");
      expect(body.mode).toBe("manual");
      expect(["preparing", "executing"]).toContain(body.status);
      expect(body.message).toContain("Poll");
    });

    it("increments iteration counter across calls", async () => {
      const createRes = await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "counter-test", repoPath: repoDir }),
      });
      const project = await createRes.json();

      const res1 = await app.request(`/api/projects/${project.id}/iterate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "echo", args: ["iter 1"] }),
      });
      const body1 = await res1.json();
      expect(body1.iteration).toBe(1);

      // Wait for first iteration to complete so branch is free
      await new Promise((resolve) => setTimeout(resolve, 500));

      const res2 = await app.request(`/api/projects/${project.id}/iterate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "echo", args: ["iter 2"] }),
      });
      const body2 = await res2.json();
      expect(body2.iteration).toBe(2);
    });

    it("returns status after iteration completes", async () => {
      const createRes = await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "status-test", repoPath: repoDir }),
      });
      const project = await createRes.json();

      const startRes = await app.request(`/api/projects/${project.id}/iterate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "echo", args: ["done"] }),
      });
      const start = await startRes.json();

      // Wait for completion
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const statusRes = await app.request(
        `/api/projects/${project.id}/iterations/${start.iteration}/status`,
      );
      expect(statusRes.status).toBe(200);
      const status = await statusRes.json();
      expect(status.status).toBe("completed");
      expect(status.exitCode).toBe(0);
      expect(status.durationMs).toBeGreaterThan(0);
    });
  });

  // --- Shutdown ---

  describe("POST /api/shutdown", () => {
    it("returns shutting down status", async () => {
      const res = await app.request("/api/shutdown", { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("shutting down");
    });
  });
});
