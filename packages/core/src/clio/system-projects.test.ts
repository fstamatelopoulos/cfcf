/**
 * Tests for the cfcf-managed Clio Project helpers.
 *
 * The system-projects module is small but load-bearing:
 *   - `isSystemProject` is the gate that prevents the user from
 *     renaming/deleting `cf-system-*` projects via the web UI / CLI.
 *   - `effectiveClioProject` is the single source of truth for the
 *     auto-routing rule that landed in item 6.9: every workspace
 *     ingests to its own `cf-workspace-<id>` project, even pre-6.9
 *     workspaces with no explicit `clioProject` stored.
 */

import { describe, it, expect } from "bun:test";
import {
  isSystemProject,
  effectiveClioProject,
  DEFAULT_PROJECT,
  GLOBAL_MEMORY_PROJECT,
  PA_MEMORY_PROJECT,
  HA_MEMORY_PROJECT,
} from "./system-projects.js";

describe("isSystemProject", () => {
  it("recognises every cf-system-* constant", () => {
    expect(isSystemProject(DEFAULT_PROJECT)).toBe(true);
    expect(isSystemProject(GLOBAL_MEMORY_PROJECT)).toBe(true);
    expect(isSystemProject(PA_MEMORY_PROJECT)).toBe(true);
    expect(isSystemProject(HA_MEMORY_PROJECT)).toBe(true);
  });

  it("does not match arbitrary cf-workspace-* names (those are per-workspace, not system)", () => {
    expect(isSystemProject("cf-workspace-tracker-723c21")).toBe(false);
    expect(isSystemProject("cf-workspace-anything")).toBe(false);
  });

  it("does not match user-named projects", () => {
    expect(isSystemProject("my-cool-project")).toBe(false);
    expect(isSystemProject("backend-services")).toBe(false);
  });

  it("is case-sensitive (matches the SQL column collation)", () => {
    expect(isSystemProject("CF-SYSTEM-DEFAULT")).toBe(false);
  });
});

describe("effectiveClioProject (item 6.9)", () => {
  it("returns the explicit clioProject when set", () => {
    const ws = { id: "tracker-723c21", clioProject: "my-named-project" };
    expect(effectiveClioProject(ws)).toBe("my-named-project");
  });

  it("falls back to cf-workspace-<id> when clioProject is undefined (pre-6.9 workspace)", () => {
    const ws = { id: "tracker-723c21" };
    expect(effectiveClioProject(ws)).toBe("cf-workspace-tracker-723c21");
  });

  it("falls back to cf-workspace-<id> when clioProject is null", () => {
    const ws = { id: "ws-abc123", clioProject: null };
    expect(effectiveClioProject(ws)).toBe("cf-workspace-ws-abc123");
  });

  it("falls back to cf-workspace-<id> when clioProject is the empty string (treats whitespace as unset)", () => {
    expect(effectiveClioProject({ id: "x-1", clioProject: "" })).toBe("cf-workspace-x-1");
    expect(effectiveClioProject({ id: "x-2", clioProject: "   " })).toBe("cf-workspace-x-2");
  });

  it("never returns cf-system-default — pre-6.9 fallthrough is gone", () => {
    // The whole point of item 6.9: per-workspace artefacts no longer
    // pollute the global default bucket.
    const ws = { id: "abc", clioProject: undefined };
    expect(effectiveClioProject(ws)).not.toBe(DEFAULT_PROJECT);
  });
});
