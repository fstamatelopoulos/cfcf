/**
 * Unit tests for `cfcf self-update`'s source/version resolution.
 *
 * The full upgrade flow spawns `bun install -g` + hits the npm registry
 * + reads the user's filesystem -- not unit-testable in isolation. What
 * IS unit-testable is the `resolveTarget` function that maps CLI flags
 * + env vars to a normalised `{ source, version, baseUrl? }` triple.
 * That logic mirrors `scripts/install.sh`'s install-source resolution
 * and changing it without coverage would silently break either path.
 *
 * Coverage target:
 *   • all four (cli-flag, env-var, base-url, default) paths for source
 *   • leading-`v` normalisation for both --version flag + CFCF_VERSION
 *   • tarball baseUrl defaulting to GitHub Releases when not overridden
 *   • CFCF_RELEASES_REPO override
 *   • invalid source rejection
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveTarget } from "./self-update.js";

describe("self-update resolveTarget", () => {
  // Snapshot the env vars we mutate so tests stay isolated. process.env
  // assignments persist across test cases otherwise.
  const ENV_KEYS = ["CFCF_INSTALL_SOURCE", "CFCF_VERSION", "CFCF_BASE_URL", "CFCF_RELEASES_REPO"] as const;
  const original: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) original[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  describe("source resolution", () => {
    it("defaults to npm when no flags or env vars are set", () => {
      const t = resolveTarget({});
      expect(t.source).toBe("npm");
      expect(t.baseUrl).toBeUndefined();
    });

    it("--source flag wins over everything else", () => {
      process.env.CFCF_INSTALL_SOURCE = "tarball";
      process.env.CFCF_BASE_URL = "https://example.com";
      const t = resolveTarget({ source: "npm" });
      expect(t.source).toBe("npm");
    });

    it("CFCF_INSTALL_SOURCE picks the source when no flag is passed", () => {
      process.env.CFCF_INSTALL_SOURCE = "tarball";
      const t = resolveTarget({});
      expect(t.source).toBe("tarball");
    });

    it("--base-url implies tarball mode when source isn't set", () => {
      const t = resolveTarget({ baseUrl: "https://example.com" });
      expect(t.source).toBe("tarball");
      expect(t.baseUrl).toBe("https://example.com");
    });

    it("CFCF_BASE_URL implies tarball mode when source isn't set", () => {
      process.env.CFCF_BASE_URL = "https://example.com";
      const t = resolveTarget({});
      expect(t.source).toBe("tarball");
      expect(t.baseUrl).toBe("https://example.com");
    });

    it("rejects an invalid source value with a clear error", () => {
      expect(() => resolveTarget({ source: "bogus" })).toThrow(/Unknown install source: 'bogus'/);
    });
  });

  describe("version resolution", () => {
    it("defaults to 'latest' when no flag or env var is set", () => {
      const t = resolveTarget({});
      expect(t.version).toBe("latest");
    });

    it("--version flag strips a leading 'v'", () => {
      const t = resolveTarget({ version: "v0.16.1" });
      expect(t.version).toBe("0.16.1");
    });

    it("--version flag accepts a bare version (no 'v' prefix)", () => {
      const t = resolveTarget({ version: "0.16.1" });
      expect(t.version).toBe("0.16.1");
    });

    it("CFCF_VERSION env var is honoured when no flag is passed", () => {
      process.env.CFCF_VERSION = "v0.7.0-rc1";
      const t = resolveTarget({});
      expect(t.version).toBe("0.7.0-rc1");
    });

    it("--version flag wins over CFCF_VERSION env var", () => {
      process.env.CFCF_VERSION = "v9.9.9";
      const t = resolveTarget({ version: "v0.16.1" });
      expect(t.version).toBe("0.16.1");
    });

    it("preserves the literal string 'latest' (no normalisation)", () => {
      const t = resolveTarget({ version: "latest" });
      expect(t.version).toBe("latest");
    });
  });

  describe("tarball baseUrl defaulting", () => {
    it("defaults to GitHub Releases /latest/download when version is 'latest'", () => {
      const t = resolveTarget({ source: "tarball" });
      expect(t.source).toBe("tarball");
      expect(t.baseUrl).toBe("https://github.com/fstamatelopoulos/cfcf-releases/releases/latest/download");
    });

    it("defaults to GitHub Releases /download/<tag> when version is pinned", () => {
      const t = resolveTarget({ source: "tarball", version: "v0.16.1" });
      expect(t.baseUrl).toBe("https://github.com/fstamatelopoulos/cfcf-releases/releases/download/v0.16.1");
    });

    it("CFCF_RELEASES_REPO overrides the default repo path", () => {
      process.env.CFCF_RELEASES_REPO = "myorg/myfork";
      const t = resolveTarget({ source: "tarball" });
      expect(t.baseUrl).toBe("https://github.com/myorg/myfork/releases/latest/download");
    });

    it("explicit baseUrl wins over the default builder", () => {
      const t = resolveTarget({ source: "tarball", baseUrl: "file:///tmp/dist" });
      expect(t.baseUrl).toBe("file:///tmp/dist");
    });

    it("npm mode does NOT compute a baseUrl", () => {
      process.env.CFCF_RELEASES_REPO = "myorg/myfork";
      const t = resolveTarget({});
      expect(t.source).toBe("npm");
      expect(t.baseUrl).toBeUndefined();
    });
  });
});
