import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { readProblemPack, validateProblemPack } from "./problem-pack.js";

describe("problem-pack", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cfcf-pack-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("readProblemPack", () => {
    it("reads a valid problem pack with required files", async () => {
      await writeFile(join(tempDir, "problem.md"), "# The Problem\nBuild something.\n");
      await writeFile(join(tempDir, "success.md"), "# Success\nTests pass.\n");

      const pack = await readProblemPack(tempDir);
      expect(pack.problem).toContain("The Problem");
      expect(pack.success).toContain("Tests pass");
      expect(pack.constraints).toBeUndefined();
      expect(pack.hints).toBeUndefined();
      expect(pack.context).toEqual([]);
    });

    it("reads optional files when present", async () => {
      await writeFile(join(tempDir, "problem.md"), "problem");
      await writeFile(join(tempDir, "success.md"), "success");
      await writeFile(join(tempDir, "constraints.md"), "no globals");
      await writeFile(join(tempDir, "hints.md"), "try typescript");
      await writeFile(join(tempDir, "style-guide.md"), "use 2 spaces");

      const pack = await readProblemPack(tempDir);
      expect(pack.constraints).toBe("no globals");
      expect(pack.hints).toBe("try typescript");
      expect(pack.styleGuide).toBe("use 2 spaces");
    });

    it("reads context/ directory", async () => {
      await writeFile(join(tempDir, "problem.md"), "problem");
      await writeFile(join(tempDir, "success.md"), "success");
      await mkdir(join(tempDir, "context"), { recursive: true });
      await writeFile(join(tempDir, "context", "api-spec.md"), "GET /users");
      await writeFile(join(tempDir, "context", "architecture.md"), "monolith");

      const pack = await readProblemPack(tempDir);
      expect(pack.context.length).toBe(2);
      expect(pack.context[0].filename).toBe("api-spec.md");
      expect(pack.context[1].filename).toBe("architecture.md");
    });

    it("throws on missing problem.md", async () => {
      await writeFile(join(tempDir, "success.md"), "success");
      expect(readProblemPack(tempDir)).rejects.toThrow("problem.md");
    });

    it("throws on missing success.md", async () => {
      await writeFile(join(tempDir, "problem.md"), "problem");
      expect(readProblemPack(tempDir)).rejects.toThrow("success.md");
    });

    it("throws on non-existent directory", async () => {
      expect(readProblemPack("/nonexistent")).rejects.toThrow("not found");
    });
  });

  describe("validateProblemPack", () => {
    it("validates a complete pack", async () => {
      await writeFile(join(tempDir, "problem.md"), "problem");
      await writeFile(join(tempDir, "success.md"), "success");

      const result = await validateProblemPack(tempDir);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("reports missing problem.md", async () => {
      await writeFile(join(tempDir, "success.md"), "success");

      const result = await validateProblemPack(tempDir);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Missing required file: problem.md");
    });

    it("reports missing success.md", async () => {
      await writeFile(join(tempDir, "problem.md"), "problem");

      const result = await validateProblemPack(tempDir);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Missing required file: success.md");
    });

    it("reports non-existent directory", async () => {
      const result = await validateProblemPack("/nonexistent");
      expect(result.valid).toBe(false);
    });
  });
});
