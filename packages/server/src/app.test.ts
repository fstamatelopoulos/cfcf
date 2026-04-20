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
      expect(body.version).toBe("0.7.6");
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

  // --- PUT /api/config (item 5.9) ---

  describe("PUT /api/config", () => {
    it("returns 404 when not configured", async () => {
      const res = await app.request("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxIterations: 5 }),
      });
      expect(res.status).toBe(404);
    });

    it("accepts a partial patch and returns the merged config", async () => {
      await writeConfig(createDefaultConfig(["claude-code", "codex"]));
      const res = await app.request("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          maxIterations: 20,
          autoReviewSpecs: true,
          readinessGate: "needs_refinement_or_blocked",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.maxIterations).toBe(20);
      expect(body.autoReviewSpecs).toBe(true);
      expect(body.readinessGate).toBe("needs_refinement_or_blocked");
      // Untouched fields preserved
      expect(body.devAgent.adapter).toBe("claude-code");
      expect(body.autoDocumenter).toBe(true);
    });

    it("preserves server-owned fields even when client tries to set them", async () => {
      await writeConfig(createDefaultConfig(["claude-code"]));
      const res = await app.request("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          permissionsAcknowledged: false, // client is lying
          availableAgents: ["malicious-agent"],
          version: 99,
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // Server kept its own values
      expect(body.version).toBe(1);
      expect(body.availableAgents).toEqual(["claude-code"]);
    });

    it("rejects invalid JSON", async () => {
      await writeConfig(createDefaultConfig(["claude-code"]));
      const res = await app.request("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/invalid json/i);
    });

    it("rejects maxIterations < 1", async () => {
      await writeConfig(createDefaultConfig(["claude-code"]));
      const res = await app.request("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxIterations: 0 }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/maxIterations/);
    });

    it("rejects pauseEvery < 0", async () => {
      await writeConfig(createDefaultConfig(["claude-code"]));
      const res = await app.request("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pauseEvery: -1 }),
      });
      expect(res.status).toBe(400);
    });

    it("backfills readinessGate when an invalid value is provided", async () => {
      await writeConfig(createDefaultConfig(["claude-code"]));
      const res = await app.request("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ readinessGate: "bogus" }),
      });
      // validateConfig backfills unknown gate values to "blocked"
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.readinessGate).toBe("blocked");
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

  // --- PUT /api/projects/:id (item 6.14) ---

  describe("PUT /api/projects/:id", () => {
    async function createProj() {
      const createRes = await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "edit-test", repoPath: repoDir }),
      });
      const body = (await createRes.json()) as { id: string; name: string };
      return body.id;
    }

    it("returns 404 for unknown project", async () => {
      const res = await app.request("/api/projects/unknown-xyz", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxIterations: 5 }),
      });
      expect(res.status).toBe(404);
    });

    it("accepts a partial patch and returns the merged config", async () => {
      const id = await createProj();
      const res = await app.request(`/api/projects/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          maxIterations: 25,
          pauseEvery: 5,
          autoReviewSpecs: true,
          readinessGate: "needs_refinement_or_blocked",
          onStalled: "stop",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.maxIterations).toBe(25);
      expect(body.pauseEvery).toBe(5);
      expect(body.autoReviewSpecs).toBe(true);
      expect(body.readinessGate).toBe("needs_refinement_or_blocked");
      expect(body.onStalled).toBe("stop");
      // Identity preserved
      expect(body.id).toBe(id);
      expect(body.name).toBe("edit-test");
      expect(body.repoPath).toBe(repoDir);
    });

    it("preserves identity + runtime fields when client tries to set them", async () => {
      const id = await createProj();
      const res = await app.request(`/api/projects/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "malicious-id",
          name: "malicious-name",
          repoPath: "/tmp/evil",
          currentIteration: 999,
          status: "completed",
          processTemplate: "custom",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(id);
      expect(body.name).toBe("edit-test");
      expect(body.repoPath).toBe(repoDir);
      expect(body.currentIteration).toBe(0);
      expect(body.processTemplate).toBe("default");
    });

    it("rejects invalid JSON", async () => {
      const id = await createProj();
      const res = await app.request(`/api/projects/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });

    it("rejects maxIterations < 1", async () => {
      const id = await createProj();
      const res = await app.request(`/api/projects/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxIterations: 0 }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects pauseEvery < 0", async () => {
      const id = await createProj();
      const res = await app.request(`/api/projects/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pauseEvery: -1 }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects reflectSafeguardAfter < 1", async () => {
      const id = await createProj();
      const res = await app.request(`/api/projects/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reflectSafeguardAfter: 0 }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid onStalled enum", async () => {
      const id = await createProj();
      const res = await app.request(`/api/projects/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ onStalled: "panic" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid mergeStrategy enum", async () => {
      const id = await createProj();
      const res = await app.request(`/api/projects/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mergeStrategy: "cherry-pick" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid readinessGate enum", async () => {
      const id = await createProj();
      const res = await app.request(`/api/projects/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ readinessGate: "sometimes" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects agent role without adapter", async () => {
      const id = await createProj();
      const res = await app.request(`/api/projects/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ devAgent: { model: "opus" } }),
      });
      expect(res.status).toBe(400);
    });

    it("clears per-project notifications override when notifications:null is sent", async () => {
      const id = await createProj();
      // First, set an override
      await app.request(`/api/projects/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notifications: { enabled: true, events: { "loop.paused": ["log"] } },
        }),
      });
      // Then clear it via notifications: null
      const res = await app.request(`/api/projects/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notifications: null }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.notifications).toBeUndefined();
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

  // --- Document API ---

  describe("POST /api/projects/:id/document", () => {
    it("returns 404 for unknown project", async () => {
      const res = await app.request("/api/projects/nonexistent/document", {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/projects/:id/document/status", () => {
    it("returns 404 when no documenter run active", async () => {
      const createRes = await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "doc-status-test", repoPath: repoDir }),
      });
      const project = await createRes.json();

      const res = await app.request(`/api/projects/${project.id}/document/status`);
      expect(res.status).toBe(404);
    });
  });

  // --- Loop API ---

  describe("POST /api/projects/:id/loop/start", () => {
    it("returns 404 for unknown project", async () => {
      const res = await app.request("/api/projects/nonexistent/loop/start", {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/projects/:id/loop/status", () => {
    it("returns 404 when no loop active", async () => {
      const createRes = await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "loop-status-test", repoPath: repoDir }),
      });
      const project = await createRes.json();

      const res = await app.request(`/api/projects/${project.id}/loop/status`);
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/projects/:id/loop/stop", () => {
    it("returns 400 when no loop active", async () => {
      const createRes = await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "loop-stop-test", repoPath: repoDir }),
      });
      const project = await createRes.json();

      const res = await app.request(`/api/projects/${project.id}/loop/stop`, {
        method: "POST",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/projects/:id/loop/resume", () => {
    it("returns 400 when no loop active", async () => {
      const createRes = await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "loop-resume-test", repoPath: repoDir }),
      });
      const project = await createRes.json();

      const res = await app.request(`/api/projects/${project.id}/loop/resume`, {
        method: "POST",
      });
      expect(res.status).toBe(400);
    });
  });

  // --- Review API ---

  describe("POST /api/projects/:id/review", () => {
    it("returns 404 for unknown project", async () => {
      const res = await app.request("/api/projects/nonexistent/review", {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/projects/:id/review/status", () => {
    it("returns 404 when no review active", async () => {
      const createRes = await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "review-status-test", repoPath: repoDir }),
      });
      const project = await createRes.json();

      const res = await app.request(`/api/projects/${project.id}/review/status`);
      expect(res.status).toBe(404);
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
