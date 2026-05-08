import { describe, it, expect } from "bun:test";
import { detectOllama, listOllamaModels } from "./ollama-detection.js";

// These tests don't assert that ollama IS installed — CI may not have it.
// They verify the shape of the responses is correct so that callers can
// rely on the contract regardless of the runtime environment.

describe("detectOllama", () => {
  it("returns an OllamaAvailability object", async () => {
    const result = await detectOllama();
    expect(result).toHaveProperty("available");
    expect(typeof result.available).toBe("boolean");
    if (result.available) {
      expect(result).toHaveProperty("version");
      expect(typeof result.version).toBe("string");
      expect(result.version!.length).toBeGreaterThan(0);
    } else {
      expect(result).toHaveProperty("error");
      expect(typeof result.error).toBe("string");
    }
  });
});

describe("listOllamaModels", () => {
  it("returns an array of strings (possibly empty)", async () => {
    const result = await listOllamaModels();
    expect(Array.isArray(result)).toBe(true);
    for (const model of result) {
      expect(typeof model).toBe("string");
      expect(model.length).toBeGreaterThan(0);
    }
  });

  it("never includes the literal NAME header column", async () => {
    // Sanity check: parsing should always strip the table header. If the
    // implementation regresses to including raw lines, this would catch
    // it on any system where ollama is installed (header is always present).
    const result = await listOllamaModels();
    expect(result).not.toContain("NAME");
  });
});
